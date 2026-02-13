# MineFarmBot

Mineflayer-based Minecraft Java bot that builds chunk-aligned cactus farm layers with strict survival safety rules.

## Features

- Builds square cactus cells per layer (default **16×16**, configurable via `farmSize`).
- Uses **3-block vertical spacing** between layers.
- Configurable layer count (`layers`, default 18).
- Build sequence per cell:
  1. Ensure cobblestone scaffold exists.
  2. Move onto scaffold.
  3. Place sand.
  4. Place cactus.
  5. Place string against the cactus collision edge on the open side.
  6. Optionally remove scaffold.
- Uses an external vertical cobblestone spine (`origin.x - 2, origin.z`) to transition upward by 3 blocks between layers.
- Safety constraints:
  - Never intentionally stands on sand.
  - Requires solid support beneath bot.
  - Stops if fall > 1 block is detected.
  - Stops and logs out on inventory shortages.
  - Slows placement rate when lag is detected.
- Adds tiny random head movement during work to appear less robotic.
- Supports opportunistic refill from nearby chest/trapped chest/barrel when materials run low.
- Recovery features:
  - On fall detection during active build, requests recovery to last checkpoint instead of immediate fatal stop.
  - On pathing failure for a cell, retries once using an alternate scaffold approach.
- Post-placement build verification checks each completed cell and retries once on mismatch.
- Crash-safe persistence: checkpoints are atomically written after each cell so resumes are precise after restarts/crashes.

## Quality

Project quality controls and gates are documented in `QUALITY.md` (ISO/IEC 5055-aligned practical checklist).

`npm run check` validates JavaScript syntax across project source files and checks for duplicate function declarations in `bot.js`.

## Project structure

- `bot.js` — bot engine + lifecycle/reconnect orchestration + CLI command bridge
- `buildController.js` — runtime build state machine (`start/pause/resume/stop`) and progress reporting
- `config.js` — config defaults + validation
- `checkpoint.js` — checkpoint persistence manager
- `inventory.js` — item counts/equip/inventory requirements
- `refillManager.js` — opportunistic nearby-container refill logic
- `humanizer.js` — subtle random head movement behavior
- `QUALITY.md` — quality controls and gates

## Setup

### Desktop app (EXE)

For end users, MineFarmBot can run as a desktop application shell that starts the bot engine and opens the operator GUI automatically.

- Development desktop run: `npm run start:desktop`
- Build Windows portable EXE: `npm run dist:win`

The desktop app wraps the same bot engine and GUI transport, so behavior remains consistent with CLI mode.

Desktop runtime features:
- single-instance lock (second launch focuses existing window)
- app icon (`desktop/assets/icon.svg`)
- remembers last window size/position
- minimize-to-tray behavior
- in-app "Restart Bot" button (desktop mode only)
- Desktop Launcher for creating/selecting multiple bot profiles

Desktop Launcher workflow:
1. Run `npm run start:desktop`.
2. Create one or more bot profiles (name, auth mode, identity, server).
3. Launch profile from launcher list.
4. Microsoft auth prompts are surfaced in app and browser opens automatically when code is issued.
5. Each profile has isolated `config.json` and `build-checkpoint.json` under desktop user-data profiles.

### Desktop troubleshooting: diagnostics export

Use **Export Active Diagnostics** (or a profile card's **Export Diagnostics**) in the desktop launcher to write a diagnostics bundle for support/debugging.

The export writes:
- A `.json` diagnostics file with app/runtime metadata (app version, platform, Node/Electron versions).
- Selected profile metadata (sanitized), profile config/checkpoint/meta paths, and file existence checks.
- Recent bot log lines plus recent UI/server events.
- Last known status summary (connection/auth/build/safety/lifecycle where available).
- A companion `.zip` file containing the JSON when the host has a `zip` utility available.

Redaction behavior in exported logs/events:
- Microsoft device sign-in codes are replaced with `[REDACTED_DEVICE_CODE]`.
- Token-like hex/JWT strings are masked (`[REDACTED_HEX_TOKEN]`, `[REDACTED_JWT]`).
- Common secret assignments (`access_token`, `refresh_token`, `password`, `secret`, `device_code`) are replaced with `[REDACTED]`.
- Profile username in metadata is reduced to a short hint (`ab***`) instead of the full value.
- If desktop startup fails with `SyntaxError: missing ) after argument list` in `desktop/main.js`, ensure you are on the latest repository revision/branch (older downloaded snapshots may contain stale launcher parser code).

Forward compatibility for desktop profiles:
- Launcher-managed `profile.json` metadata and per-profile `config.json` include a `schemaVersion` field.
- On read/launch, desktop migration helpers normalize older payload keys (legacy host/auth/identity aliases), backfill required defaults for newly-added launcher fields, and atomically rewrite migrated files.
- Missing `schemaVersion` is treated as v1 and upgraded in-place before profile listing/launch continues.


1. Install Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Start:

```bash
npm start
```

## GUI operations (primary)

The bot now exposes a lightweight GUI transport (HTTP + SSE) for a browser-based UI. Start the bot with `npm start`, then open the GUI URL shown in the startup logs (look for the `[GUI] Listening` line) in a browser on the same machine. Use the GUI for all routine operations and monitoring; the CLI remains available as a secondary/debug path only.

**GUI transport endpoints**

- `GET /` — Operator Control Panel dashboard (single-page UI).
- `GET /status` — JSON snapshot of current state.
- `GET /events` — Server-Sent Events (SSE) stream (`status`, `log`, `warning`, `error`).
- `POST /control` — operator command bridge (`start`, `pause`, `resume`, `stop`).
- `GET /config` — load effective config for Setup Wizard (includes required fields list).
- `POST /config` — persist validated config updates from Setup Wizard (writes `config.json` and keeps a `config.json.bak` backup).

### Operator controls

Setup Wizard validates required fields before run and prevents Start while mandatory configuration is missing.

Auth Type selector behavior:
- `microsoft` → shows **Microsoft Email** (stored internally as `config.username`).
- `offline` → shows **Offline Username** (stored internally as `config.username`).
- Password is intentionally removed from Setup Wizard for simpler onboarding.


- **Start**: begins the build from the configured `origin` and initializes progress tracking.
- **Pause**: halts work at the next safe checkpoint without logging out.
- **Resume**: continues from the last checkpoint after a pause.
- **Safe Stop**: requests a stop at the next safe checkpoint, saves progress, and exits cleanly.

### Telemetry panels

The GUI surfaces live operational telemetry so operators can monitor the bot without relying on terminal logs:

- **Build Progress**: current layer, cells placed, estimated remaining work, and last placement time.
- **Safety/Health**: stop reasons, lag mode status, and safety checks.
- **Inventory & Refill**: item counts, low-material warnings, and refill events.
- **Connection**: login state, reconnect attempts, and active server details.
- **Event Log**: recent warnings/errors with timestamps.

## Non-technical quick start

1. Install Node.js (LTS) on Windows.
2. Put this folder somewhere easy (for example `C:\MineFarmBot`).
3. Open Command Prompt in the folder.
4. Run `npm install` once.
5. Start with `npm start`.
6. Open the GUI URL shown in startup logs.
7. Open **Setup Wizard** and fill required fields: server `host`, `port`, `username`, farm `farmSize`, and placement mode (`manual` or `easy_center`).
8. Save config from the GUI; restart process if you changed connection-level fields.
9. Use GUI controls (Start/Pause/Resume/Safe Stop).
10. Use CLI commands only if GUI is unavailable (debug/backup): `start`, `pause`, `resume`, `stop`, `status`.


The bot prints clear stop messages if it detects unsafe movement, missing inventory, or disconnection.

On spawn, the bot waits for login/lobby load, retries `/survival` if needed, waits for teleport movement, and then idles until a `start` command is issued.

If disconnected/kicked/error occurs unexpectedly, the bot auto-reconnects with backoff and resumes from checkpoint.

If materials run low, place a chest/trapped chest/barrel near the bot; it will opportunistically pull items and continue.

Progress checkpoints are written every 16 placements to `build-checkpoint.json` so a restart can resume from the last saved row.

## Config

`config.json` fields:

- `host`, `port`, `username`, `auth`, `version` (`auth` default is `microsoft`)
- `layers` (number of layers, recommended 15–20)
- `buildDelayTicks` (base delay between placements)
- `removeScaffold` (`true`/`false`, default `false` for safer high-layer runs)
- `farmSize` square side length (`NxN` footprint, default `16`)
- `buildPlacementMode`: `manual` (use configured coordinates) or `easy_center` (derive center/origin after `/survival` transfer)
- `origin` (`x,y,z`) base corner for the square footprint (required in `manual` mode)
- `safePlatform` (`x,y,z`) post-build / emergency retreat location (required in `manual` mode; auto-centered in `easy_center`)
- `facingYawDegrees` final direction before logout
- `gui` transport settings:
  - `enabled` (turn GUI transport on/off)
  - `host` bind host for the HTTP server
  - `port` bind port for the HTTP server
- `refill` settings:
  - `enabled` (turn opportunistic refill on/off)
  - `radius` (nearby container scan radius)
  - `cooldownMs` (minimum delay between refill attempts)
  - `ignoreEmptyMs` (ignore empty container cooldown)
  - `thresholds` (low-material trigger values)
  - `targetStacks` (how much to pull per item when refilling)

## Important world assumptions

- String is placed directly against each cactus collision edge; no external string anchor lattice is required.
- In `manual` mode, the origin should be aligned to the target area and supported for all placements.
- In `easy_center` mode, the bot uses your post-`/survival` spawn position as center, computes origin automatically, and sets safe platform to that center.
- Starter spine block required: place a solid block at `(origin.x - 2, origin.y - 1, origin.z)` before start.
- The bot does not interact with storage, hoppers, or water systems.
