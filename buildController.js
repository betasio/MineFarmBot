'use strict'

const { EventEmitter } = require('events')

function createBuildController ({
  cfg,
  checkpointManager,
  inventory,
  refillManager,
  buildGridTasks,
  ensureVerticalSpine,
  placeCactusStack,
  verifyCellPlacement = async () => true,
  performRecovery = async () => {},
  onLog = () => {}
}) {
  const emitter = new EventEmitter()
  let state = 'idle'
  let runPromise = null
  let stopRequested = false
  let recoveryRequested = false
  let recoveryReason = null
  let progress = {
    layer: 0,
    layersTotal: cfg.layers,
    cell: 0,
    cellsTotal: 0,
    status: 'idle'
  }
  const placementWindowMs = 60 * 1000
  let buildMetrics = {
    startedAt: null,
    lastPlacementAt: null,
    checkpointSavedAt: null,
    totalPlaced: 0,
    placementTimestamps: [],
    lastLayerCellCount: 0,
    lastCheckpointAt: null
  }

  function resetMetrics () {
    buildMetrics = {
      startedAt: Date.now(),
      lastPlacementAt: null,
      checkpointSavedAt: null,
      totalPlaced: 0,
      placementTimestamps: [],
      lastLayerCellCount: 0,
      lastCheckpointAt: null
    }
  }

  function recordPlacement () {
    const now = Date.now()
    buildMetrics.lastPlacementAt = now
    buildMetrics.totalPlaced += 1
    buildMetrics.placementTimestamps.push(now)
    const cutoff = now - placementWindowMs
    while (buildMetrics.placementTimestamps.length > 0 && buildMetrics.placementTimestamps[0] < cutoff) {
      buildMetrics.placementTimestamps.shift()
    }
  }

  function getPlacementsPerMinute () {
    if (!buildMetrics.startedAt) return 0
    const windowMinutes = placementWindowMs / 60000
    return buildMetrics.placementTimestamps.length / windowMinutes
  }

  function saveCheckpoint (layer, cell) {
    checkpointManager.saveCheckpoint(layer, cell)
    buildMetrics.checkpointSavedAt = Date.now()
  }

  function getPauseReason () {
    if (state === 'paused') return 'build paused by controller'
    if (state === 'stopping' || stopRequested) return 'stopping at next safe checkpoint'
    return null
  }

  function estimateRemainingCells () {
    if (!buildMetrics.lastLayerCellCount) return null
    const estimatedTotalCells = cfg.layers * buildMetrics.lastLayerCellCount
    const remaining = Math.max(estimatedTotalCells - buildMetrics.totalPlaced, 0)
    return { remaining, estimatedTotalCells }
  }

  function getEtaMs (placementsPerMinute) {
    const remainingInfo = estimateRemainingCells()
    if (!remainingInfo || placementsPerMinute <= 0) return null
    const minutesRemaining = remainingInfo.remaining / placementsPerMinute
    return Math.max(minutesRemaining * 60 * 1000, 0)
  }

  function emitLog (level, message) {
    const payload = { level, message, timestamp: Date.now() }
    onLog(payload)
    emitter.emit('log', payload)
  }

  function setState (nextState, statusText = nextState) {
    state = nextState
    progress = { ...progress, status: statusText }
    emitter.emit('state', getStatus())
  }

  function updateProgress (changes) {
    progress = { ...progress, ...changes }
    emitter.emit('progress', getStatus())
  }

  async function waitIfPaused () {
    while (state === 'paused') {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  function throwIfStopping () {
    if (stopRequested || state === 'stopping') {
      throw new Error('Build stop requested')
    }
  }

  function isPathfinderFailure (err) {
    const message = String(err && err.message ? err.message : '').toLowerCase()
    return message.includes('path') || message.includes('goal') || message.includes('find')
  }

  function saveCheckpoint (layer, cell) {
    checkpointManager.saveCheckpoint(layer, cell)
    buildMetrics.lastCheckpointAt = Date.now()
  }

  async function placeAndVerifyCell (task, layer, i, cellsLength) {
    const nextCell = i + 1

    try {
      await placeCactusStack(task.sandPos, task.scaffoldOffsetX)
    } catch (err) {
      if (!isPathfinderFailure(err)) throw err
      emitLog('warn', `Primary path failed at layer ${layer + 1} cell ${nextCell}. Retrying alternate route.`)
      await placeCactusStack(task.sandPos, -task.scaffoldOffsetX)
    }

    let verified = await verifyCellPlacement(task.sandPos, task.scaffoldOffsetX)
    if (!verified) {
      emitLog('warn', `Verification mismatch at layer ${layer + 1} cell ${nextCell}. Re-attempting placement once.`)
      await placeCactusStack(task.sandPos, task.scaffoldOffsetX)
      verified = await verifyCellPlacement(task.sandPos, task.scaffoldOffsetX)
    }

    if (!verified) {
      throw new Error(`Build verification failed at layer ${layer + 1} cell ${nextCell}`)
    }

    await refillManager.tryOpportunisticRefill(false)
    recordPlacement()

    updateProgress({
      cell: nextCell,
      status: `layer ${layer + 1}/${cfg.layers}, cell ${nextCell}/${cellsLength}`
    })

    if (nextCell >= cellsLength) {
      saveCheckpoint(layer + 1, 0)
    } else {
      saveCheckpoint(layer, nextCell)
    }
  }

  async function recoverToCheckpoint (origin) {
    const checkpoint = checkpointManager.loadCheckpoint()
    emitLog('warn', `Recovery triggered: ${recoveryReason || 'unspecified'}. Returning to checkpoint layer=${checkpoint.layer}, cell=${checkpoint.cell}`)
    recoveryRequested = false
    recoveryReason = null
    await performRecovery({ origin, checkpoint })
    return checkpoint
  }

  async function runBuildLoop (origin) {
    let checkpoint = checkpointManager.loadCheckpoint()
    let layer = checkpoint.layer

    while (layer < cfg.layers) {
      throwIfStopping()
      await waitIfPaused()

      if (recoveryRequested) {
        checkpoint = await recoverToCheckpoint(origin)
        layer = checkpoint.layer
        continue
      }

      const layerY = origin.y + (layer * 3)
      if (layerY > 319) {
        const err = new Error(`Y limit exceeded at layer ${layer + 1} (targetY=${layerY})`)
        err.code = 'BUILD_LIMIT'
        throw err
      }

      updateProgress({
        layer: layer + 1,
        layersTotal: cfg.layers,
        cell: 0,
        status: `layer ${layer + 1}/${cfg.layers}`
      })
      emitLog('info', `Starting layer ${layer + 1}/${cfg.layers}`)

      await ensureVerticalSpine(origin, layer)
      inventory.requireCobblestoneForLayer(layer)
      const cells = buildGridTasks(origin, layer)
      buildMetrics.lastLayerCellCount = cells.length

      const startCell = (layer === checkpoint.layer) ? checkpoint.cell : 0
      updateProgress({ cellsTotal: cells.length, cell: startCell })
      await refillManager.ensureInventoryForRemaining(cells.length - startCell)

      let recovered = false
      for (let i = startCell; i < cells.length; i++) {
        throwIfStopping()
        await waitIfPaused()

        if (recoveryRequested) {
          checkpoint = await recoverToCheckpoint(origin)
          layer = checkpoint.layer
          recovered = true
          break
        }

        const remaining = cells.length - i
        if (remaining % 16 === 0) {
          await refillManager.ensureInventoryForRemaining(remaining)
        }

        const task = cells[i]
        await placeAndVerifyCell(task, layer, i, cells.length)
      }

      if (recovered) continue

      layer += 1
      checkpoint = { layer, cell: 0 }
    }

    checkpointManager.clearCheckpoint()
  }

  async function start (origin) {
    if (state === 'running' || state === 'paused') {
      emitLog('warn', 'Build is already active')
      return runPromise
    }

    stopRequested = false
    recoveryRequested = false
    recoveryReason = null
    resetMetrics()
    setState('running', 'running')

    runPromise = (async () => {
      try {
        await runBuildLoop(origin)
        setState('idle', 'completed')
        emitLog('info', 'Build completed successfully')
        emitter.emit('completed', getStatus())
      } catch (err) {
        if (stopRequested || state === 'stopping') {
          setState('idle', 'stopped')
          emitLog('warn', 'Build stopped by request')
          emitter.emit('stopped', getStatus())
          return
        }

        setState('idle', 'error')
        emitLog('error', err.message)
        emitter.emit('buildError', err)
        throw err
      } finally {
        runPromise = null
      }
    })()

    return runPromise
  }

  function pause () {
    if (state !== 'running') return false
    setState('paused', 'paused')
    emitLog('info', 'Build paused')
    return true
  }

  function resume () {
    if (state !== 'paused') return false
    setState('running', 'running')
    emitLog('info', 'Build resumed')
    return true
  }

  function stop () {
    if (state !== 'running' && state !== 'paused') return false
    stopRequested = true
    setState('stopping', 'stopping')
    emitLog('warn', 'Stopping build at next safe checkpoint')
    return true
  }

  function requestRecovery (reason = 'requested') {
    if (state !== 'running' && state !== 'paused') return false
    recoveryRequested = true
    recoveryReason = reason
    emitLog('warn', `Recovery requested: ${reason}`)
    return true
  }

  function getStatus () {
    const placementsPerMinute = getPlacementsPerMinute()
    const blocksPerHour = placementsPerMinute * 60
    const remainingInfo = estimateRemainingCells()
    const etaMs = getEtaMs(placementsPerMinute)
    const pauseReason = getPauseReason()
    return {
      state,
      stopRequested,
      recoveryRequested,
      recoveryReason,
      ...progress,
      metrics: {
        placementsPerMinute,
        blocksPerHour,
        etaMs,
        totalPlaced: buildMetrics.totalPlaced,
        estimatedTotalCells: remainingInfo ? remainingInfo.estimatedTotalCells : null,
        remainingCells: remainingInfo ? remainingInfo.remaining : null,
        startedAt: buildMetrics.startedAt,
        lastPlacementAt: buildMetrics.lastPlacementAt,
        lastCheckpointAt: buildMetrics.lastCheckpointAt
      }
    }
  }

  return {
    start,
    pause,
    resume,
    stop,
    requestRecovery,
    getStatus,
    on: (...args) => emitter.on(...args)
  }
}

module.exports = {
  createBuildController
}
