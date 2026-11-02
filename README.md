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

### Automatic updates

`scripts/auto-update.sh` keeps the server on the latest `main`. It checks every few minutes and rebuilds only when
`main` changed. The image build runs the type check and the full test suite, so if either fails the running panel is
left as it is and that commit is skipped. `.env` and the `panel-data` volume are never touched. One-time setup on the
Docker host (Linux), from the repo folder:

```bash
chmod +x scripts/auto-update.sh
(crontab -l 2>/dev/null; echo "*/5 * * * * $PWD/scripts/auto-update.sh >> $PWD/auto-update.log 2>&1") | crontab -
```

The user running cron needs `git pull` access to the repo and permission to run `docker compose`. The System page
shows the running version (commit) and when it started; `auto-update.log` shows each update.

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

## Step 3c: Exploration (Map page)

Turn on **Explore** per probe on the Automation page. You can also set how long
it stays in each sector, its fuel floor and its minimum integrity. An explorer
then works like this:

1. It works its sector for the dwell time. Dormant constructs are inspected
   before it leaves.
2. It scans the 12 neighbouring sectors of the FCC grid with
   `GET /api/sector?x&y&z`, every 30 minutes. It picks the best unvisited,
   unclaimed one: a star, planets and SCUT coverage count in its favour; black
   holes, danger and navigational risk count against it.
3. It only goes if fuel after the jump stays above your floor. The cost is
   learned from `Probe.movement.fuelCostDeuterium` on earlier moves.
4. Whether it waits for you depends on command range (`ProbeSummary.isReachable`):
   - **Stays in range** (SCUT network shared with the default probe, or joining
     its sector), and the scan isn't flagged as dangerous: the move runs by
     itself with `POST /api/probe/{id}/move`.
   - **Would leave range**, or the scan flags danger: a confirm card appears on
     the Map page and the probe keeps working meanwhile. After you confirm, it
     stops new outside work, waits for every Manny to be aboard, then moves. The
     OK lasts 24 hours.
5. It never leaves a Manny behind. While any Manny is outside, it waits. If a
   Manny is in another sector or waiting for storage, it says so and points to
   the Problems page instead of leaving.

## Step 4: Console, Comms and alert controls

- **Console:** every call in the game API spec is listed, grouped and
  searchable. Each form is built from the spec's own parameters and
  request-body schema. Probes, Mannies, sector objects, containers and items
  are offered as pickers.
  - The server checks required fields, enums, types and lengths against the spec
    before anything is sent.
  - Calls that can lose things ask for confirmation: deletes, jettison, missiles,
    asteroid launches, dropping or detaching containers, assembly, moves,
    transfers, recalls, dropping cargo, mind-snapshot reassignment, abandoning
    missions, and forum moderation.
  - Logging in and creating API keys are switched off.
  - A Manny you give an order to is left alone by the automation for 2 minutes.
  - The catalog is regenerated from `spec/openapi.yaml` by `npm run gen:api`.
- **Comms:**
  - Probe messages: received messages per probe, mark read, send to a probe or
    planet, and the sent list for the default probe.
  - Probe logbook pages: list, read, write, edit, delete.
  - The forum: categories, posts, replies, new posts.
  - Unread messages are checked every 5 minutes and shown as a nav badge.
- **Alerts tab** on each probe: mark read, mark all read, delete alerts and damage warnings.

## Step 5a: Stations (designation, groups, stock against targets)

A station is a probe the panel keeps in place as a production hub, with its own group of probes. The game has no
stations, so this is panel-only data (`data/stations.json`). It only changes which calls the panel makes.

- **Make a probe a station** on the Stations page or on the probe page. Its role becomes Station (naming follows),
  and exploration never moves it, even with Explore switched on.
- **Group and roles.** Each group probe gets a role: Hauler, Tanker or Scout. A probe belongs to one station at most.
  A role only changes while the probe is in reach. A probe that appears in a station's sector (for example one
  just assembled there) joins that group with no role until you pick one.
- **Make default probe** calls `PATCH /api/probe/{id}` with `isDefault: true`, behind a confirm dialog. The game refuses
  (422) unless the station and the current default probe share a sector or an active SCUT network.
- **Stock against targets:** resource floors (ECE), item floors (count), the station's fuel floor and its Manny count,
  read from the station's inventory. Each station also has a Manny target per role.
- **Checks** on each card: in reach, default probe, SCUT network, moving, fuel floor, group probes out of reach or
  without a role.

## Step 5b: Docked service (container hand-offs and refuelling)

When a group probe and its station are in the same sector and neither is moving (the spec's rule for every
probe-to-probe exchange), the station services it. Each step can be switched off per station and follows the
automation mode (auto, dry run, off).

- **Hauler container rules, at all times:** additional containers become hand-off containers (cargo first,
  `strictExclusion: [manny]`), and the probe core becomes the Mannies' home (`priority: [manny]`), via
  `PATCH .../storage-containers/{id}/rules`. A Manny never ends up in a container that is about to be handed over.
- **Full containers to the station:** a Hauler's hand-off container that is at least 80% full is detached with
  `mode: attach_to_probe` to the station. It is skipped if a Manny is inside, or if removing it would leave no
  room for Mannies still outside. A `409 storage_container_reserved` triggers
  `crafting-reservations/reassign`, then one retry.
- **Empties back:** the station gives empty containers to the Hauler, up to 2 each (never more than 4, the movement
  link risk), but only if the station keeps room for its own Mannies outside.
- **Arrival:** the spec doesn't say whether an attached container lands in the receiver's storage or stays in the
  sector. The panel watches both: if a new detached container appears in the sector, the receiver recovers it
  (`recover-storage-container`). Hand-offs that never arrive are flagged on the station card after 2 hours.
- **Refuelling:** `transfer-deuterium-to-probe` tops docked probes up to 90%, while the station stays above its fuel
  floor. A docked Tanker tops the station up and keeps 30% for itself. Amounts stay strictly below the source's tank,
  as the spec requires.
- No Idempotency-Key is sent: the spec doesn't list one for these endpoints. A detach can't be doubled anyway,
  because the container leaves the sender's inventory as soon as the order is accepted.

## Step 5c: Dispatch and hauler trips

Each poll, the panel compares every station's raw resource targets (metals, ice, carbon compounds) with its stock.
When one is short, an idle docked Hauler goes to fetch it. Each card on the Stations page explains why a trip is
or isn't going out.

- **Where:** the nearest sector that the visited-sector scans (`GET /api/sector`) show holding that resource. It must
  be covered by a SCUT network the default probe is on, so the Hauler stays in command range the whole time. Sectors
  with a black hole or missile are skipped. Moves inside range run on their own, as agreed.
- **Checks before leaving:** at least 40% integrity; hand-off containers at least half empty; no hand-off or refuel
  in progress; every Manny aboard and idle. Fuel must cover the round trip (from the move cost learned on earlier
  moves) and still leave 20% of the tank. While the cost isn't known yet, the trip waits for 80% fuel.
- **At the mining sector:** the trip sends idle Mannies to mine that resource (`POST .../mine`). It keeps one Manny
  idle, and only sends what fits in the hand-off containers, keeping room for every Manny to come home. The regular
  mining automation leaves the Hauler alone during the trip.
- **Heading home:** once the hand-off containers reach the hand-over threshold, nothing there holds the resource any
  more, or it has spent 6 hours there. It waits until every Manny is aboard, then flies home. Docked service hands the
  containers over, and the trip ends.
- **Problems:** a move that never starts, a failed movement, or 30 minutes out of command range mark the trip
  failed. The station card shows this.
- Exploration and the regular mining leave stations and their groups alone. The map marks stations with an
  outlined S.
- Each station can switch trips off. The longest stay and the fuel margin are editable.

## Step 5d: Production modes

Each station's production mode becomes ordinary crafting goals ("keep at least N aboard"). The step 3b crafting
planner works through them with `craft` and `atomic-printer/craft`, ingredients first. If your own crafting queue
already has an item, your goal is used instead of the station's.

- **Parts** (default): the station's item stock targets.
- **Manny factory:** the `manny` recipe, enough for the station's Manny target plus whatever its group probes are short of.
- **Probe yard:** the assembly kit for a generic probe or a deuterium tanker (pick one). The station also keeps 2 empty
  containers instead of giving them to Haulers. The build itself stays a confirm card on the Builds page.
- **Manny split (always on):** while a group probe is docked, idle Mannies move between it and the station
  (`transfer-to-probe`) to meet each role's Manny target. They only move if the receiver has room, and only one move
  runs per pair at a time.
- The spec's `MannyCraftRequest` only takes `recipe`, so the panel doesn't rely on one Manny crafting a whole chain
  ("whole build"). It crafts parts first instead.

## Step 5e: Flee cards and stuck fixes

A station never moves on its own. When it is in danger, its card on the Stations page shows a red flee card.

- **Triggers (spec only):** an unresolved alert with phase `weapon_targeted` from the last 24 hours, a missile in the
  sector with `targetsCurrentProbe`, integrity below the station's flee floor (default 50%, editable), or unresolved
  damage warnings.
- **Options:** up to 4 neighbouring sectors. Sectors with a known hazard are left out. Sectors on the station's SCUT
  network, and sectors visited before, come first.
- **Risks shown before you confirm:** 5 or more additional containers (break-off chance), Mannies working in another
  sector (a remote recall would strand them, so they are left), Mannies outside in this sector (recalled first),
  being the default probe, and fuel for the jump.
- **After you confirm:** local Mannies are recalled (`POST .../mannies/{id}/recall`), then `POST /api/probe/{id}/move`
  goes out once all of them are aboard. While fleeing, the station starts no new trips, hand-offs or refuels.
  Haulers already out come home to the new sector. You can cancel until the move is sent; an unstarted flee expires
  after 6 hours.
- **Stranded Hauler:** if a Hauler on a trip lacks the fuel to fly home, a free docked Tanker of the same station flies
  out and sends fuel with `transfer-deuterium-to-probe`, keeping its own reserve. It only goes when the move cost is
  known.
- **Stragglers:** an idle Hauler or Tanker left away from the station flies home once its Mannies are aboard and it has
  the fuel.

## Station Tanker role

A group role for a tanker whose only job is deuterium for its station (Merchant, 2026-11-02). The regular mining
automation leaves it alone, and the station never fuels it.

- **Deuterium in the station's sector:** it never leaves. Its Mannies mine deuterium (`mine` with
  `resources: [deuterium]`) until its tank is full, and it gives the station everything it has with
  `transfer-deuterium-to-probe` (1 point stays, because the amount must be below its own deuterium).
- **No deuterium in the station's sector:** it gives the station everything above a reserve: 20% of its tank
  (editable), or the round trip to the nearest deuterium if that costs more. Once it has nothing left to give and the
  station isn't full, it flies to the nearest known deuterium sector on the SCUT network (hazards skipped), mines until
  its tank is full, waits for every Manny, flies home and starts giving again.
- If it ends up away from the station without a trip, it flies home once its Mannies are aboard.

## Debug export

The System page has **Download debug export**: one JSON file (`GET /panel-api/diagnostics`) with the latest poll,
recent API calls and errors, problems and fixes, automation, stations, discoveries and the console log. The API key,
the panel password and anything shaped like a key or token are removed before it is sent. Send it when something
looks wrong on the live game.

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
3. 24/7 automation: 3a mining, construct inspection, naming; 3b crafting and probe-build suggestions; 3c exploration. Rules (mining, crafting, repair, deuterium, storage, exploration within SCUT range, inspecting dormant constructs, probe-build suggestions, automatic naming)
4. Remaining endpoints as manual controls, plus messaging, logbook and forum
5. Stations (from the Stations design): 5a designation, groups and stock targets; 5b container hand-offs and
   refuelling while docked; 5c dispatch loop and hauler trips; 5d production modes; 5e flee cards and stuck fixes (this)
