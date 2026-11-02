# Probe Control Panel

A self-hosted control panel for [neumann-probe.net](https://neumann-probe.net/).
It runs 24/7 in Docker, watches your whole fleet through the game's official
API, and serves a dashboard that works on PC and phone.

**Rule for this project:** the panel only uses what the game API actually offers.
The contract is [`spec/openapi.yaml`](spec/openapi.yaml) (API version 150).
TypeScript types are generated from it (`npm run gen:api`), so calling an
endpoint, parameter or field that isn't in the spec doesn't compile.

## Run it

```bash
cp .env.example .env        # then set GAME_API_KEY
docker compose up -d --build
# open http://<docker-host>:8184  (change with PANEL_PORT in .env)
```

To get an API key, call `POST /api/me/api-key` while signed in (see the spec).
The clear token is only shown once. Put it in `.env` as `GAME_API_KEY`.

All settings are listed in [`.env.example`](.env.example). The panel stores its
last known state in the `panel-data` volume, so a restart shows data straight away.

## What step 1 does (read-only)

| View | Data comes from |
| --- | --- |
| Fleet cards: status, integrity, deuterium, storage, movement | `GET /api/probes`, `GET /api/probe/{probeId}` |
| Mannies: task, progress, ETA, location, cargo, order readiness | `GET /api/probe/{probeId}/mannies` |
| Storage: containers, resources, items, external tanks | `Probe.inventory` from `GET /api/probe/{probeId}` |
| Alerts and damage warnings | `GET /api/probe/{probeId}/alerts`, `GET /api/probe/{probeId}/damage-warnings` |
| Sector objects, SCUT coverage | `GET /api/probe/{probeId}/sector` |
| Map | `GET /api/visited-sectors` + probe sector telemetry |
| Missions | `GET /api/probe/missions` |
| System: player, API version, rate limit, call log | `GET /api/me`, `GET /api/version`, `X-RateLimit-*` headers |

### Things the API imposes that the panel handles

- **Reachability.** Probe-scoped routes only work for the default probe and
  probes in its sector or shared active SCUT coverage (`ProbeSummary.isReachable`).
  Out-of-reach probes only return name, status `out_of_scut_range` and sector,
  so the panel shows them as "can't be given orders" and skips the other calls.
- **Rate limit.** One sliding window per token. The panel reads
  `X-RateLimit-Limit/Remaining/Reset`, keeps a reserve (default 30%) free for
  orders and fixes, and waits out `Retry-After` on a 429.
- **Refresh timing.** It refreshes when the API says the next Manny task is due
  (`nextUsefulRefreshDelayMs`) or when a probe is about to arrive, within the
  min/max bounds you set.

### Attention flags

Flags come from API fields, and each one shows its source on hover. The
thresholds (integrity below 50% or 25%, deuterium below 20%, storage at 95%,
task overdue by more than 10 minutes) are panel defaults, not game rules.
The 7-day storage wait countdown comes straight from the spec
(`MannyWaitingForSpaceTask`).

## Step 2: Problems page and automatic fixes

After every refresh the server checks the fleet for anything stuck and runs
the matching fix, using only real endpoints. The Problems page shows each
problem, the game's own deadline (e.g. the 7-day storage wait), what was tried,
and a **Run now / Do it** button. The auto-fix mode can be **auto**, **dry run**
(log only) or **off**.

| Problem (detected from) | Fix | Runs |
| --- | --- | --- |
| Manny can't dock, storage full (`MannyWaitingForSpaceTask`) | dock on another probe in its sector with room (`transfer-to-probe`) · move stock into a container with room (`storage-moves`) · drop cargo (`drop-manny-cargo`) | auto · auto · confirm, auto when under 24h left |
| Mining delivery blocked (`MannyMiningTask.waitingFor`) | move stock into a container with room (`storage-moves`) | auto |
| Probe hull ≥95% full (`StorageContainer.freeCapacity`) | move stock into a container with room | auto |
| Integrity low (`systems.integrityPercent`) | repair with an idle onboard Manny, limited by metals (`repair`) | auto |
| Deuterium low (`fuel`) | refuel station in sector (`refill-deuterium-tank`) · transfer from a probe in the same sector that keeps ≥50% (`transfer-deuterium-to-probe`) | auto |
| Abandoned Manny in sector (`objects[type=manny]`) | salvage (`salvage`) | auto |
| Task overdue (`taskEstimatedEndTime`) | recall, only when the Manny is local; a remote recall leaves it "forgotten" | confirm |
| Only probe lost (`Probe.alert` / status) | mind snapshot reassign (irreversible) | confirm |
| Out of command range, dead/disabled, failed move, incoming missile, damage warnings, bad API key | no API fix exists, so the panel gives advice | — |

Safety rules: a fix is never repeated while the game catches up (5 min), a
rejected fix backs off (5 min doubling to 6 h) with the game's error code in
the log, at most 5 auto fixes run per refresh, and every attempt is saved in
`/data/fixer.json`.

### Discoveries

Every visited sector is rescanned in rotation (`GET /api/sector`). The panel
alerts on **potential blueprints**: dormant constructs (inspecting one with a
Manny unlocks a probe improvement), newly learned blueprints
(`probe-improvements-available`) and `blueprint_shared` alerts. It also lists
abandoned Mannies, detached containers, drifting items, refuel stations and
SCUT relays.

## Step 3a: Automation (mining, constructs, naming)

The Automation page (modes: auto, dry run, off) runs after the fixer on every
refresh, so fixes always get first pick of idle Mannies.

- **Mining** (`POST .../mine`): idle onboard Mannies mine whichever resource is
  furthest below its per-probe stock target (metals, ice, carbon in ECE;
  deuterium as % of tank). Targets come from the current sector's asteroids and
  `minableTargets`. An order only goes out if storage still has room for
  **every** Manny outside to dock plus its pending cargo (Manny size read from
  `ProbeInventoryItem.containerSpace`). It keeps `keepIdle` Mannies free for
  fixes and respects `maxMiners`. Moving or unreachable probes are skipped.
- **Dormant constructs** (`POST .../inspect-sector-object`): inspected once each;
  the spec says this unlocks a probe improvement.
- **Naming** (off until you switch it on): probes `Role-NN` (`Station-Alpha`),
  Mannies `<probe code>-MNN` (`H03-M07`), containers named from their routing
  rules (`Core`, `Home · Mannies`, `Hand-off · Metals`, `Cargo · Ice`). A preview
  shows every planned rename. You can lock names, at most 5 renames happen per
  refresh, and "Revert all names" restores the originals (saved in
  `/data/automation.json`).

## Step 3b: Crafting queue and build suggestions (Builds page)

- **Crafting queue**, per probe: ordered lines that each mean "keep at least N of
  this item aboard". The recipe tree comes live from `GET /api/crafting-recipes`.
  Every refresh, the panel does the following:
  - It reserves what is aboard, starts every craft whose ingredients are present
    (`POST .../mannies/{mannyId}/craft`, or `POST .../atomic-printer/craft` when a
    printer is aboard, one print at a time), and works down into missing parts.
  - Missing metals, ice, carbon and deuterium are added to the mining targets.
  - Outputs only start if storage still has room for every Manny outside to
    dock, and one Manny is always kept free for fixes.
  - One-off lines leave the queue once they are reached.
  - Crafting can be paused on its own. It follows the Automation mode (auto, dry
    run or off).
- **Build suggestions** never run on their own. Each card shows why, what it uses
  up, what's missing, the risks, and the exact call. You confirm, and the panel
  re-checks against the latest refresh before sending.
  - *Assemble a probe* (`POST .../assemble-probe`): generic or deuterium tanker kit
    (from the spec), two empty additional containers, an idle Manny, and a check
    that storage still fits the Mannies outside afterwards. "Queue the missing
    parts" adds the missing pieces to the crafting queue.
  - *Install a probe improvement* (`POST .../improve-probe`): blueprints you know
    that aren't installed on that probe (`GET .../probe-improvements-available`,
    checked every 30 minutes).
- **New problem:** a Manny assembling a probe while that probe moves. That's
  critical, because the Manny can be left behind. While the move is still
  preparing, it is auto-cancelled with `DELETE /api/probe/{id}/move`.

### What each probe and Manny is doing

The probe page shows what each probe and Manny is doing, in plain words, built
from what the API returns:

- **Manny tasks:** mining target, amount, split and travel time, plus what's left
  on the asteroid; the 7-day storage-wait countdown; the parts a craft used; the
  object being inspected or salvaged; time left.
- **Probe moves:** route, phase, fuel reserved and arrival time.
- **The panel's own orders:** who ordered it (automation, auto-fix, or you), when,
  and why. Also shown is what the next refresh will do for that probe.
- **Raw task fields:** "All task data from the API" lists every field.

## Develop

```bash
npm install
npm run dev:mock                     # fake game API on :9090 (token vng_mock)
GAME_BASE_URL=http://127.0.0.1:9090 GAME_API_KEY=vng_mock npm run dev:server
npm run dev:web                      # UI on :5173, proxies to the server
npm test
```

The mock (`mock/`) is typed against the generated schema too, so it can't drift from the spec.

## Roadmap

1. Foundation and read-only live view
2. Problems page with automatic fixes, fix log, discoveries
3. 24/7 automation: 3a mining, construct inspection, naming; 3b crafting and probe-build suggestions (this); 3c exploration. Rules (mining, crafting, repair, deuterium, storage, exploration within SCUT range, inspecting dormant constructs, probe-build suggestions, automatic naming)
4. Remaining endpoints as manual controls, plus messaging, logbook and forum
