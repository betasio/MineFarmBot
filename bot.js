'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const readline = require('readline')

const { validateConfig, loadConfig } = require('./config')
const { createCheckpointManager } = require('./checkpoint')
const { createHumanizer } = require('./humanizer')
const { createInventoryManager } = require('./inventory')
const { createRefillManager } = require('./refillManager')
const { createBuildController } = require('./buildController')
const { startUiServer } = require('./ui/server')

const TICKS_PER_SECOND = 20
const MAX_RECONNECT_DELAY = 60_000

function createBotEngine (config = validateConfig(loadConfig())) {
  const cfg = config
  const shouldAutoStartDesktopBuild = process.env.MINEFARMBOT_AUTOSTART === '1'

  let bot
  let reconnectAttempts = 0
  let reconnectScheduled = false
  let isStopping = false
  let lastPhysics = null
  let lagSamples = []
  let lagMode = false
  let lagStateLogged = false
  let statusInterval = null
  let connectionStartedAt = null
  let lastUptimeMs = null
  let nextReconnectAt = null
  let nextReconnectDelayMs = null
  let reconnectWindowStartedAt = null
  let safetyHooksArmed = false
  let lifecycleState = 'idle'

  const listeners = {
    log: new Set(),
    status: new Set(),
    warning: new Set(),
    error: new Set()
  }

  function emit (type, payload) {
    for (const fn of listeners[type]) fn(payload)
  }

  function onLog (fn) {
    listeners.log.add(fn)
    return () => listeners.log.delete(fn)
  }

  function onStatus (fn) {
    listeners.status.add(fn)
    return () => listeners.status.delete(fn)
  }

  function onWarning (fn) {
    listeners.warning.add(fn)
    return () => listeners.warning.delete(fn)
  }

  function onError (fn) {
    listeners.error.add(fn)
    return () => listeners.error.delete(fn)
  }

  function createLogEntry (level, message, timestamp = Date.now()) {
    return { level, message, timestamp }
  }

  function emitLogEntry (entry) {
    const payload = {
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp ?? Date.now()
    }
    if (payload.level === 'warn') emit('warning', payload)
    else if (payload.level === 'error') emit('error', payload)
    else emit('log', payload)
  }

  function handleLogEntry (entry) {
    const payload = {
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp ?? Date.now()
    }
    if (payload.level === 'warn') console.warn(payload.message)
    else if (payload.level === 'error') console.error(payload.message)
    else console.log(payload.message)
    emitLogEntry(payload)
  }

  function log (message) {
    handleLogEntry(createLogEntry('info', message))
  }

  function warn (message) {
    handleLogEntry(createLogEntry('warn', message))
  }

  function reportError (message) {
    handleLogEntry(createLogEntry('error', message))
  }


  function formatErrorMessage (err) {
    if (!err) return 'Unknown error'
    if (typeof err.message === 'string' && err.message.trim().length > 0) return err.message
    if (Array.isArray(err.errors) && err.errors.length > 0) {
      const first = err.errors[0]
      if (first && typeof first.message === 'string' && first.message.trim().length > 0) {
        return first.message
      }
    }
    if (typeof err.code === 'string' && err.code.length > 0) return err.code
    return String(err)
  }

  const checkpointManager = createCheckpointManager(cfg.layers)

  function getBot () {
    return bot
  }

  function getPingValue () {
    if (!bot) return null
    if (bot.player && typeof bot.player.ping === 'number') return bot.player.ping
    if (typeof bot.getPing === 'function') {
      const ping = bot.getPing()
      return typeof ping === 'number' ? ping : null
    }
    return null
  }

  function getConnectionState () {
    if (bot && bot.player) return 'online'
    if (reconnectScheduled) return 'reconnecting'
    return 'offline'
  }

  function setLifecycleState (nextState) {
    if (lifecycleState === nextState) return false
    lifecycleState = nextState
    emitStatus()
    return true
  }


  function normalizeLookAtDescriptor () {
    if (!bot || !bot.entity || !bot.entity.position) return null
    const yaw = Number(bot.entity.yaw)
    const pitch = Number(bot.entity.pitch)
    return {
      yaw: Number.isFinite(yaw) ? yaw : null,
      pitch: Number.isFinite(pitch) ? pitch : null,
      facingYawDegrees: Number.isFinite(yaw) ? Number((yaw * 180 / Math.PI).toFixed(2)) : null,
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z
    }
  }



  function getBotMode () {
    const state = buildStatus && typeof buildStatus.state === 'string'
      ? buildStatus.state.toLowerCase()
      : 'idle'
    if (state === 'running') return 'building'
    if (state === 'paused') return 'paused'
    if (state === 'recovering') return 'recovering'
    if (state === 'stopped') return 'stopped'
    return 'idle'
  }

  function getMovementStatus () {
    if (!bot || !bot.entity || !bot.entity.velocity) {
      return {
        speed: 0,
        onGround: null,
        jumpTicks: null,
        inWater: null,
        inLava: null
      }
    }

    const vx = Number(bot.entity.velocity.x) || 0
    const vy = Number(bot.entity.velocity.y) || 0
    const vz = Number(bot.entity.velocity.z) || 0
    const speed = Math.sqrt((vx * vx) + (vy * vy) + (vz * vz))

    return {
      speed: Number(speed.toFixed(4)),
      onGround: typeof bot.entity.onGround === 'boolean' ? bot.entity.onGround : null,
      jumpTicks: Number.isFinite(Number(bot.entity.jumpTicks)) ? Number(bot.entity.jumpTicks) : null,
      inWater: typeof bot.entity.isInWater === 'boolean' ? bot.entity.isInWater : null,
      inLava: typeof bot.entity.isInLava === 'boolean' ? bot.entity.isInLava : null
    }
  }

  function getStatusPayload () {
    const connected = Boolean(bot && bot.player)
    const position = bot && bot.entity && bot.entity.position
      ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
      : null
    const uptimeMs = connectionStartedAt ? (Date.now() - connectionStartedAt) : lastUptimeMs
    const lookAt = normalizeLookAtDescriptor()
    const movement = getMovementStatus()
    const botMode = getBotMode()
    const pauseReason = buildStatus && typeof buildStatus.pauseReason === 'string'
      ? buildStatus.pauseReason
      : null
    const inventorySnapshot = inventory.getMaterialCounts()
    const refill = refillManager.getRefillStatus()
    return {
      connectionState: getConnectionState(),
      connected,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      ping: getPingValue(),
      lagMode,
      reconnectAttempts,
      uptimeMs,
      coordinates: position,
      dimension: bot && bot.game ? bot.game.dimension : null,
      reconnectScheduled,
      reconnectDelayMs: nextReconnectDelayMs,
      reconnectAt: nextReconnectAt,
      reconnectWindowStartedAt,
      lifecycleState,
      lookAt,
      movement,
      botMode,
      pauseReason,
      position,
      build: buildStatus,
      inventory: inventorySnapshot,
      refill
    }
  }

  function emitStatus () {
    emit('status', getStatusPayload())
  }

  function ticksToMs (ticks) {
    return Math.max(0, Math.floor((ticks / TICKS_PER_SECOND) * 1000))
  }

  function sleepTicks (ticks) {
    return new Promise(resolve => setTimeout(resolve, ticksToMs(ticks)))
  }

  function sleepMs (ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Math.floor(ms))))
  }

  function yawFromDegrees (degrees) {
    return (degrees * Math.PI) / 180
  }

  function isBlockName (block, name) {
    return block && block.name === name
  }

  const humanizer = createHumanizer({ getBot, sleepTicks })
  const inventory = createInventoryManager({ getBot, cfg })

  function hasSolidFooting () {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0).floored())
    return Boolean(
      below && below.boundingBox === 'block' && !below.transparent &&
      !below.name.includes('fence') && !below.name.includes('wall') && below.name !== 'sand'
    )
  }

  const refillManager = createRefillManager({
    getBot,
    cfg,
    goals,
    itemCountByName: inventory.itemCountByName,
    hasRequiredInventoryForRemaining: inventory.hasRequiredInventoryForRemaining,
    requireInventoryForLayer: inventory.requireInventoryForLayer,
    isBusyPlacing: humanizer.isBusyPlacing,
    isStableForRefill: () => hasSolidFooting(),
    sleepTicks,
    info: log,
    warn,
    onRefillStatus: () => emitStatus()
  })

  function requireLoaded (pos) {
    const block = bot.blockAt(pos)
    if (!block) throw new Error(`Chunk not loaded at ${pos.toString()}`)
    return block
  }

  function hasSolidNonSandBlockAt (pos) {
    const block = bot.blockAt(pos)
    return Boolean(block && block.boundingBox === 'block' && block.name !== 'sand')
  }

  async function waitForBlockName (pos, expectedName, attempts = 8, delayTicks = 1) {
    let lastBlock = null
    for (let i = 0; i < attempts; i++) {
      lastBlock = bot.blockAt(pos)
      if (lastBlock && lastBlock.name === expectedName) return lastBlock
      await sleepTicks(delayTicks)
    }
    return lastBlock
  }

  function assertNoEntityBlocking (targetPos, radius = 1.2) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) continue
      if (bot.entity && entity.id === bot.entity.id) continue
      if (entity.position.distanceTo(targetPos) < radius) {
        throw new Error(`Entity blocking placement area at ${targetPos.toString()}`)
      }
    }
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

  async function moveToSafePlatform () {
    const pos = new Vec3(cfg.safePlatform.x, cfg.safePlatform.y, cfg.safePlatform.z)
    await bot.pathfinder.goto(new goals.GoalBlock(pos.x, pos.y, pos.z))
    if (!hasSolidFooting()) throw new Error('Safe platform does not provide solid, non-sand footing')
  }

  async function safeStop (reason) {
    if (isStopping) return
    isStopping = true
    reportError(reason)
    try {
      await moveToSafePlatform()
      await bot.look(yawFromDegrees(cfg.facingYawDegrees), 0, true)
    } catch (err) {
      warn(`Failed to move to safe platform during stop: ${err.message}`)
    }
    if (bot.player) bot.quit(`[MineFarmBot] ${reason}`)
  }

  function buildGridTasks (origin, layerIndex) {
    const y = origin.y + (layerIndex * 3)
    const size = Math.max(3, Number(cfg.farmSize) || 9)
    const cells = []
    for (let dz = 0; dz < size; dz++) {
      const leftToRight = dz % 2 === 0
      const xValues = leftToRight ? [...Array(size).keys()] : [...Array(size).keys()].reverse()
      for (const dx of xValues) {
        const scaffoldOffsetX = leftToRight ? 1 : -1
        cells.push({ sandPos: new Vec3(origin.x + dx, y, origin.z + dz), scaffoldOffsetX })
      }
    }
    return cells
  }

  function resolveEasyPlacementFromPlayerPosition () {
    const placementMode = String(cfg.placementMode || 'manual').toLowerCase()
    if (placementMode !== 'easy') return

    const size = Math.max(3, Number(cfg.farmSize) || 9)
    const center = bot.entity.position.floored()
    const half = Math.floor(size / 2)
    const origin = {
      x: center.x - half,
      y: center.y,
      z: center.z - half
    }

    let safeY = center.y
    const centerBlock = bot.blockAt(new Vec3(center.x, center.y, center.z))
    const belowCenter = bot.blockAt(new Vec3(center.x, center.y - 1, center.z))
    const belowSolid = belowCenter && belowCenter.boundingBox === 'block' && belowCenter.name !== 'sand'
    const centerSolid = centerBlock && centerBlock.boundingBox === 'block' && centerBlock.name !== 'sand'
    if (!belowSolid && centerSolid) safeY = center.y + 1

    cfg.origin = origin
    cfg.safePlatform = { x: center.x, y: safeY, z: center.z }

    log(`Easy placement enabled: center=${center.x},${center.y},${center.z} size=${size}x${size} -> origin=${origin.x},${origin.y},${origin.z} safePlatform=${cfg.safePlatform.x},${cfg.safePlatform.y},${cfg.safePlatform.z}`)
  }

  const chooseScaffoldPos = (sandPos, xOffset) => sandPos.offset(xOffset, 0, 0)

  async function gotoAndStand (target) {
    const belowTarget = bot.blockAt(target)
    if (isBlockName(belowTarget, 'sand')) throw new Error(`Refusing to stand on sand at ${target.toString()}`)
    await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y + 1, target.z))

    const standing = bot.entity.position.floored()
    const horizontal = Math.hypot(standing.x - target.x, standing.z - target.z)
    if (horizontal > 1.5 || Math.abs(standing.y - target.y) > 1) {
      throw new Error(`Pathfinder stopped at ${standing.toString()} instead of near ${target.toString()}`)
    }
    if (!hasSolidFooting()) throw new Error(`Unsafe footing at ${bot.entity.position.floored().toString()}`)
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0).floored())
    if (isBlockName(below, 'sand')) throw new Error('Safety violation: bot stood on sand')
  }

  async function placeBlockByName (referencePos, faceVec, itemName) {
    if (inventory.itemCountByName(itemName) <= 0) {
      throw new Error(`Insufficient inventory item during placement: ${itemName}`)
    }

    humanizer.setBusyPlacing(true)
    try {
      await inventory.equipItem(itemName)
      const reference = requireLoaded(referencePos)
      await bot.lookAt(reference.position.offset(0.5, 0.5, 0.5), true)
      await bot.placeBlock(reference, faceVec)
      await sleepTicks(cfg.buildDelayTicks + (lagMode ? 2 : 0))
    } finally {
      humanizer.setBusyPlacing(false)
    }

    await humanizer.randomHeadMovement()
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
    try {
      const sandBlock = requireLoaded(sandPos)
      const cactusPos = sandPos.offset(0, 1, 0)
      const cactusBlock = requireLoaded(cactusPos)
      const preferredString = requireLoaded(cactusPos.offset(scaffoldOffsetX, 0, 0))
      const oppositeString = requireLoaded(cactusPos.offset(-scaffoldOffsetX, 0, 0))
      return isBlockName(sandBlock, 'sand') && isBlockName(cactusBlock, 'cactus') &&
        (isBlockName(preferredString, 'tripwire') || isBlockName(oppositeString, 'tripwire'))
    } catch {
      return false
    }
  }



  async function verifyCellPlacement (sandPos, scaffoldOffsetX) {
    if (isCellCompleted(sandPos, scaffoldOffsetX)) return true
    await sleepTicks(2)
    return isCellCompleted(sandPos, scaffoldOffsetX)
  }

  async function recoverToCheckpointState ({ origin, checkpoint }) {
    warn(`Recovery: navigating to safe platform and resuming from checkpoint layer=${checkpoint.layer}, cell=${checkpoint.cell}`)
    await moveToSafePlatform()
    if (checkpoint.layer < cfg.layers) {
      await ensureVerticalSpine(origin, checkpoint.layer)
    }
  }

  async function moveOffScaffoldIfNeeded (scaffoldPos, sandPos, scaffoldOffsetX) {
    if (!bot.entity.position.floored().equals(scaffoldPos)) return
    const candidates = [
      chooseScaffoldPos(sandPos, -scaffoldOffsetX),
      scaffoldPos.offset(0, 0, 1),
      scaffoldPos.offset(0, 0, -1),
      scaffoldPos.offset(scaffoldOffsetX, 0, 0),
      scaffoldPos.offset(-scaffoldOffsetX, 0, 0)
    ]

    for (const candidate of candidates) {
      if (candidate.equals(scaffoldPos) || !hasSolidNonSandBlockAt(candidate)) continue
      try {
        await gotoAndStand(candidate)
        return
      } catch {}
    }
  }

  async function placeCactusStack (sandPos, scaffoldOffsetX) {
    if (isCellCompleted(sandPos, scaffoldOffsetX)) return

    const scaffoldPos = chooseScaffoldPos(sandPos, scaffoldOffsetX)
    await gotoAndStand(scaffoldPos)
    const scaffoldBlock = requireLoaded(scaffoldPos)

    if (!scaffoldBlock || scaffoldBlock.boundingBox !== 'block') {
      const below = requireLoaded(scaffoldPos.offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') throw new Error(`Cannot scaffold at ${scaffoldPos}; no solid support below`)
      await placeBlockByName(scaffoldPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'cobblestone')
      const placed = await waitForBlockName(scaffoldPos, 'cobblestone')
      if (!placed || placed.boundingBox !== 'block') throw new Error(`Scaffold placement failed at ${scaffoldPos}`)
    }

    await gotoAndStand(scaffoldPos)
    await waitForClearArea(sandPos)

    const sandBase = requireLoaded(sandPos.offset(0, -1, 0))
    if (!sandBase || sandBase.boundingBox !== 'block') throw new Error(`Cannot place sand at ${sandPos}; unsupported location`)

    if (!isBlockName(requireLoaded(sandPos), 'sand')) {
      await placeBlockByName(sandPos.offset(0, -1, 0), new Vec3(0, 1, 0), 'sand')
    }
    if (!isBlockName(await waitForBlockName(sandPos, 'sand'), 'sand')) throw new Error(`Sand placement failed at ${sandPos}`)

    const cactusPos = sandPos.offset(0, 1, 0)
    await waitForClearArea(cactusPos)
    if (!isBlockName(requireLoaded(cactusPos), 'cactus')) {
      await placeBlockByName(sandPos, new Vec3(0, 1, 0), 'cactus')
      if (!isBlockName(await waitForBlockName(cactusPos, 'cactus'), 'cactus')) throw new Error(`Cactus placement failed at ${cactusPos}`)
    }

    const stringPos = cactusPos.offset(scaffoldOffsetX, 0, 0)
    await waitForClearArea(stringPos)
    if (!isBlockName(requireLoaded(stringPos), 'tripwire')) {
      await placeBlockByName(cactusPos, new Vec3(scaffoldOffsetX, 0, 0), 'string')
      if (!isBlockName(await waitForBlockName(stringPos, 'tripwire'), 'tripwire')) throw new Error(`String placement failed at ${stringPos}`)
    }

    if (cfg.removeScaffold) {
      await moveOffScaffoldIfNeeded(scaffoldPos, sandPos, scaffoldOffsetX)
      if (!bot.entity.position.floored().equals(scaffoldPos)) {
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
    if (Object.prototype.hasOwnProperty.call(defaultMove, 'allowDiagonalPathing')) defaultMove.allowDiagonalPathing = false
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
          warn('Server lag detected. Slowing placement rate.')
          lagStateLogged = true
        } else if (!lagMode && lagStateLogged) {
          log('Lag recovered. Returning to normal placement rate.')
          lagStateLogged = false
        }
      }
      lastPhysics = now
    })
  }

  function setupSafetyHooks () {
    let lastY = null
    bot.on('physicsTick', () => {
      if (isStopping || !safetyHooksArmed) return
      const y = bot.entity.position.y
      if (lastY != null && (lastY - y) > 1.01) {
        const recovered = buildController.requestRecovery(`Fall detected. drop=${(lastY - y).toFixed(2)} blocks`)
        if (!recovered) safeStop(`Fall detected. drop=${(lastY - y).toFixed(2)} blocks`)
      }
      lastY = y
    })
  }

  async function enterSurvivalFromLobby () {
    log('Waiting for lobby to finish loading...')
    await bot.waitForTicks(100)

    const initialPos = bot.entity.position.clone()
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`Sending /survival (attempt ${attempt}/3)...`)
      bot.chat('/survival')
      await bot.waitForTicks(20)

      let waitedTicks = 0
      while (waitedTicks < 220 && bot.entity.position.distanceTo(initialPos) < 5) {
        await bot.waitForTicks(10)
        waitedTicks += 10
      }

      if (bot.entity.position.distanceTo(initialPos) >= 5) {
        log('Survival transfer stage complete.')
        return
      }

      if (attempt < 3) {
        warn('Teleport not detected yet. Retrying /survival...')
        await sleepMs(1200)
      }
    }

    warn('Teleport movement not detected after retries. Continuing with fallback delay.')
    await bot.waitForTicks(100)
  }

  const buildController = createBuildController({
    cfg,
    checkpointManager,
    inventory,
    refillManager,
    buildGridTasks,
    ensureVerticalSpine,
    placeCactusStack,
    verifyCellPlacement,
    performRecovery: recoverToCheckpointState,
    onLog: entry => handleLogEntry(entry)
  })

  let buildStatus = buildController.getStatus()

  function updateBuildStatus (status) {
    buildStatus = status || buildController.getStatus()
  }

  buildController.on('progress', status => {
    updateBuildStatus(status)
    emitStatus()
  })
  buildController.on('state', status => {
    updateBuildStatus(status)
    emitStatus()
  })

  async function startBuild () {
    if (!bot || !bot.player) {
      warn('Bot is not connected yet.')
      return
    }

    try {
      await buildController.start(new Vec3(cfg.origin.x, cfg.origin.y, cfg.origin.z))
      await moveToSafePlatform()
      await bot.look(yawFromDegrees(cfg.facingYawDegrees), 0, true)
      bot.quit('[MineFarmBot] Build completed successfully')
    } catch (err) {
      await safeStop(err.message)
    }
  }

  function pauseBuild () { return buildController.pause() }
  function resumeBuild () { return buildController.resume() }
  function stopBuild () {
    const accepted = buildController.stop()
    if (accepted) safeStop('Stop requested by controller')
    return accepted
  }
  function getStatus () {
    return getStatusPayload()
  }

  function handleReconnect (reason) {
    if (isStopping || reconnectScheduled) return
    reconnectScheduled = true
    reconnectAttempts += 1
    if (reconnectWindowStartedAt == null) reconnectWindowStartedAt = Date.now()
    const baseDelay = (4000 + Math.random() * 3000) * reconnectAttempts
    const delay = Math.min(Math.floor(baseDelay), MAX_RECONNECT_DELAY)
    nextReconnectDelayMs = delay
    nextReconnectAt = Date.now() + delay
    log(`Lost connection (${reason}). Attempt ${reconnectAttempts}. Reconnecting in ${Math.floor(delay / 1000)}s`)
    setLifecycleState('reconnecting')
    setTimeout(() => {
      reconnectScheduled = false
      nextReconnectDelayMs = null
      nextReconnectAt = null
      connect()
    }, delay)
  }

  function registerBotEvents () {
    bot.once('login', () => {
      setLifecycleState('login')
      reconnectAttempts = 0
      reconnectScheduled = false
      reconnectWindowStartedAt = null
      connectionStartedAt = Date.now()
      lastUptimeMs = null
      emitStatus()
    })

    bot.once('spawn', async () => {
      setLifecycleState('spawned')
      reconnectAttempts = 0
      reconnectScheduled = false
      reconnectWindowStartedAt = null
      emitStatus()

      log('Spawned and connected. Waiting for start command...')
      setLifecycleState('stabilizing')
      log(`Config: layers=${cfg.layers}, buildDelayTicks=${cfg.buildDelayTicks}, removeScaffold=${cfg.removeScaffold}`)

      try {
        setupMovement()
        startLagMonitor()
        setupSafetyHooks()
        await enterSurvivalFromLobby()
        setLifecycleState('ready')
        resolveEasyPlacementFromPlayerPosition()
        await bot.waitForTicks(30)
        safetyHooksArmed = true

        if (!hasSolidFooting()) {
          warn('Bot spawned without solid non-sand footing. Fix position, then run start.')
        }

        if (shouldAutoStartDesktopBuild) {
          log('Desktop auto-start enabled. Starting build automatically...')
          await startBuild()
        }
      } catch (err) {
        reportError(`Startup warning: ${err.message}`)
      }
    })

    bot.on('end', () => {
      setLifecycleState('disconnected')
      log('Disconnected from server.')
      if (connectionStartedAt) lastUptimeMs = Date.now() - connectionStartedAt
      connectionStartedAt = null
      emitStatus()
      handleReconnect('end')
    })

    bot.on('kicked', reason => {
      setLifecycleState('kicked')
      reportError(`Kicked from server: ${reason}`)
      if (connectionStartedAt) lastUptimeMs = Date.now() - connectionStartedAt
      connectionStartedAt = null
      emitStatus()
      handleReconnect('kicked')
    })

    bot.on('error', err => {
      setLifecycleState('error')
      const message = formatErrorMessage(err)
      reportError(message)
      if (connectionStartedAt) lastUptimeMs = Date.now() - connectionStartedAt
      connectionStartedAt = null
      emitStatus()
      handleReconnect(`error: ${message}`)
    })
  }

  function connect () {
    setLifecycleState('connecting')
    if (bot) {
      try {
        bot.removeAllListeners()
        bot.quit('[MineFarmBot] Reinitializing connection')
      } catch {}
    }

    lastPhysics = null
    lagSamples = []
    lagMode = false
    lagStateLogged = false
    isStopping = false
    connectionStartedAt = null
    lastUptimeMs = null
    nextReconnectDelayMs = null
    nextReconnectAt = null
    reconnectWindowStartedAt = null
    safetyHooksArmed = false
    checkpointManager.resetState()
    humanizer.reset()
    refillManager.reset()

    bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      auth: cfg.auth,
      version: cfg.version === false ? undefined : cfg.version
    })

    registerBotEvents()
    bot.loadPlugin(pathfinder)
  }

  if (!statusInterval) statusInterval = setInterval(emitStatus, 1000)

  return {
    connect,
    startBuild,
    pauseBuild,
    resumeBuild,
    stopBuild,
    getStatus,
    onLog,
    onStatus,
    onWarning,
    onError
  }
}

function runCli () {
  const cfg = validateConfig(loadConfig())
  const engine = createBotEngine(cfg)
  engine.connect()
  const uiServer = startUiServer({ engine, cfg })

  function handleRuntimeFailure (kind, err) {
    const message = err && err.message ? err.message : String(err)
    console.error(`[RUNTIME] ${kind}: ${message}`)
    setTimeout(() => {
      try {
        console.log('[RUNTIME] Attempting recovery reconnect...')
        engine.connect()
      } catch (recoverErr) {
        console.error(`[RUNTIME] Recovery reconnect failed: ${recoverErr.message || recoverErr}`)
      }
    }, 3000)
  }

  process.on('unhandledRejection', reason => handleRuntimeFailure('Unhandled rejection', reason))
  process.on('uncaughtException', err => handleRuntimeFailure('Uncaught exception', err))

  const desktopMode = process.env.MINEFARMBOT_DESKTOP === '1'
  if (!desktopMode) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    console.log('[CLI] Commands: start | pause | resume | stop | status | quit')
    rl.on('line', async line => {
    const cmd = line.trim().toLowerCase()
    if (cmd === 'start') await engine.startBuild()
    else if (cmd === 'pause') engine.pauseBuild()
    else if (cmd === 'resume') engine.resumeBuild()
    else if (cmd === 'stop') engine.stopBuild()
    else if (cmd === 'status') console.log(engine.getStatus())
      else if (cmd === 'quit' || cmd === 'exit') process.exit(0)
    })
  }

  process.on('SIGINT', () => {
    uiServer.close()
    process.exit(0)
  })
}

if (require.main === module) runCli()

module.exports = {
  createBotEngine
}
