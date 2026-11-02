# Probe Control Panel: user guide

This guide walks through every page of the panel and what each button does. It's written for playing day to day.
You can also read it inside the panel: open **Guide** at the end of the top menu. For setup and the technical detail
behind each feature, see the [README](../README.md).

## Contents

1. [The basics](#the-basics)
2. [Fleet and the probe page](#fleet-and-the-probe-page)
3. [Problems](#problems)
4. [Discoveries](#discoveries)
5. [Automation](#automation)
6. [Naming](#naming)
7. [Builds](#builds)
8. [Stations](#stations)
9. [Map and exploration](#map-and-exploration)
10. [Comms](#comms)
11. [Missions](#missions)
12. [Console](#console)
13. [System, debug export and updates](#system-debug-export-and-updates)
14. [Everyday recipes](#everyday-recipes)

---

## The basics

Open `http://<your-docker-host>:8184` on your PC or phone. If you set `PANEL_PASSWORD` in `.env`, sign in with the
user name `panel` and that password.

The panel runs on the server around the clock, so automation keeps going when your browser is closed. The page is
only a window onto it.

### The top bar

Every page has the same menu along the top. The small numbers next to each name tell you where to look:

| Badge | Meaning |
| --- | --- |
| **Problems** (orange or red) | Open problems that are warnings or critical. Red means at least one is critical. |
| **Discoveries** (blue) | Discoveries you haven't marked read yet. |
| **Automation** `off` / `dry` | Automation isn't in auto mode, so nothing is being sent. |
| **Builds** (blue) | Build cards that are ready for you to confirm. |
| **Stations** (orange) | Station checks that need a look. |
| **Map** (orange) | Exploration moves waiting for your OK. |
| **Comms** (blue) | Unread probe messages (checked every 5 minutes). |

On the right is the **status pill**. It says `live` when everything is fine, `N API errors` when the last refresh had
errors, or `offline` when your browser lost the panel. It also says when the last refresh was. Tap it to open the
System page.

### Words you'll see

- **In range / out of range.** The game only lets you give orders to your default probe and to probes in its sector
  or on the same active SCUT network. Out-of-range probes show only their name, status and sector, and the panel
  can't do anything for them until they're back in range.
- **Auto / dry run / off.** The Problems page and the Automation page each have this switch. *Auto* sends orders.
  *Dry run* works everything out and logs it but sends nothing, which is handy for checking what it would do.
  *Off* does nothing unless you press a button.
- **Confirm card.** Anything risky or permanent (building a probe, a move that leaves range, fleeing, dropping
  cargo) is shown as a card with the reason, the risks and the exact game call. Nothing happens until you press
  the button and say OK.
- **Panel only.** Stations, groups, roles, stock targets and locks only exist inside the panel. Changing them sends
  nothing to the game.

---

## Fleet and the probe page

### Fleet (home page)

Across the top: number of probes, Mannies you can reach, idle Mannies, things needing attention, sectors visited
and active missions.

Below is one card per probe with its sector, integrity, deuterium, storage, what it's doing, when it arrives (if
moving) and its Mannies (how many are busy, and a mix like "3 mining · 1 crafting"). The coloured edge and flags
show problems. Hover or long-press a flag to see which game field it came from. Tap a card to open the probe.

The panel's own thresholds (integrity under 50% or 25%, deuterium under 20%, storage at 95%, a task overdue by
10 minutes) are its defaults, not game rules. The 7-day storage-wait countdown is the game's.

### The probe page

At the top you see the probe card, a **Station** box and any read errors from the last refresh.

- **Station box.** It tells you if this probe is a station or in a station's group (and its role). If it's
  neither, **Make station** turns it into one (see [Stations](#stations)).
- **What \<probe\> is doing.** A plain-language summary: the move route and arrival, the Manny task mix, and
  **Panel's next refresh**, which lists what the panel plans to do with this probe next and why.

There are four tabs:

- **mannies.** A table of every Manny. Filter by *all*, *attention*, *idle* or *busy*. For each one you see what it's
  doing in words (mining target and amount, crafting parts, storage-wait countdown, and so on), progress, where it
  is, whether it can take orders, and flags. If the panel gave it an order, it says who (automation, auto-fix or
  you), when and why. Open **All task data from the API** to see every raw field.
- **storage.** Containers with fill bars, external tanks, resources and items.
- **alerts.** Alerts and damage warnings. Use **Mark read**, **Mark all alerts read** or **Delete** (delete asks first
  and can't be undone).
- **sector.** What the probe sees: coordinates, knowledge level, SCUT coverage and every object in the sector.

---

## Problems

This is where anything stuck shows up. After every refresh the panel checks for stuck Mannies and probes, and fixes
what it safely can.

**Auto-fix switch** (top right): *auto*, *dry run* or *off*. Fixes marked "needs you" always wait for you whatever
the mode.

**Open tab.** Critical, warning and info counts, then one card per problem with:

- what's wrong and which probe (tap the probe tag to jump to it),
- **game acts in …**, the game's own deadline, such as the 7-day storage wait (turns red under 24 hours),
- each possible fix, tagged **auto** or **needs you**, with why and the exact call. It also shows when it was last
  tried and when it will try again,
- **Run now** (auto fixes) or **Do it** (needs-you fixes). Both ask before sending,
- advice when the game has no fix for it (out of range, dead probe, incoming missile, and so on).

Examples of what it fixes by itself: a Manny that can't dock because storage is full (docks it on another probe in the
sector, or shuffles stock to make room), a full hull, low integrity (repairs), low deuterium (refuel station or a
nearby probe), and abandoned Mannies in the sector (salvage). Dropping cargo is a "needs you" fix until less than 24
hours are left on the game's deadline, and then it runs on its own so the Manny isn't lost.

After a fix is sent, the card says it's waiting for the game to catch up. A fix the game rejects backs off (5 minutes,
doubling up to 6 hours) and shows the game's error.

**Fix log tab.** Every fix tried, by auto or by you, with the result.

---

## Discoveries

The panel rescans every sector you've visited, a few each refresh, and lists what's worth knowing.

- **blueprints** (default filter): dormant constructs (inspecting one with a Manny unlocks a probe improvement),
  newly learned blueprints, and blueprints shared with you.
- **unread** / **all**: also abandoned Mannies, detached containers, drifting items, refuel stations and SCUT relays.

Each card shows the sector (tap it to open the Map), when it was first and last seen, and "no longer seen" if it's
gone. Use **Mark read** on one card or **Mark all read** at the top. Open **Sector scan status** at the bottom to see
when each sector was last scanned and any scan errors.

Dormant constructs get inspected automatically if *Inspect dormant constructs* is on (Automation page).

---

## Automation

The **Automation** switch at the top right (*auto*, *dry run*, *off*) controls mining, construct inspection,
crafting, exploration, station work and naming. Fixes from the Problems page always get first pick of idle Mannies.

### rules tab

- **Next refresh will do.** The exact list of orders the next refresh will send, each with why. If it's empty, it
  tells you why (targets met, no spare Mannies, or no room for them to come back).
- **Inspect dormant constructs.** Tick to have a Manny inspect each dormant construct once.
- **One card per probe:**
  - *Keep Mannies mining*: idle Mannies mine whatever is furthest below its target.
  - *Max Mannies mining*, *Keep idle for fixes*, *ECE per order*.
  - *Stock targets*: metals, ice and carbon (ECE), and deuterium (% of tank).
  - *Exploration*: tick *Explore unvisited neighbour sectors*, then set how long it stays in each sector, the fuel
    floor after a jump and the minimum integrity to leave. Explore is off for every probe until you turn it on.

Type a number and tap elsewhere to save it.

Mining only goes out if storage still has room for every Manny outside to come home with its cargo, so Mannies
don't get stuck waiting for space. Probes that are moving or out of range are skipped. Stations and their group
probes are run by the Stations page instead.

### log tab

Everything the automation sent (or would have sent in dry run), with the result.

---

## Naming

This is on the **naming** tab of the Automation page. It's off until you tick **Automatic naming**. Check the preview
table first.

- **Probes:** `Role-NN`, for example `Hauler-03`. Stations are named like `Station-Alpha`.
- **Mannies:** the probe's code plus a number, such as `H03-M07`.
- **Containers:** named from how they're used: `Core`, `Home · Mannies`, `Hand-off · Metals`, `Cargo · Ice`.

**Probe roles** sets each probe's role (Probe, Hauler, Tanker, Scout, Miner), which drives its name. Station probes and
group probes show "set on Stations" instead, because their role comes from the Stations page.

The table shows each thing's current name and what it **will be**. Tick **Lock** to keep a name as it is forever.
"waits: out of range" means it'll be renamed once it's reachable. At most 5 renames happen per refresh.

**Revert all names** renames everything back to the original names (they're saved) and switches naming off.

---

## Builds

The **Crafting** switch at the top right is *on* or *paused*, separate from Automation. Crafts are only sent while
Automation is in auto mode, and the page warns you if it isn't.

**Assembling now** appears while a Manny is assembling a probe. The panel won't move that probe until it's done,
because moving would leave the Manny behind.

### Suggestions tab

Build cards. **They never run on their own.**

- **Assemble a probe** (generic or deuterium tanker kit) and **Install a probe improvement** (blueprints you know that
  this probe doesn't have yet).
- Each card shows **Why**, **What it uses** (green = have it, orange = short), anything blocking it, and
  **Risks and what the panel does about them**, with the exact call and how long it takes.
- **Confirm: assemble / install** appears when it's ready. The panel re-checks against the latest refresh before
  sending.
- **Queue the missing parts** adds the missing crafted parts to the crafting queue.

Cards that aren't ready yet sit under **Not ready yet**, so you can see what's still missing.

### Crafting queue tab

Pick a probe along the top. Each line means "keep at least N of this item aboard".

- **Add a goal**: choose an item and a quantity, then press **Add**. *one-off* is ticked by default, so the line
  leaves the queue once it's reached. Untick it to keep the stock topped up for good.
- Use **↑ / ↓** to change priority (higher lines get parts and Mannies first) and **✕** to remove a line.
- Each line shows what it's waiting on: ordering, crafting, needs parts, needs resources, waiting for a Manny,
  printer busy, no room.

The panel crafts missing parts first, adds missing metals, ice, carbon and deuterium to the mining targets, uses the
atomic printer when the probe has one, and always keeps one Manny free for fixes.

### Recipes tab

The live recipe list from the game: what each makes, who makes it, what it needs, time and space.

---

## Stations

A station is a probe the panel keeps in one place as a production hub, with its own group of probes. The game has no
stations, so this is all panel-side. **A station never moves on its own.**

### Making a station

Use **Make a probe a station** at the top of the Stations page, or **Make station** on a probe page. Its role becomes
Station (it gets renamed if naming is on). Exploration will never move it. **Remove station** at the bottom of a card
undoes it, and its group probes go back to normal automation. Neither sends anything to the game.

### The station card

- **Header:** status, *default probe* tag, sector and SCUT networks, and the **Production** mode:
  - **Parts**: crafts items toward the station's item targets.
  - **Manny factory**: keeps building Mannies for the station and for group probes that are short.
  - **Probe yard**: gathers a full assembly kit (pick generic probe or deuterium tanker) and keeps 2 empty
    containers. The build itself is still a confirm card on the Builds page.

  The production line shows each item as have/target and what it's waiting on. Your own crafting queue wins if it
  has the same item.
- **Flee card** (red, only when in danger): see [Danger and fleeing](#danger-and-fleeing).
- **Checks:** a green tick or orange "!" for being in range, default probe, SCUT network, moving, fuel floor, and
  group probes out of range or with no role.
- **Make default probe:** makes this station your default probe (asks first). Orders then reach probes near the
  station instead. The game refuses unless both are in the same sector or on the same SCUT network.
- **Stock against targets:** a bar for each target (resources, items, fuel, Mannies), with how much is short.
- **Edit settings** opens:
  - add a resource or item target, or remove one,
  - *Station fuel floor* (kept for one flee jump),
  - *Offer a flee card below this integrity*,
  - *Mannies kept at the station*, and a Manny target for each role,
  - trip settings: *Longest stay at a mining sector*, *Fuel left after a round trip*,
  - hand-off settings: *Hand over containers at least this full*, *Containers per Hauler (max 4)*,
  - refuelling settings: *Top up docked probes to*, *Tanker keeps at least*, and *Station Tanker keeps for a
    collecting trip*.

  Press **Save settings**.

### The group and its roles

Under **Group**, each probe has a role picker and **Remove**. Use **Add to group** to add a probe that isn't in a
group yet. A probe belongs to one station at most. A role can only change while the probe is in range. A probe that
turns up in the station's sector (for example one just built there) joins with no role until you pick one.

| Role | What it does |
| --- | --- |
| **Hauler** | Fetches what the station is short of. It flies to the nearest known sector with that resource on the SCUT network, mines into its hand-off containers, flies home and hands the full containers over. It gets empties back. Its core is always the Mannies' home, so a Manny never ends up in a container that's being handed over. |
| **Tanker** | Tops up the station's deuterium while docked and keeps 30% (editable) for itself. If a Hauler on a trip runs out of fuel to get home, a free docked Tanker flies out and refuels it. |
| **Station Tanker** | Deuterium only, for this station. If the station's sector has deuterium, it never leaves: it mines until full and gives the station everything. If it doesn't, it gives what it can above a reserve (20% or the round trip, whichever is more), then flies to the nearest known deuterium sector on the network, fills up, comes home and gives again. |
| **Scout** | A marker role. The panel doesn't give Scouts trips or station work; you move them yourself (Console or Map) to find new sectors and extend SCUT coverage, which gives Haulers more places they can reach. |

Each group probe also shows its fuel, extra containers and Mannies against the role's Manny target. While a group
probe is docked, idle Mannies move between it and the station until each meets its target.

### Trips

The **on/off** switch controls Hauler trips. The notes underneath explain why a trip is or isn't going out (for
example "no known sector with metals inside the SCUT network"). Each trip shows its state: flying out, mining,
flying home, handing over, done or failed, and why.

Trips only go to sectors on a SCUT network your default probe is on, so the Hauler can always be ordered home. Before
leaving, the Hauler needs at least 40% integrity, half-empty hand-off containers, every Manny aboard, and fuel for the
round trip plus your margin (80% fuel while the trip cost isn't known yet). Sectors with a black hole or missile are
skipped. A trip heads home when the containers are full enough, the resource runs out, or the longest stay is up. It
fails if the move never starts, the move fails, or it's out of range for 30 minutes.

### Docked service

The **on/off** switch controls what happens while a group probe sits in the station's sector:

- Full hand-off containers go to the station, and empties go back (never more than 4 on a Hauler).
- Docked probes are refuelled up to your target, as long as the station stays above its fuel floor.
- Tankers and Station Tankers top the station up.

**Next:** shows the next thing it will do, and recent hand-offs are listed with their state. A hand-off that never
arrives is flagged after 2 hours.

### Danger and fleeing

The station shows a red **Danger: flee?** card when a weapon has targeted it in the last 24 hours, a missile in the
sector targets it, integrity drops below your flee floor, or there are unresolved damage warnings.

Pick one of up to 4 safe neighbouring sectors and press **Flee here**. The confirm box lists the risks first (5+ extra
containers, Mannies working in other sectors, being the default probe, fuel). After you confirm, Mannies outside in
this sector are recalled. The move goes out once they're all aboard. Use **Cancel flee** until the move has been sent.
An unstarted flee expires after 6 hours. Haulers already out come home to the new sector.

### Station log

The station log is at the bottom of the page. It lists every station action with the game call, or "panel only".

---

## Map and exploration

The **map** is a top-down view of every sector you've visited. Squares are visited sectors, dots are probes (hollow
means out of range), dashed lines are moves in progress, an outlined square marked **S** is a station, and the ring is
your home sector (0, 0, 0). Use the **z** buttons to look at one layer at a time, or *all z* to see them stacked. Tap
a square to see its visit history and the probes in it.

The **Exploration** box under the map shows each exploring probe and what it's doing (working sector, calling
Mannies home, moving, waiting, needs you). Open **Neighbours considered** to see how it scored each neighbour.

How an explorer works:

1. It works each sector for the dwell time and inspects any dormant constructs first.
2. It scans the 12 neighbours and picks the best unvisited one (stars, planets and SCUT coverage help; black holes and
   danger count against).
3. It only goes if fuel after the jump stays above your floor.
4. A move that stays in range runs by itself. A move that would leave range, or into a sector the scan flags as
   dangerous, appears here as a **confirm card**. After you confirm, it waits for every Manny to be aboard and then
   moves. The OK lasts 24 hours.
5. It never leaves a Manny behind. If one is stuck elsewhere, it points you to the Problems page.

Turn exploring on per probe on the Automation page. Stations and their group probes never explore.

---

## Comms

Comms has three tabs. Pick the probe along the top. Out-of-range probes are greyed out.

- **Messages.** **Received** shows messages to this probe (**Mark read** on each). **Sent (default probe)** shows what
  you've sent; the game only lists these for your default probe. To send, choose *Probe* (any player's probe id) or
  *Planet*, type up to 2000 characters and press **Send**. The probe must share a sector or SCUT network with the
  target, and planets must be inhabited and in the same sector.
- **Logbook.** This probe's logbook pages. Use **New page**, open a page to edit it, then **Save**, **Close** or
  **Delete** (delete asks first).
- **Forum.** Browse categories and posts, open a post to read and **Reply**, or write a **New post**.

---

## Missions

This page lists your missions with their status and steps, in order, showing which are done. It's read-only. You
can abandon a mission from the Console.

---

## Console

The Console lists every call in the game's API, so anything the other pages don't cover can still be done here.

1. Search or browse the list on the left. Calls tagged **confirm** can lose things (delete, jettison, missiles,
   asteroid launch, drop or detach containers, assemble, move, transfer, recall, drop cargo, mind-snapshot
   reassign, abandon mission, forum moderation).
2. Pick one. The form is built from the game's own spec, with pickers for probes, Mannies, sector objects,
   containers and items. Tick *edit as JSON* to type the body yourself, or press **Use the spec's example**.
3. Send it. The server checks required fields and types before anything goes out, and risky calls show the game's own
   description and ask you to confirm.

A Manny you order from the Console is left alone by the automation for 2 minutes. Logging in and creating API keys are
switched off here.

---

## System, debug export and updates

**Game connection** shows the player, API version, **panel version** (the commit it's running, and when it started),
the last and next refresh, and the number of refreshes.

- **Refresh now** refreshes straight away.
- **Download debug export** saves one JSON file with what the panel saw and did: recent API calls and errors,
  problems and fixes, automation, stations, discoveries and the console log. The API key and password are removed.
  **Send this file whenever something looks wrong**, as it's the quickest way to get a problem fixed.

**Rate limit** shows how many calls are left in the window, whether the game is blocking (429), and what's queued.
The panel keeps 30% of the window free so orders and fixes always get through.

**Errors on last poll** and the **API calls** table (tick *errors only* to filter) show exactly what was sent to
the game and what came back.

A red banner on every page saying **Settings are not being saved** means the panel can't write its data folder.
Roles, stations, queues and names would be lost on restart, so update the panel.

### Automatic updates

Once the cron job from the README is set up, the server checks for a new version every 5 minutes and rebuilds only
when there is one. If the new version fails its checks, the running panel stays as it is. You can see which version
is running under *Panel version* on this page, and the history is in `auto-update.log` on the server. Your `.env`
and saved data are never touched.

---

## Everyday recipes

**First run.** Set Automation to *dry run*, open the Automation page's "Next refresh will do" list and check it makes
sense, then switch to *auto*. Do the same with naming: look at the preview, lock anything you want to keep, then tick
*Automatic naming*.

**Something's stuck.** Open Problems. If a card says "needs you", read it and press **Do it**. If there's no fix (out
of range, dead probe), follow the advice. If it still looks wrong, download the debug export from System and send it.

**Set up a mining station.**

1. Make the probe a station.
2. In **Edit settings**, add resource targets (for example metals 5 ECE).
3. Add probes to its group as **Hauler**, plus a **Tanker** or **Station Tanker** for fuel.
4. Leave Trips and Docked service on.

The station card's Trips notes tell you if anything is blocking. The usual blocker is no SCUT network, and a Scout
can fix that.

**Build a new probe.** Set a station to **Probe yard** (or add the parts to a crafting queue). When the Builds page
shows a **ready** assemble card, read the risks and press **Confirm: assemble**.

**Explore.** Turn on *Explore* for a probe on the Automation page and set its fuel floor. Watch the Map badge for
moves that need your OK.

**Danger at a station.** Read the red flee card, pick a destination and press **Flee here**, or **Cancel flee** if
the threat passes before the move is sent.
