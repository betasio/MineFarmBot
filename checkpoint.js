'use strict'

const fs = require('fs')
const path = require('path')

function createCheckpointManager (cfgLayers) {
  const checkpointPath = path.join(process.cwd(), 'build-checkpoint.json')
  let checkpointWritePending = false
  let pendingCheckpointPayload = null
  let clearCheckpointRequested = false

  function loadCheckpoint () {
    if (!fs.existsSync(checkpointPath)) {
      return { layer: 0, cell: 0 }
    }

    try {
      const raw = fs.readFileSync(checkpointPath, 'utf8')
      const parsed = JSON.parse(raw)
      return {
        layer: Math.max(0, Math.min(cfgLayers, Math.floor(Number(parsed.layer) || 0))),
        cell: Math.max(0, Math.min(255, Math.floor(Number(parsed.cell) || 0)))
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

    fs.writeFile(checkpointPath, payload, err => {
      checkpointWritePending = false
      if (err) {
        console.warn(`[WARN] Failed to save checkpoint: ${err.message}`)
      }

      if (clearCheckpointRequested) {
        if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath)
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
    if (!checkpointWritePending && fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath)
    }
  }

  function resetState () {
    checkpointWritePending = false
    pendingCheckpointPayload = null
    clearCheckpointRequested = false
  }

  function getSnapshot () {
    const exists = fs.existsSync(checkpointPath)
    if (!exists) {
      return {
        path: checkpointPath,
        exists: false,
        sizeBytes: 0,
        mtimeMs: null,
        content: null,
        parsed: null,
        pendingWrite: checkpointWritePending || pendingCheckpointPayload != null
      }
    }

    const stat = fs.statSync(checkpointPath)
    const content = fs.readFileSync(checkpointPath, 'utf8')

    let parsed = null
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = null
    }

    return {
      path: checkpointPath,
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      content,
      parsed,
      pendingWrite: checkpointWritePending || pendingCheckpointPayload != null
    }
  }

  return {
    loadCheckpoint,
    saveCheckpoint,
    clearCheckpoint,
    getSnapshot,
    resetState
  }
}

module.exports = { createCheckpointManager }
