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
  layers: 18,
  buildDelayTicks: 3,
  removeScaffold: false,
  safePlatform: { x: 0, y: 64, z: 0 },
  origin: { x: 0, y: 64, z: 0 },
  facingYawDegrees: 0
}

const CHECKPOINT_PATH = path.join(process.cwd(), 'build-checkpoint.json')

function clampInteger (value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.floor(num)))
}

function validateConfig (config) {
  return {
    ...config,
    layers: clampInteger(config.layers, 1, 128, DEFAULT_CONFIG.layers),
    buildDelayTicks: clampInteger(config.buildDelayTicks, 1, 40, DEFAULT_CONFIG.buildDelayTicks),
    removeScaffold: Boolean(config.removeScaffold),
    facingYawDegrees: Number.isFinite(Number(config.facingYawDegrees)) ? Number(config.facingYawDegrees) : DEFAULT_CONFIG.facingYawDegrees
  }
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

const cfg = validateConfig(loadConfig())
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
let lagStateLogged = false
let checkpointWritePending = false
let pendingCheckpointPayload = null
let clearCheckpointRequested = false

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
  return Boolean(
    below &&
    below.boundingBox === 'block' &&
    !below.transparent &&
    !below.name.includes('fence') &&
    !below.name.includes('wall') &&
    below.name !== 'sand'
  )
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
  const stringCount = itemCountByName('string')
  const buffer = Math.ceil(remainingCells * 0.05)
  const needed = remainingCells + buffer

  if (sand < needed || cactus < needed || stringCount < needed) {
    throw new Error(`Insufficient inventory for remaining ${remainingCells} cells (+${buffer} buffer). sand=${sand}, cactus=${cactus}, string=${stringCount}`)
  }
}

function requireCobblestoneForLayer (layerIndex) {
  const cellsPerLayer = 16 * 16
  const spineNeeded = (layerIndex + 1) * 4
  const conservativeScaffoldNeeded = cfg.removeScaffold ? cellsPerLayer : 0
  const needed = spineNeeded + conservativeScaffoldNeeded
  const cobble = itemCountByName('cobblestone')

  if (cobble < needed) {
    throw new Error(`Insufficient cobblestone for layer ${layerIndex + 1}. needed~=${needed}, have=${cobble}`)
  }
}

function assertNoEntityBlocking (targetPos, radius = 1.2) {
  const entities = Object.values(bot.entities)
  for (const entity of entities) {
    if (!entity || !entity.position) continue
    if (bot.entity && entity.id === bot.entity.id) continue

    if (entity.position.distanceTo(targetPos) < radius) {
      throw new Error(`Entity blocking placement area at ${targetPos.toString()}`)
    }
  }
}


function loadCheckpoint () {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    return { layer: 0, cell: 0 }
  }

  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      layer: clampInteger(parsed.layer, 0, cfg.layers, 0),
      cell: clampInteger(parsed.cell, 0, 255, 0)
    }
  } catch (err) {
    console.warn(`[WARN] Failed to read checkpoint file: ${err.message}. Starting from beginning.`)
    return { layer: 0, cell: 0 }
  }
}

function flushCheckpointWrite () {
  if (clearCheckpointRequested) return
  if (checkpointWritePending || pendingCheckpointPayload == null) return

  checkpointWritePending = true
  const payload = pendingCheckpointPayload
  pendingCheckpointPayload = null

  fs.writeFile(CHECKPOINT_PATH, payload, err => {
    checkpointWritePending = false
    if (err) {
      console.warn(`[WARN] Failed to save checkpoint: ${err.message}`)
    }

    if (clearCheckpointRequested) {
      if (fs.existsSync(CHECKPOINT_PATH)) {
        fs.unlinkSync(CHECKPOINT_PATH)
      }
      return
    }

    if (pendingCheckpointPayload != null) {
      flushCheckpointWrite()
    }
  })
}

function saveCheckpoint (layer, cell) {
  if (clearCheckpointRequested) return
  pendingCheckpointPayload = JSON.stringify({ layer, cell }, null, 2)
  flushCheckpointWrite()
}

function clearCheckpoint () {
  clearCheckpointRequested = true
  pendingCheckpointPayload = null

  if (!checkpointWritePending && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH)
  }
}

function requireLoaded (pos) {
  const block = bot.blockAt(pos)
  if (!block) {
    throw new Error(`Chunk not loaded at ${pos.toString()}`)
  }
  return block
}

async function waitForClearArea (pos, timeoutMs = 5000) {
  const start = Date.now()
  while ((Date.now() - start) < timeoutMs) {
    try {
      assertNoEntityBlocking(pos)
      return
    } catch (err) {
      await sleepTicks(10)
    }
  }

  throw new Error(`Area blocked too long at ${pos.toString()}`)
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

  if (bot.player) {
    bot.quit(`[MineFarmBot] ${reason}`)
  }
}

async function moveToSafePlatform () {
  const pos = new Vec3(cfg.safePlatform.x, cfg.safePlatform.y, cfg.safePlatform.z)
  const goal = new goals.GoalBlock(pos.x, pos.y, pos.z)
  await bot.pathfinder.goto(goal)

  if (!hasSolidFooting()) {
    throw new Error('Safe platform does not provide solid, non-sand footing')
  }
}

function buildGridTasks (origin, layerIndex) {
  const y = origin.y + (layerIndex * 3)
  const cells = []

  for (let dz = 0; dz < 16; dz++) {
    const leftToRight = dz % 2 === 0
    const xValues = leftToRight ? [...Array(16).keys()] : [...Array(16).keys()].reverse()

    for (const dx of xValues) {
      const scaffoldOffsetX = leftToRight ? 1 : -1
      cells.push({ sandPos: new Vec3(origin.x + dx, y, origin.z + dz), scaffoldOffsetX })
    }
  }

  return cells
}

function chooseScaffoldPos (sandPos, xOffset) {
  return sandPos.offset(xOffset, 0, 0)
}

async function gotoAndStand (target) {
  const belowTarget = bot.blockAt(target)
  if (isBlockName(belowTarget, 'sand')) {
    throw new Error(`Refusing to stand on sand at ${target.toString()}`)
  }

  const goal = new goals.GoalGetToBlock(target.x, target.y + 1, target.z)
  await bot.pathfinder.goto(goal)

  const standing = bot.entity.position.floored()
  if (
    standing.x !== target.x ||
    standing.z !== target.z ||
    Math.abs(standing.y - target.y) > 0
  ) {
    throw new Error(`Pathfinder stopped at ${standing.toString()} instead of ${target.toString()}`)
  }

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
  const reference = requireLoaded(referencePos)

  await bot.lookAt(reference.position.offset(0.5, 0.5, 0.5), true)
  await bot.placeBlock(reference, faceVec)
  await sleepTicks(cfg.buildDelayTicks + (lagMode ? 2 : 0))
}



async function ensureVerticalSpine (origin, layerIndex) {
  const spineX = origin.x - 2
  const spineZ = origin.z
  const baseY = origin.y - 1
  const targetY = origin.y + (layerIndex * 3) - 1

  const basePos = new Vec3(spineX, baseY, spineZ)
  const baseBlock = requireLoaded(basePos)
  if (!baseBlock || baseBlock.boundingBox !== 'block') {
    throw new Error(`Vertical spine base missing at ${basePos.toString()}. Place a starter cobblestone block there before running.`)
  }

  let highestConfirmedY = baseY
  for (let y = baseY + 1; y <= targetY; y++) {
    const current = new Vec3(spineX, y, spineZ)
    const existing = requireLoaded(current)
    if (existing && existing.boundingBox === 'block') {
      highestConfirmedY = y
      continue
    }

    const standPos = new Vec3(spineX, highestConfirmedY, spineZ)
    await gotoAndStand(standPos)
    await placeBlockByName(standPos, new Vec3(0, 1, 0), 'cobblestone')
    highestConfirmedY = y
  }

  await gotoAndStand(new Vec3(spineX, highestConfirmedY, spineZ))
}


function isCellCompleted (sandPos, scaffoldOffsetX) {
  let sandBlock
  let cactusBlock
  let preferredString
  let oppositeString

  try {
    sandBlock = requireLoaded(sandPos)
    const cactusPos = sandPos.offset(0, 1, 0)
    cactusBlock = requireLoaded(cactusPos)

    const preferredStringPos = cactusPos.offset(scaffoldOffsetX, 0, 0)
    preferredString = requireLoaded(preferredStringPos)

    const oppositeStringPos = cactusPos.offset(-scaffoldOffsetX, 0, 0)
    oppositeString = requireLoaded(oppositeStringPos)
  } catch (err) {
    return false
  }

  if (!isBlockName(sandBlock, 'sand')) return false
  if (!isBlockName(cactusBlock, 'cactus')) return false
  if (isBlockName(preferredString, 'tripwire')) return true

  return isBlockName(oppositeString, 'tripwire')
}

async function placeCactusStack (sandPos, scaffoldOffsetX) {
  if (isCellCompleted(sandPos, scaffoldOffsetX)) {
    return
  }

  const scaffoldPos = chooseScaffoldPos(sandPos, scaffoldOffsetX)

  await gotoAndStand(scaffoldPos)
  const scaffoldBlock = requireLoaded(scaffoldPos)

  if (!scaffoldBlock || scaffoldBlock.boundingBox !== 'block') {
    const below = requireLoaded(scaffoldPos.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') {
      throw new Error(`Cannot scaffold at ${scaffoldPos}; no solid support below`)
    }
    await placeBlockByName(scaffoldPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'cobblestone')

    const placed = requireLoaded(scaffoldPos)
    if (!placed || placed.boundingBox !== 'block') {
      throw new Error(`Scaffold placement failed at ${scaffoldPos}`)
    }
  }

  await gotoAndStand(scaffoldPos)

  await waitForClearArea(sandPos)

  const sandBase = requireLoaded(sandPos.offset(0, -1, 0))
  if (!sandBase || sandBase.boundingBox !== 'block') {
    throw new Error(`Cannot place sand at ${sandPos}; unsupported location`)
  }

  const existingSand = requireLoaded(sandPos)
  if (!isBlockName(existingSand, 'sand')) {
    await placeBlockByName(sandPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'sand')
  }

  const sandBlock = requireLoaded(sandPos)
  if (!isBlockName(sandBlock, 'sand')) {
    throw new Error(`Sand placement failed at ${sandPos}`)
  }

  const cactusPos = sandPos.offset(0, 1, 0)
  await waitForClearArea(cactusPos)
  const existingCactus = requireLoaded(cactusPos)
  if (!isBlockName(existingCactus, 'cactus')) {
    await placeBlockByName(sandPos, new Vec3(0, 1, 0), 'cactus')
  }

  const stringPos = cactusPos.offset(scaffoldOffsetX, 0, 0)
  await waitForClearArea(stringPos)
  const existingString = requireLoaded(stringPos)
  if (!existingString || existingString.name !== 'tripwire') {
    await placeBlockByName(cactusPos, new Vec3(scaffoldOffsetX, 0, 0), 'string')

    const placedString = requireLoaded(stringPos)
    if (!placedString || placedString.name !== 'tripwire') {
      throw new Error(`String placement failed at ${stringPos.toString()}`)
    }
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
  defaultMove.canDig = false
  defaultMove.maxDropDown = 1
  defaultMove.allow1by1towers = false
  defaultMove.allowEntityDetection = true
  if (Object.prototype.hasOwnProperty.call(defaultMove, 'allowDiagonalPathing')) {
    defaultMove.allowDiagonalPathing = false
  }
  bot.pathfinder.setMovements(defaultMove)
}

function startLagMonitor () {
  bot.on('physicsTick', () => {
    const now = Date.now()
    if (lastPhysics != null) {
      const delta = now - lastPhysics
      lagSamples.push(delta)
      if (lagSamples.length > 25) lagSamples.shift()

      const avg = lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length
      lagMode = avg > 70
      if (lagMode && !lagStateLogged) {
        console.log('[WARN] Server lag detected. Slowing placement rate.')
        lagStateLogged = true
      } else if (!lagMode && lagStateLogged) {
        console.log('[INFO] Lag recovered. Returning to normal placement rate.')
        lagStateLogged = false
      }
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
    if (!isStopping) {
      isStopping = true
      console.log('[INFO] Build halted due to disconnect.')
    }
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
  const checkpoint = loadCheckpoint()

  for (let layer = checkpoint.layer; layer < cfg.layers; layer++) {
    const layerY = origin.y + (layer * 3)
    if (layerY > 319) {
      throw new Error(`Y limit exceeded at layer ${layer + 1} (targetY=${layerY})`)
    }

    console.log(`[INFO] Starting layer ${layer + 1}/${cfg.layers}`)
    await ensureVerticalSpine(origin, layer)
    requireCobblestoneForLayer(layer)
    const cells = buildGridTasks(origin, layer)
    const startCell = layer === checkpoint.layer ? checkpoint.cell : 0
    const remainingFromStart = cells.length - startCell
    requireInventoryForLayer(remainingFromStart)

    for (let i = startCell; i < cells.length; i++) {
      const remaining = cells.length - i
      if (remaining % 16 === 0) {
        requireInventoryForLayer(remaining)
      }

      const task = cells[i]
      await placeCactusStack(task.sandPos, task.scaffoldOffsetX)

      if ((i + 1) % 16 === 0) {
        const nextCell = i + 1
        if (nextCell >= cells.length) {
          saveCheckpoint(layer + 1, 0)
        } else {
          saveCheckpoint(layer, nextCell)
        }
      }
    }
  }

  clearCheckpoint()
}

bot.once('spawn', async () => {
  console.log('[INFO] Spawned. Preparing build routine...')
  console.log(`[INFO] Config: layers=${cfg.layers}, buildDelayTicks=${cfg.buildDelayTicks}, removeScaffold=${cfg.removeScaffold}`)
  if (cfg.removeScaffold) {
    console.log('[WARN] Scaffold removal is enabled. This may be less safe on laggy servers.')
  }

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
