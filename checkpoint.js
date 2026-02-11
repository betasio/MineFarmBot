'use strict'

const fs = require('fs')
const path = require('path')

function createCheckpointManager (cfgLayers) {
  const checkpointPath = path.join(process.cwd(), 'build-checkpoint.json')
  const checkpointTempPath = `${checkpointPath}.tmp`

  function normalizeCheckpoint (parsed) {
    return {
      layer: Math.max(0, Math.min(cfgLayers, Math.floor(Number(parsed.layer) || 0))),
      cell: Math.max(0, Math.min(255, Math.floor(Number(parsed.cell) || 0)))
    }
  }

  function loadCheckpoint () {
    if (!fs.existsSync(checkpointPath)) {
      return { layer: 0, cell: 0 }
    }

    try {
      const raw = fs.readFileSync(checkpointPath, 'utf8')
      return normalizeCheckpoint(JSON.parse(raw))
    } catch (err) {
      console.warn(`[WARN] Failed to read checkpoint file: ${err.message}. Starting from beginning.`)
      return { layer: 0, cell: 0 }
    }
  }

  function saveCheckpoint (layer, cell) {
    const payload = JSON.stringify({ layer, cell, updatedAt: Date.now() }, null, 2)
    try {
      fs.writeFileSync(checkpointTempPath, payload, 'utf8')
      fs.renameSync(checkpointTempPath, checkpointPath)
    } catch (err) {
      console.warn(`[WARN] Failed to save checkpoint: ${err.message}`)
      try {
        if (fs.existsSync(checkpointTempPath)) fs.unlinkSync(checkpointTempPath)
      } catch {}
    }
  }

  function clearCheckpoint () {
    try {
      if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath)
      if (fs.existsSync(checkpointTempPath)) fs.unlinkSync(checkpointTempPath)
    } catch (err) {
      console.warn(`[WARN] Failed to clear checkpoint file: ${err.message}`)
    }
  }

  function resetState () {}

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
