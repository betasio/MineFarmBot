# MineFarmBot

Mineflayer-based Minecraft Java bot that builds chunk-aligned cactus farm layers with strict survival safety rules.

## Features

- Builds exactly **16×16** cactus cells per layer.
- Uses **3-block vertical spacing** between layers.
- Configurable layer count (`layers`, default 18).
- Build sequence per cell:
  1. Ensure cobblestone scaffold exists.
  2. Move onto scaffold.
  3. Place sand.
  4. Place cactus.
  5. Place string diagonally above cactus using a collision anchor.
  6. Optionally remove scaffold.
- Safety constraints:
  - Never intentionally stands on sand.
  - Requires solid support beneath bot.
  - Stops if fall > 1 block is detected.
  - Stops and logs out on inventory shortages.
  - Slows placement rate when lag is detected.

## Setup

1. Install Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Copy and edit config:

```bash
cp config.example.json config.json
```

4. Start:

```bash
npm start
```


## Non-technical quick start

1. Install Node.js (LTS) on Windows.
2. Put this folder somewhere easy (for example `C:\MineFarmBot`).
3. Open Command Prompt in the folder.
4. Run `npm install` once.
5. Run `copy config.example.json config.json` and edit `config.json` in Notepad.
6. Set at least: server `host`, `port`, `username`, and farm `origin` / `safePlatform`.
7. Start with `npm start`.

The bot prints clear stop messages if it detects unsafe movement, missing inventory, or disconnection.

## Config

`config.json` fields:

- `host`, `port`, `username`, `password`, `auth`, `version`
- `layers` (number of layers, recommended 15–20)
- `buildDelayTicks` (base delay between placements)
- `removeScaffold` (`true`/`false`)
- `origin` (`x,y,z`) base corner for the 16×16 chunk footprint
- `safePlatform` (`x,y,z`) post-build / emergency retreat location
- `facingYawDegrees` final direction before logout

## Important world assumptions

- The target farm template must provide a valid solid block at each string anchor position used by the bot.
- The origin should be aligned to the target chunk and supported for all placements.
- The bot does not interact with storage, hoppers, or water systems.
