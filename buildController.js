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
  onLog = () => {}
}) {
  const emitter = new EventEmitter()
  let state = 'idle'
  let runPromise = null
  let stopRequested = false
  let progress = {
    layer: 0,
    layersTotal: cfg.layers,
    cell: 0,
    cellsTotal: 0,
    status: 'idle'
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

  async function runBuildLoop (origin) {
    const checkpoint = checkpointManager.loadCheckpoint()

    for (let layer = checkpoint.layer; layer < cfg.layers; layer++) {
      throwIfStopping()
      await waitIfPaused()

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
      const startCell = layer === checkpoint.layer ? checkpoint.cell : 0
      const remainingFromStart = cells.length - startCell
      updateProgress({ cellsTotal: cells.length, cell: startCell })
      await refillManager.ensureInventoryForRemaining(remainingFromStart)

      for (let i = startCell; i < cells.length; i++) {
        throwIfStopping()
        await waitIfPaused()

        const remaining = cells.length - i
        if (remaining % 16 === 0) {
          await refillManager.ensureInventoryForRemaining(remaining)
        }

        const task = cells[i]
        await placeCactusStack(task.sandPos, task.scaffoldOffsetX)
        await refillManager.tryOpportunisticRefill(false)

        const nextCell = i + 1
        updateProgress({
          cell: nextCell,
          status: `layer ${layer + 1}/${cfg.layers}, cell ${nextCell}/${cells.length}`
        })

        if (nextCell % 16 === 0) {
          if (nextCell >= cells.length) {
            checkpointManager.saveCheckpoint(layer + 1, 0)
          } else {
            checkpointManager.saveCheckpoint(layer, nextCell)
          }
        }
      }
    }

    checkpointManager.clearCheckpoint()
  }

  async function start (origin) {
    if (state === 'running' || state === 'paused') {
      emitLog('warn', 'Build is already active')
      return runPromise
    }

    stopRequested = false
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

  function getStatus () {
    return {
      state,
      stopRequested,
      ...progress
    }
  }

  return {
    start,
    pause,
    resume,
    stop,
    getStatus,
    on: (...args) => emitter.on(...args)
  }
}

module.exports = {
  createBuildController
}
