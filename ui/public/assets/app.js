'use strict'

const MAX_LOGS = 1000
const lowThresholdDefaults = { sand: 64, cactus: 64, string: 64, cobblestone: 128 }

const els = {
  toast: document.getElementById('toast'),
  serverMeta: document.getElementById('server-meta'),
  alertBar: document.getElementById('alert-bar'),
  alertBarTitle: document.getElementById('alert-bar-title'),
  alertBarMessage: document.getElementById('alert-bar-message'),
  alertBarAck: document.getElementById('alert-bar-ack'),
  connectionBadge: document.getElementById('connection-badge'),
  pingValue: document.getElementById('ping-value'),
  lagValue: document.getElementById('lag-value'),
  reconnectValue: document.getElementById('reconnect-value'),
  reconnectCountdown: document.getElementById('reconnect-countdown'),
  uptimeValue: document.getElementById('uptime-value'),
  layerValue: document.getElementById('layer-value'),
  cellValue: document.getElementById('cell-value'),
  buildState: document.getElementById('build-state'),
  progressFill: document.getElementById('progress-fill'),
  etaValue: document.getElementById('eta-value'),
  ppmValue: document.getElementById('ppm-value'),
  checkpointValue: document.getElementById('checkpoint-value'),
  lastPlacementAgeValue: document.getElementById('last-placement-age'),
  checkpointAgeValue: document.getElementById('checkpoint-age-value'),
  coordValue: document.getElementById('coord-value'),
  dimensionValue: document.getElementById('dimension-value'),
  botModeValue: document.getElementById('bot-mode-value'),
  pauseReasonValue: document.getElementById('pause-reason-value'),
  movementValue: document.getElementById('movement-value'),
  lookAtValue: document.getElementById('look-at-value'),
  lastActionAge: document.getElementById('last-action-age'),
  logFeed: document.getElementById('log-feed'),
  materialsPanel: document.getElementById('materials-panel'),
  refillTime: document.getElementById('refill-time'),
  refillContainer: document.getElementById('refill-container'),
  refillStatus: document.getElementById('refill-status'),
  errorSound: document.getElementById('error-sound'),
  pauseScrollBtn: document.getElementById('pause-scroll-btn'),
  clearLogBtn: document.getElementById('clear-log-btn'),
  exportLogBtn: document.getElementById('export-log-btn'),
  copyErrorBtn: document.getElementById('copy-error-btn'),
  filterInfo: document.getElementById('filter-info'),
  filterAction: document.getElementById('filter-action'),
  filterWarn: document.getElementById('filter-warn'),
  filterError: document.getElementById('filter-error'),
  logSearch: document.getElementById('log-search'),
  holdStopToggle: document.getElementById('hold-stop-toggle'),
  commandResult: document.getElementById('command-result')
}

const state = {
  autoScroll: true,
  statusSnapshot: null,
  logEntries: [],
  lastError: '',
  lastActionAt: null,
  updateTicker: null,
  eventStream: null,
  controlsInFlight: false,
  toastTimer: null,
  alertConditions: {},
  conditionMeta: {
    disconnected: { severity: 'error', priority: 100, sticky: true },
    reconnecting: { severity: 'warning', priority: 80 },
    lowMaterialHardStop: { severity: 'error', priority: 90, sticky: true },
    repeatedPathErrors: { severity: 'warning', priority: 70 },
    sseWarning: { severity: 'warning', priority: 60 },
    sseError: { severity: 'error', priority: 95, sticky: true }
  },
  previousConnectionState: null,
  pathErrorWindowMs: 4 * 60 * 1000,
  pathErrorTimestamps: [],
  repeatedPathThreshold: 3,
  logFilters: {
    info: true,
    action: true,
    warn: true,
    error: true
  },
  logSearchTerm: '',
  holdStopEnabled: true,
  holdStopTimer: null,
  pendingHoldAction: null,
  commandResult: { state: 'idle', message: 'No command sent yet.' }
}

const CONTROL_ACTIONS = new Set(['start', 'pause', 'resume', 'stop', 'reconnect', 'force_refill', 'return_home', 'open_checkpoint'])

const HOLD_TO_CONFIRM_MS = 900
const COMMAND_RESULT_STATES = new Set(['idle', 'pending', 'success', 'failure'])

function isBuildActive (snapshot = state.statusSnapshot) {
  const build = (snapshot && snapshot.build) || {}
  const buildState = String(build.state || build.status || '').toLowerCase()
  return buildState === 'running' || buildState === 'paused' || buildState === 'stopping' || Boolean(build.stopRequested)
}

function getConfirmationRequirement (action) {
  const status = state.statusSnapshot || {}
  const buildActive = isBuildActive(status)

  if (action === 'start' && buildActive) {
    return {
      type: 'confirm',
      message: 'Build is already active. Send START anyway?'
    }
  }

  if (action === 'stop' && buildActive) {
    return state.holdStopEnabled
      ? {
          type: 'hold',
          message: `Hold SAFE STOP for ${Math.round(HOLD_TO_CONFIRM_MS / 100) / 10}s to confirm.`
        }
      : {
          type: 'confirm',
          message: 'SAFE STOP will halt the active build at the next safe checkpoint. Continue?'
        }
  }

  if (action === 'reconnect' && buildActive) {
    return {
      type: 'confirm',
      message: 'Reconnect during active build can interrupt placement. Continue?'
    }
  }

  return null
}

function renderCommandResult () {
  if (!els.commandResult) return
  const info = state.commandResult || { state: 'idle', message: 'No command sent yet.' }
  const resultState = COMMAND_RESULT_STATES.has(info.state) ? info.state : 'idle'
  els.commandResult.className = `command-result ${resultState}`
  els.commandResult.textContent = info.message || 'No command sent yet.'
}

function setCommandResult (resultState, message) {
  state.commandResult = {
    state: COMMAND_RESULT_STATES.has(resultState) ? resultState : 'idle',
    message: String(message || '').trim() || 'No command sent yet.'
  }
  renderCommandResult()
}

function cancelHoldToConfirm () {
  if (state.holdStopTimer) {
    clearTimeout(state.holdStopTimer)
    state.holdStopTimer = null
  }
  state.pendingHoldAction = null
}


function buildAlertCondition (key, message, overrides = {}) {
  const base = state.conditionMeta[key] || {}
  return {
    key,
    message,
    severity: overrides.severity || base.severity || 'info',
    priority: overrides.priority ?? base.priority ?? 10,
    sticky: overrides.sticky ?? Boolean(base.sticky),
    acknowledged: false
  }
}

function setAlertCondition (key, message, overrides = {}) {
  state.alertConditions[key] = buildAlertCondition(key, message, overrides)
  renderAlertBar()
}

function clearAlertCondition (key) {
  if (!state.alertConditions[key]) return
  delete state.alertConditions[key]
  renderAlertBar()
}

function acknowledgeCurrentAlert () {
  const active = getHighestPriorityAlert()
  if (!active) return
  if (!active.sticky) {
    clearAlertCondition(active.key)
    return
  }

  state.alertConditions[active.key] = { ...active, acknowledged: true }
  renderAlertBar()
}

function getHighestPriorityAlert () {
  const active = Object.values(state.alertConditions).filter(item => item && (!item.sticky || !item.acknowledged))
  if (active.length === 0) return null

  active.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const rank = { error: 3, warning: 2, info: 1 }
    return (rank[b.severity] || 0) - (rank[a.severity] || 0)
  })

  return active[0]
}

function renderAlertBar () {
  if (!els.alertBar || !els.alertBarMessage || !els.alertBarTitle || !els.alertBarAck) return

  const active = getHighestPriorityAlert()
  if (!active) {
    els.alertBar.className = 'alert-bar hidden'
    els.alertBarTitle.textContent = 'Info'
    els.alertBarMessage.textContent = ''
    els.alertBarAck.classList.add('hidden')
    return
  }

  els.alertBar.className = `alert-bar ${active.severity}`
  els.alertBarTitle.textContent = active.severity.toUpperCase()
  els.alertBarMessage.textContent = active.message
  if (active.sticky) {
    els.alertBarAck.classList.remove('hidden')
    els.alertBarAck.textContent = 'Acknowledge'
  } else {
    els.alertBarAck.classList.add('hidden')
  }
}

function shouldTrackPathError (message) {
  const text = String(message || '').toLowerCase()
  return text.includes('path') || text.includes('goal') || text.includes('stuck')
}

function updateRepeatedPathAlert (message) {
  if (!shouldTrackPathError(message)) return

  const now = Date.now()
  state.pathErrorTimestamps = state.pathErrorTimestamps.filter(ts => (now - ts) <= state.pathErrorWindowMs)
  state.pathErrorTimestamps.push(now)

  if (state.pathErrorTimestamps.length >= state.repeatedPathThreshold) {
    setAlertCondition('repeatedPathErrors', 'Repeated pathing failures detected. Check for obstructions and bot footing.')
  }
}

function mapIncomingAlertFromEvent (payload) {
  const message = String(payload && payload.message ? payload.message : '')
  const lower = message.toLowerCase()

  if (lower.includes('materials low')) {
    setAlertCondition('lowMaterialHardStop', 'Low materials detected. Build is blocked until refill succeeds.')
  }

  if (lower.includes('build stopped') || lower.includes('stopped by request')) {
    clearAlertCondition('lowMaterialHardStop')
  }

  updateRepeatedPathAlert(message)
}

function formatDuration (ms) {
  if (ms == null || Number.isNaN(ms)) return '--'
  const totalSec = Math.max(Math.floor(ms / 1000), 0)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatTime (ts) {
  if (!ts) return '--'
  return new Date(ts).toLocaleTimeString()
}

function formatAge (ts) {
  if (!ts) return '--'
  return `${formatDuration(Date.now() - ts)} ago`
}

function levelOf (entry) {
  const rawLevel = String(entry.level || '').toLowerCase()
  const message = String(entry.message || '').toLowerCase()

  if (rawLevel === 'error' || rawLevel === 'warn' || rawLevel === 'info' || rawLevel === 'action') {
    return rawLevel
  }

  const action = String(entry.action || '').toLowerCase()
  if (CONTROL_ACTIONS.has(action)) return 'action'

  if (message.includes('control action accepted:')) {
    const acceptedAction = message.split('control action accepted:')[1].trim()
    if (CONTROL_ACTIONS.has(acceptedAction)) return 'action'
  }

  if (CONTROL_ACTIONS.has(message)) return 'action'

  return 'info'
}

function shouldRenderLogEntry (entry) {
  if (!state.logFilters[entry.level]) return false
  if (!state.logSearchTerm) return true
  return entry.message.toLowerCase().includes(state.logSearchTerm)
}

function createLogLineElement (entry) {
  const line = document.createElement('p')
  line.className = `log-line ${entry.level}`
  line.textContent = `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level.toUpperCase()}] ${entry.message}`
  return line
}

function renderLogFeed () {
  const fragment = document.createDocumentFragment()

  for (const entry of state.logEntries) {
    if (!shouldRenderLogEntry(entry)) continue
    fragment.appendChild(createLogLineElement(entry))
  }

  els.logFeed.replaceChildren(fragment)

  if (state.autoScroll) {
    els.logFeed.scrollTop = els.logFeed.scrollHeight
  }
}

function showToast (message) {
  if (!els.toast) return
  if (state.toastTimer) {
    clearTimeout(state.toastTimer)
    state.toastTimer = null
  }

  els.toast.textContent = message
  els.toast.classList.add('show')
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('show')
    state.toastTimer = null
  }, 2500)
}

function setControlButtonsDisabled (disabled) {
  state.controlsInFlight = disabled
  for (const btn of document.querySelectorAll('[data-action]')) {
    if (disabled) {
      btn.dataset.prevLabel = btn.textContent
      if (state.pendingHoldAction === btn.getAttribute('data-action')) {
        btn.textContent = '⏳ Sending...'
      }
    } else if (btn.dataset.prevLabel) {
      btn.textContent = btn.dataset.prevLabel
      delete btn.dataset.prevLabel
    }
    btn.disabled = disabled
  }
}

function appendLog (entry) {
  const payload = {
    level: levelOf(entry),
    message: String(entry.message || ''),
    timestamp: entry.timestamp || Date.now(),
    action: entry.action
  }

  state.logEntries.push(payload)
  if (state.logEntries.length > MAX_LOGS) {
    state.logEntries.shift()
  }

  renderLogFeed()
}

function formatLookAt (lookAt) {
  if (!lookAt || typeof lookAt !== 'object') return '--'
  const name = lookAt.name || 'unknown'
  const type = lookAt.type || 'target'
  const pos = lookAt.position
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
    return `${type}: ${name}`
  }
  return `${type}: ${name} @ ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`
}

function formatMovement (movement) {
  if (!movement || typeof movement !== 'object') return '--'
  const onGround = typeof movement.onGround === 'boolean' ? (movement.onGround ? 'yes' : 'no') : '--'
  const velocityY = typeof movement.velocityY === 'number' ? movement.velocityY.toFixed(3) : '--'
  const falling = typeof movement.isFalling === 'boolean' ? (movement.isFalling ? 'yes' : 'no') : '--'
  return `ground=${onGround}, vY=${velocityY}, falling=${falling}`
}

function renderMaterials (inventory = {}, refill = {}) {
  const thresholds = refill.thresholds || lowThresholdDefaults
  const lowFlags = refill.low || {}
  const keys = ['sand', 'cactus', 'string', 'cobblestone']
  const fragment = document.createDocumentFragment()

  for (const key of keys) {
    const value = Number(inventory[key] || 0)
    const threshold = Number(thresholds[key] || lowThresholdDefaults[key] || 1)
    const fillPct = Math.min((value / Math.max(threshold * 2, 1)) * 100, 100)

    const row = document.createElement('div')
    row.className = 'material-row'

    const isLow = Boolean(lowFlags[key]) || value <= threshold
    const isEmpty = value <= 0
    if (isLow) row.classList.add('low-highlight')
    if (isEmpty) row.classList.add('empty-highlight')

    row.innerHTML = [
      '<div class="material-head">',
      `<span>${key[0].toUpperCase() + key.slice(1)}</span>`,
      `<strong>${value}${isLow ? ' <span class="low">LOW</span>' : ''}</strong>`,
      '</div>',
      `<div class="material-bar"><div class="material-fill" style="width:${fillPct}%"></div></div>`
    ].join('')

    fragment.appendChild(row)
  }

  els.materialsPanel.replaceChildren(fragment)
}

function renderDynamicTimeFields () {
  const status = state.statusSnapshot
  if (!status) return

  if (status.reconnectAt) {
    els.reconnectCountdown.textContent = formatDuration(Math.max(status.reconnectAt - Date.now(), 0))
  } else {
    els.reconnectCountdown.textContent = '--'
  }

  if (state.lastActionAt) {
    els.lastActionAge.textContent = `${formatDuration(Date.now() - state.lastActionAt)} ago`
  } else {
    els.lastActionAge.textContent = '--'
  }
}

function updateUiStateClasses (connectionState, buildState, refill = {}) {
  const root = document.documentElement
  const body = document.body
  if (!root || !body) return

  const states = ['online', 'reconnecting', 'offline']
  for (const stateName of states) {
    const className = `connection-${stateName}`
    const shouldEnable = connectionState === stateName
    root.classList.toggle(className, shouldEnable)
    body.classList.toggle(className, shouldEnable)
  }

  const normalizedBuildState = String(buildState || '').toLowerCase()
  const amberMode = normalizedBuildState === 'paused' || normalizedBuildState === 'stopping'
  root.classList.toggle('app-amber-mode', amberMode)
  body.classList.toggle('app-amber-mode', amberMode)

  const lowFlags = refill.low || {}
  const hasLowMaterials = Object.values(lowFlags).some(Boolean)
  const hasEmptyMaterials = Object.keys(lowFlags).some(key => lowFlags[key] && Number((state.statusSnapshot && state.statusSnapshot.inventory && state.statusSnapshot.inventory[key]) || 0) <= 0)
  root.classList.toggle('materials-low', hasLowMaterials)
  body.classList.toggle('materials-low', hasLowMaterials)
  root.classList.toggle('materials-empty', hasEmptyMaterials)
  body.classList.toggle('materials-empty', hasEmptyMaterials)
}

function updateStatus (status) {
  state.statusSnapshot = status

  const previousConnectionState = state.previousConnectionState
  const connectionState = status.connectionState || 'offline'

  if (connectionState === 'offline') {
    setAlertCondition('disconnected', 'Disconnected from server. Bot operations are paused until reconnection succeeds.')
    clearAlertCondition('reconnecting')
  } else if (connectionState === 'reconnecting') {
    setAlertCondition('reconnecting', 'Reconnecting to server. Monitoring and controls remain available.')
    clearAlertCondition('disconnected')
  } else if (connectionState === 'online') {
    if (previousConnectionState && previousConnectionState !== 'online') {
      clearAlertCondition('disconnected')
      clearAlertCondition('reconnecting')
      clearAlertCondition('sseError')
      clearAlertCondition('sseWarning')
    }
  }
  state.previousConnectionState = connectionState

  const build = status.build || {}
  if (!isBuildActive(status)) cancelHoldToConfirm()
  const buildStatusText = String(build.status || build.state || '').toLowerCase()
  updateUiStateClasses(connectionState, build.state || build.status, status.refill || {})
  if (buildStatusText === 'error') {
    setAlertCondition('sseError', 'Build entered an error state. Review latest errors in the log.', { sticky: true })
  }

  const refill = status.refill || {}
  if (refill.needsRefill && connectionState !== 'online') {
    setAlertCondition('lowMaterialHardStop', 'Low materials plus connection loss detected. Refill and reconnect required before resuming.')
  }

  const connectionCss = ['online', 'reconnecting', 'offline'].includes(connectionState) ? connectionState : 'offline'
  els.connectionBadge.textContent = connectionState.toUpperCase()
  els.connectionBadge.className = `badge ${connectionCss}`

  els.serverMeta.textContent = `Server: ${status.host}:${status.port} | Bot: ${status.username}`
  els.pingValue.textContent = typeof status.ping === 'number' ? `${status.ping} ms` : '--'
  els.lagValue.textContent = status.lagMode ? 'ON' : 'OFF'
  els.reconnectValue.textContent = `${status.reconnectAttempts || 0}`
  els.uptimeValue.textContent = formatDuration(status.uptimeMs)

  const metrics = build.metrics || {}
  const layer = Number(build.layer || 0)
  const layersTotal = Number(build.layersTotal || 0)
  const cell = Number(build.cell || 0)
  const cellsTotal = Number(build.cellsTotal || 0)

  els.layerValue.textContent = `${layer} / ${layersTotal}`
  els.cellValue.textContent = `${cell} / ${cellsTotal}`
  els.buildState.textContent = String(build.status || build.state || 'idle').toUpperCase()
  els.ppmValue.textContent = `${Math.round(Number(metrics.blocksPerHour || 0))} blocks/hour`
  els.etaValue.textContent = formatDuration(metrics.etaMs)
  els.checkpointValue.textContent = `Layer ${layer}, Cell ${cell}`

  const done = Number(metrics.totalPlaced || 0)
  const estimatedTotal = Number(metrics.estimatedTotalCells || (layersTotal * cellsTotal) || 0)
  const progressPct = estimatedTotal > 0 ? Math.min((done / estimatedTotal) * 100, 100) : 0
  els.progressFill.style.width = `${progressPct.toFixed(1)}%`
  const progressBar = els.progressFill.parentElement
  if (progressBar) progressBar.setAttribute('aria-valuenow', progressPct.toFixed(0))

  if (status.coordinates) {
    els.coordValue.textContent = `${status.coordinates.x.toFixed(1)}, ${status.coordinates.y.toFixed(1)}, ${status.coordinates.z.toFixed(1)}`
  } else {
    els.coordValue.textContent = '--'
  }

  els.dimensionValue.textContent = status.dimension || '--'
  els.botModeValue.textContent = String(status.botMode || 'idle').toUpperCase()
  const pauseReason = build.pauseReason || status.pauseReason || '--'
  const isPausedOrStopping = build.state === 'paused' || build.state === 'stopping' || build.stopRequested
  if (isPausedOrStopping && pauseReason !== '--') {
    const badge = document.createElement('span')
    badge.className = 'badge pause-reason'
    badge.textContent = pauseReason
    els.pauseReasonValue.replaceChildren(badge)
  } else {
    els.pauseReasonValue.textContent = pauseReason
  }
  els.movementValue.textContent = formatMovement(status.movement)
  els.lookAtValue.textContent = formatLookAt(status.lookAt)

  const lastPlacementAge = formatAge(metrics.lastSuccessfulPlacementAt)
  const checkpointAge = formatAge(metrics.checkpointSavedAt)
  els.lastPlacementAgeValue.textContent = lastPlacementAge === '--' ? '--' : `last placement ${lastPlacementAge}`
  els.checkpointAgeValue.textContent = checkpointAge === '--' ? '--' : `checkpoint age ${checkpointAge}`

  renderMaterials(status.inventory || {}, status.refill || {})

  els.refillStatus.textContent = (refill.needsRefill ? 'NEEDS REFILL' : 'OK')
  const container = refill.lastRefillContainer
  els.refillContainer.textContent = container
    ? `${container.name} @ ${container.position.x},${container.position.y},${container.position.z}`
    : '--'
  els.refillTime.textContent = formatTime(refill.lastRefillSuccessAtMs)

  renderDynamicTimeFields()
}

async function sendControl (action) {
  if (state.controlsInFlight) return

  const requirement = getConfirmationRequirement(action)
  if (requirement && requirement.type === 'confirm' && !window.confirm(requirement.message)) {
    setCommandResult('idle', `Cancelled ${String(action || '').toUpperCase()} command.`)
    return
  }

  setControlButtonsDisabled(true)
  setCommandResult('pending', `Sending ${String(action || '').toUpperCase()}...`)

  try {
    const result = await fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    })

    const payload = await result.json().catch(() => ({}))
    if (!result.ok || payload.ok === false) {
      const structuredError = payload && payload.error && payload.error.message
        ? payload.error.message
        : payload.error
      throw new Error(structuredError || `Action failed: ${action}`)
    }

    state.lastActionAt = Date.now()
    const actionMessage = payload && payload.message ? payload.message : `Control action accepted: ${action}`
    appendLog({ level: 'action', action, message: actionMessage, timestamp: Date.now(), data: payload.data || null })
    setCommandResult('success', `${String(action || '').toUpperCase()}: ${actionMessage}`)

    if (action === 'open_checkpoint' && payload.data && payload.data.checkpoint) {
      const checkpoint = payload.data.checkpoint
      const contentSummary = checkpoint.exists
        ? `Checkpoint file: ${checkpoint.path} (${checkpoint.sizeBytes} bytes)`
        : `Checkpoint file not found at ${checkpoint.path}`
      appendLog({ level: 'info', message: contentSummary, timestamp: Date.now() })
      if (checkpoint.exists && checkpoint.content) {
        appendLog({ level: 'info', message: `Checkpoint content: ${checkpoint.content}`, timestamp: Date.now() })
      }
    }

    showToast(payload && payload.message ? payload.message : `Action sent: ${action.toUpperCase()}`)
  } catch (err) {
    setCommandResult('failure', `${String(action || '').toUpperCase()} failed: ${err.message}`)
    throw err
  } finally {
    setControlButtonsDisabled(false)
  }
}

function exportLogs () {
  const blob = new Blob([JSON.stringify(state.logEntries, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `minefarmbot-log-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(link.href)
}

async function copyLastError () {
  if (!state.lastError) {
    showToast('No error to copy yet.')
    return
  }

  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    appendLog({ level: 'warn', message: 'Clipboard API unavailable in this browser context.', timestamp: Date.now() })
    return
  }

  await navigator.clipboard.writeText(state.lastError)
  appendLog({ level: 'info', message: 'Copied last error to clipboard', timestamp: Date.now() })
  showToast('Copied last error.')
}

function setupControls () {
  const actionButtons = document.querySelectorAll('[data-action]')
  for (const btn of actionButtons) {
    const action = btn.getAttribute('data-action')

    if (action === 'stop') {
      const startHold = () => {
        const requirement = getConfirmationRequirement(action)
        if (!requirement || requirement.type !== 'hold') return
        if (state.controlsInFlight) return

        cancelHoldToConfirm()
        state.pendingHoldAction = action
        btn.dataset.prevLabel = btn.textContent
        btn.textContent = 'Hold…'
        setCommandResult('pending', requirement.message)

        state.holdStopTimer = setTimeout(() => {
          state.holdStopTimer = null
          if (state.pendingHoldAction !== action) return
          sendControl(action).catch(err => {
            state.lastError = err.message
            appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
            showToast(err.message)
          }).finally(() => {
            cancelHoldToConfirm()
          })
        }, HOLD_TO_CONFIRM_MS)
      }

      const cancelHold = (restoreLabel = true) => {
        if (state.pendingHoldAction !== action) return
        if (!state.holdStopTimer) return
        cancelHoldToConfirm()
        if (restoreLabel && btn.dataset.prevLabel) {
          btn.textContent = btn.dataset.prevLabel
          delete btn.dataset.prevLabel
        }
        setCommandResult('idle', 'SAFE STOP hold cancelled.')
      }

      btn.addEventListener('pointerdown', startHold)
      btn.addEventListener('pointerup', () => cancelHold(true))
      btn.addEventListener('pointerleave', () => cancelHold(true))
      btn.addEventListener('pointercancel', () => cancelHold(true))
      btn.addEventListener('click', async (event) => {
        const requirement = getConfirmationRequirement(action)
        if (requirement && requirement.type === 'hold') {
          event.preventDefault()
          return
        }
        try {
          await sendControl(action)
        } catch (err) {
          state.lastError = err.message
          appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
          showToast(err.message)
        }
      })
      continue
    }

    btn.addEventListener('click', async () => {
      try {
        await sendControl(action)
      } catch (err) {
        state.lastError = err.message
        appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
        showToast(err.message)
      }
    })
  }

  els.pauseScrollBtn.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll
    els.pauseScrollBtn.textContent = state.autoScroll ? 'Pause Scroll' : 'Resume Scroll'
  })

  els.clearLogBtn.addEventListener('click', () => {
    state.logEntries = []
    renderLogFeed()
    showToast('Log cleared.')
  })

  for (const [level, input] of Object.entries({
    info: els.filterInfo,
    action: els.filterAction,
    warn: els.filterWarn,
    error: els.filterError
  })) {
    if (!input) continue
    input.addEventListener('change', () => {
      state.logFilters[level] = input.checked
      renderLogFeed()
    })
  }

  if (els.logSearch) {
    els.logSearch.addEventListener('input', () => {
      state.logSearchTerm = els.logSearch.value.trim().toLowerCase()
      renderLogFeed()
    })
  }

  if (els.holdStopToggle) {
    state.holdStopEnabled = els.holdStopToggle.checked
    els.holdStopToggle.addEventListener('change', () => {
      state.holdStopEnabled = els.holdStopToggle.checked
      cancelHoldToConfirm()
      setCommandResult('idle', state.holdStopEnabled
        ? 'SAFE STOP now requires hold while build is active.'
        : 'SAFE STOP hold-to-confirm disabled.')
    })
  }

  els.exportLogBtn.addEventListener('click', exportLogs)
  els.copyErrorBtn.addEventListener('click', () => copyLastError().catch(() => {}))
  els.alertBarAck.addEventListener('click', acknowledgeCurrentAlert)
}


function onErrorEvent (payload) {
  state.lastError = payload.message || 'Unknown error'
  appendLog(payload)
  mapIncomingAlertFromEvent(payload)
  els.errorSound.play().catch(() => {})

  if (window.Notification && Notification.permission === 'granted') {
    new Notification('MineFarmBot Error', { body: state.lastError })
  }
}

function teardownEventStream () {
  if (state.eventStream) {
    state.eventStream.close()
    state.eventStream = null
  }
}

function setupEventStream () {
  teardownEventStream()

  const stream = new EventSource('/events')
  state.eventStream = stream

  stream.addEventListener('status', event => updateStatus(JSON.parse(event.data)))
  stream.addEventListener('log', event => appendLog(JSON.parse(event.data)))
  stream.addEventListener('warning', event => {
    const payload = JSON.parse(event.data)
    appendLog(payload)
    mapIncomingAlertFromEvent(payload)
    setAlertCondition('sseWarning', payload.message || 'Warning received from bot.')
  })
  stream.addEventListener('error', event => {
    const payload = JSON.parse(event.data)
    onErrorEvent(payload)
    setAlertCondition('sseError', payload.message || 'Error received from bot.', { sticky: true })
  })

  stream.onerror = () => {
    const payload = { level: 'warn', message: 'Event stream interrupted. Browser will retry automatically.', timestamp: Date.now() }
    appendLog(payload)
    setAlertCondition('reconnecting', 'Live updates interrupted. Browser will retry event stream automatically.')
  }
}

async function init () {
  setupControls()
  renderCommandResult()

  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }

  const status = await fetch('/status', { cache: 'no-store' }).then(r => r.json())
  updateStatus(status)
  setupEventStream()

  state.updateTicker = setInterval(renderDynamicTimeFields, 1000)

  window.addEventListener('beforeunload', () => {
    if (state.updateTicker) clearInterval(state.updateTicker)
    if (state.toastTimer) clearTimeout(state.toastTimer)
    teardownEventStream()
  })
}

init().catch(err => {
  state.lastError = err.message
  appendLog({ level: 'error', message: err.message, timestamp: Date.now() })
  showToast(err.message)
})
