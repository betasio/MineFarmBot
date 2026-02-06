'use strict'

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const TICKS_PER_SECOND = 20
const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 25565,
  username: 'CactusBuilderBot',
  password: null,
  auth: 'offline',
  version: false,
  layers: 16,
  buildDelayTicks: 3,
  removeScaffold: true,
  safePlatform: { x: 0, y: 64, z: 0 },
  origin: { x: 0, y: 64, z: 0 },
  facingYawDegrees: 0
}

function loadConfig () {
  const configPath = path.join(process.cwd(), 'config.json')
  if (!fs.existsSync(configPath)) {
    console.warn('[WARN] config.json not found. Falling back to defaults.')
    return DEFAULT_CONFIG
  }

  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    origin: { ...DEFAULT_CONFIG.origin, ...(parsed.origin || {}) },
    safePlatform: { ...DEFAULT_CONFIG.safePlatform, ...(parsed.safePlatform || {}) }
  }
}

const cfg = loadConfig()
const bot = mineflayer.createBot({
  host: cfg.host,
  port: cfg.port,
  username: cfg.username,
  password: cfg.password,
  auth: cfg.auth,
  version: cfg.version || undefined
})

bot.loadPlugin(pathfinder)

let isStopping = false
let lastPhysics = null
let lagSamples = []
let lagMode = false

function ticksToMs (ticks) {
  return Math.max(0, Math.floor((ticks / TICKS_PER_SECOND) * 1000))
}

function sleepTicks (ticks) {
  return new Promise(resolve => setTimeout(resolve, ticksToMs(ticks)))
}

function yawFromDegrees (degrees) {
  return (degrees * Math.PI) / 180
}

function itemCountByName (name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0)
}

function hasSolidFooting () {
  const below = bot.blockAt(bot.entity.position.offset(0, -1, 0).floored())
  return Boolean(below && below.boundingBox === 'block' && below.name !== 'sand')
}

async function equipItem (itemName, destination = 'hand') {
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) {
    throw new Error(`Missing inventory item: ${itemName}`)
  }
  await bot.equip(item, destination)
}

function isBlockName (block, name) {
  return block && block.name === name
}

function requireInventoryForLayer (remainingCells) {
  const sand = itemCountByName('sand')
  const cactus = itemCountByName('cactus')
  const cobble = itemCountByName('cobblestone')
  const stringCount = itemCountByName('string')

  if (sand < remainingCells || cactus < remainingCells || cobble < remainingCells || stringCount < remainingCells) {
    throw new Error(`Insufficient inventory for remaining ${remainingCells} cells. sand=${sand}, cactus=${cactus}, cobblestone=${cobble}, string=${stringCount}`)
  }
}

async function safeStop (reason) {
  if (isStopping) return
  isStopping = true

  console.error(`[STOP] ${reason}`)
  try {
    await moveToSafePlatform()
    await bot.look(yawFromDegrees(cfg.facingYawDegrees), 0, true)
  } catch (err) {
    console.error(`[WARN] Failed to move to safe platform during stop: ${err.message}`)
  }

  bot.quit(`[MineFarmBot] ${reason}`)
}

async function moveToSafePlatform () {
  const pos = new Vec3(cfg.safePlatform.x, cfg.safePlatform.y, cfg.safePlatform.z)
  const goal = new goals.GoalBlock(pos.x, pos.y, pos.z)
  await bot.pathfinder.goto(goal)

  if (!hasSolidFooting()) {
    throw new Error('Safe platform does not provide solid, non-sand footing')
  }
}

function buildGridPositions (origin, layerIndex) {
  const y = origin.y + (layerIndex * 3)
  const cells = []

  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      cells.push(new Vec3(origin.x + dx, y, origin.z + dz))
    }
  }

  return cells
}

function chooseStringAnchor (cactusPos) {
  return cactusPos.offset(1, 1, 1)
}

function chooseScaffoldPos (sandPos) {
  return sandPos.offset(0, -1, 0)
}

async function gotoAndStand (target) {
  const goal = new goals.GoalGetToBlock(target.x, target.y + 1, target.z)
  await bot.pathfinder.goto(goal)

  if (!hasSolidFooting()) {
    throw new Error(`Unsafe footing at ${bot.entity.position.floored().toString()}`)
  }

  const below = bot.blockAt(bot.entity.position.offset(0, -1, 0).floored())
  if (isBlockName(below, 'sand')) {
    throw new Error('Safety violation: bot stood on sand')
  }
}

async function placeBlockByName (referencePos, faceVec, itemName) {
  await equipItem(itemName)
  const reference = bot.blockAt(referencePos)
  if (!reference) {
    throw new Error(`Cannot place ${itemName}; missing reference block at ${referencePos}`)
  }

  await bot.placeBlock(reference, faceVec)
  await sleepTicks(cfg.buildDelayTicks + (lagMode ? 2 : 0))
}

async function placeCactusStack (sandPos) {
  const scaffoldPos = chooseScaffoldPos(sandPos)

  await gotoAndStand(scaffoldPos)
  const scaffoldBlock = bot.blockAt(scaffoldPos)

  if (!scaffoldBlock || scaffoldBlock.boundingBox !== 'block') {
    const below = bot.blockAt(scaffoldPos.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') {
      throw new Error(`Cannot scaffold at ${scaffoldPos}; no solid support below`)
    }
    await placeBlockByName(scaffoldPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'cobblestone')
  }

  await gotoAndStand(scaffoldPos)

  const sandBase = bot.blockAt(sandPos.offset(0, -1, 0))
  if (!sandBase || sandBase.boundingBox !== 'block') {
    throw new Error(`Cannot place sand at ${sandPos}; unsupported location`)
  }

  const existingSand = bot.blockAt(sandPos)
  if (!isBlockName(existingSand, 'sand')) {
    await placeBlockByName(sandPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'sand')
  }

  const sandBlock = bot.blockAt(sandPos)
  if (!isBlockName(sandBlock, 'sand')) {
    throw new Error(`Sand placement failed at ${sandPos}`)
  }

  const cactusPos = sandPos.offset(0, 1, 0)
  const existingCactus = bot.blockAt(cactusPos)
  if (!isBlockName(existingCactus, 'cactus')) {
    await placeBlockByName(sandPos, new Vec3(0, 1, 0), 'cactus')
  }

  const stringAnchor = chooseStringAnchor(cactusPos)
  const anchorBlock = bot.blockAt(stringAnchor)
  if (!anchorBlock || anchorBlock.boundingBox !== 'block') {
    throw new Error(`String anchor missing at ${stringAnchor}; ensure farm template provides a valid adjacent collision block`)
  }

  const stringPos = cactusPos.offset(1, 1, 0)
  const existingString = bot.blockAt(stringPos)
  if (!isBlockName(existingString, 'tripwire')) {
    await placeBlockByName(stringAnchor, new Vec3(0, 0, -1), 'string')
  }

  if (cfg.removeScaffold) {
    const botPos = bot.entity.position.floored()
    if (!botPos.equals(scaffoldPos)) {
      const scaf = bot.blockAt(scaffoldPos)
      if (isBlockName(scaf, 'cobblestone')) {
        await bot.dig(scaf, true)
        await sleepTicks(1)
      }
    }
  }
}

function setupMovement () {
  const defaultMove = new Movements(bot)
  defaultMove.allowSprinting = false
  defaultMove.allowParkour = false
  defaultMove.canDig = true
  defaultMove.maxDropDown = 1
  defaultMove.allow1by1towers = false
  defaultMove.allowEntityDetection = true
  bot.pathfinder.setMovements(defaultMove)
}

function startLagMonitor () {
  bot.on('time', () => {
    const now = Date.now()
    if (lastPhysics != null) {
      const delta = now - lastPhysics
      lagSamples.push(delta)
      if (lagSamples.length > 25) lagSamples.shift()

      const avg = lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length
      lagMode = avg > 70
    }
    lastPhysics = now
  })
}

function setupSafetyHooks () {
  let lastY = null
  bot.on('physicsTick', () => {
    if (isStopping) return
    const y = bot.entity.position.y
    if (lastY != null && (lastY - y) > 1.01) {
      safeStop(`Fall detected. drop=${(lastY - y).toFixed(2)} blocks`)
    }
    lastY = y
  })

  bot.on('end', () => {
    console.log('[INFO] Disconnected from server.')
  })

  bot.on('kicked', reason => {
    console.error(`[KICKED] ${reason}`)
  })

  bot.on('error', err => {
    console.error(`[ERROR] ${err.message}`)
    if (!isStopping) {
      safeStop(`Unhandled bot error: ${err.message}`)
    }
  })
}

async function runBuild () {
  const origin = new Vec3(cfg.origin.x, cfg.origin.y, cfg.origin.z)

  for (let layer = 0; layer < cfg.layers; layer++) {
    console.log(`[INFO] Starting layer ${layer + 1}/${cfg.layers}`)
    const cells = buildGridPositions(origin, layer)
    requireInventoryForLayer(cells.length)

    for (let i = 0; i < cells.length; i++) {
      const remaining = cells.length - i
      if (remaining % 16 === 0) {
        requireInventoryForLayer(remaining)
      }

      const sandPos = cells[i]
      await placeCactusStack(sandPos)
    }
  }
}

bot.once('spawn', async () => {
  console.log('[INFO] Spawned. Preparing build routine...')

  try {
    setupMovement()
    startLagMonitor()
    setupSafetyHooks()

    if (!hasSolidFooting()) {
      throw new Error('Bot spawned without solid non-sand footing')
    }

    await runBuild()
    await moveToSafePlatform()
    await bot.look(yawFromDegrees(cfg.facingYawDegrees), 0, true)
    bot.quit('[MineFarmBot] Build completed successfully')
  } catch (err) {
    await safeStop(err.message)
  }
})
