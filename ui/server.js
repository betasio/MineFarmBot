'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const { loadConfig, validateConfig, resolveConfigPath } = require('../config')

const MAX_CONTROL_PAYLOAD_BYTES = 4096
const SSE_HEARTBEAT_MS = 15000
const BASE_REQUIRED_CONFIG_FIELDS = [
  'host',
  'port',
  'auth'
]

const MANUAL_PLACEMENT_REQUIRED_FIELDS = [
  'manualCornerA.x',
  'manualCornerA.y',
  'manualCornerA.z',
  'manualCornerB.x',
  'manualCornerB.y',
  'manualCornerB.z'
]

function formatSse (event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function jsonResponse (res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
function normalizeOddFarmSize (value, fallback = 9) {
  let size = Math.floor(Number(value))
  if (!Number.isFinite(size)) size = fallback
  size = Math.max(3, Math.min(63, size))
  if (size % 2 === 0) size += 1
  if (size > 63) size = 63
  return size
}

=======
>>>>>>> main
function getByPath (obj, pathStr) {
  return pathStr.split('.').reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj)
}

function getRequiredFields (config) {
  const placementMode = String((config && config.placementMode) || 'manual').toLowerCase()
  return placementMode === 'easy'
    ? [...BASE_REQUIRED_CONFIG_FIELDS]
    : [...BASE_REQUIRED_CONFIG_FIELDS, ...MANUAL_PLACEMENT_REQUIRED_FIELDS]
}

function getMissingRequiredFields (config) {
  const missing = []
  for (const field of getRequiredFields(config)) {
    const value = getByPath(config, field)
    if (value == null || value === '' || (typeof value === 'number' && Number.isNaN(value))) missing.push(field)
  }

  const auth = String(config.auth || 'microsoft').toLowerCase()
  if (!config.username || String(config.username).trim().length === 0) {
    missing.push(auth === 'offline' ? 'offlineUsername' : 'microsoftEmail')
  }

  return [...new Set(missing)]
}



function derivePlacementFromConfig (config) {
  const next = { ...config }
  const placementMode = String(next.placementMode || 'manual').toLowerCase() === 'easy' ? 'easy' : 'manual'
<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
  const size = normalizeOddFarmSize(next.farmSize, 9)
=======
  const size = Math.max(3, Number(next.farmSize) || 16)
>>>>>>> main
  next.farmSize = size

  if (placementMode === 'manual') {
    const a = next.manualCornerA || {}
    const b = next.manualCornerB || {}
    const hasCorners = Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)) && Number.isFinite(Number(a.z)) &&
      Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.y)) && Number.isFinite(Number(b.z))

    if (hasCorners) {
      const ax = Math.floor(Number(a.x))
      const ay = Math.floor(Number(a.y))
      const az = Math.floor(Number(a.z))
      const bx = Math.floor(Number(b.x))
      const by = Math.floor(Number(b.y))
      const bz = Math.floor(Number(b.z))

      const spanX = Math.abs(bx - ax) + 1
      const spanZ = Math.abs(bz - az) + 1
<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
      const squareSize = normalizeOddFarmSize(Math.max(spanX, spanZ), 9)
=======
      const squareSize = Math.max(3, Math.min(64, Math.max(spanX, spanZ)))
>>>>>>> main
      const originX = Math.min(ax, bx)
      const originZ = Math.min(az, bz)
      const originY = ay

      next.farmSize = squareSize
      next.origin = { x: originX, y: originY, z: originZ }
    }
  }

  const origin = next.origin || { x: 0, y: 64, z: 0 }
  const centerOffset = Math.floor((next.farmSize - 1) / 2)
  next.safePlatform = {
    x: Math.floor(Number(origin.x) || 0) + centerOffset,
    y: Math.floor(Number(origin.y) || 64),
    z: Math.floor(Number(origin.z) || 0) + centerOffset
  }

  return next
}

function enrichConfigForWizard (config) {
  const enriched = { ...config }
<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
  const size = normalizeOddFarmSize(enriched.farmSize, 9)
=======
  const size = Math.max(3, Number(enriched.farmSize) || 16)
>>>>>>> main
  const origin = enriched.origin || { x: 0, y: 64, z: 0 }
  enriched.manualCornerA = { x: origin.x, y: origin.y, z: origin.z }
  enriched.manualCornerB = { x: origin.x + (size - 1), y: origin.y, z: origin.z + (size - 1) }
  return enriched
}

function guessContentType (filePath) {
  const ext = path.extname(filePath)
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8'
  }[ext] || 'application/octet-stream'
}

function startUiServer ({ engine, cfg }) {
  const guiConfig = cfg.gui || {}
  if (guiConfig.enabled === false) {
    return { server: null, close: () => {} }
  }

  const host = guiConfig.host || '0.0.0.0'
  const port = guiConfig.port || 8787
  const publicDir = path.join(__dirname, 'public')
  const clients = new Set()
  const configPath = resolveConfigPath()

  function saveConfigToDisk (nextConfig) {
    const payload = `${JSON.stringify(nextConfig, null, 2)}\n`
    fs.writeFileSync(configPath, payload, 'utf8')
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && reqUrl.pathname === '/status') {
      jsonResponse(res, 200, engine.getStatus())
      return
    }

    if (req.method === 'GET' && reqUrl.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })

      res.write(formatSse('status', engine.getStatus()))
      clients.add(res)

      const cleanup = () => {
        clients.delete(res)
      }

      req.on('close', cleanup)
      req.on('error', cleanup)
      res.on('error', cleanup)
      return
    }

    if (req.method === 'POST' && reqUrl.pathname === '/control') {
      let body = ''
      let size = 0

      req.on('data', chunk => {
        size += chunk.length
        if (size > MAX_CONTROL_PAYLOAD_BYTES) {
          jsonResponse(res, 413, { ok: false, error: 'Payload too large' })
          req.destroy()
          return
        }
        body += chunk
<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
=======
      })

      req.on('end', async () => {
        let payload
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }

        const action = String(payload.action || '').toLowerCase()
        if (!action) {
          jsonResponse(res, 400, { ok: false, error: 'Missing action' })
          return
        }

        try {
          if (action === 'start') {
            await engine.startBuild()
            jsonResponse(res, 200, { ok: true, action, accepted: true })
            return
          }

          if (action === 'pause') {
            const accepted = engine.pauseBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          if (action === 'resume') {
            const accepted = engine.resumeBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          if (action === 'stop') {
            const accepted = engine.stopBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          jsonResponse(res, 400, { ok: false, error: `Unsupported action: ${action}` })
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message })
        }
      })

      req.on('error', () => {
        if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: 'Failed to read request body' })
      })

      return
    }

    if (req.method === 'GET' && reqUrl.pathname === '/config') {
      const loaded = validateConfig(loadConfig())
      const wizardConfig = enrichConfigForWizard(loaded)
      jsonResponse(res, 200, {
        ok: true,
        config: wizardConfig,
        requiredFields: getRequiredFields(loaded),
        missingRequiredFields: getMissingRequiredFields(loaded)
      })
      return
    }

    if (req.method === 'POST' && reqUrl.pathname === '/config') {
      let body = ''
      let size = 0

      req.on('data', chunk => {
        size += chunk.length
        if (size > MAX_CONTROL_PAYLOAD_BYTES * 8) {
          jsonResponse(res, 413, { ok: false, error: 'Payload too large' })
          req.destroy()
          return
        }
        body += chunk
      })

      req.on('end', () => {
        let payload
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }

        const userConfig = payload.config
        if (!userConfig || typeof userConfig !== 'object') {
          jsonResponse(res, 400, { ok: false, error: 'Missing config object' })
          return
        }

        try {
          const baseConfig = loadConfig()
          const mergedConfig = {
            ...baseConfig,
            ...userConfig,
            origin: { ...(baseConfig.origin || {}), ...((userConfig && userConfig.origin) || {}) },
            gui: { ...(baseConfig.gui || {}), ...((userConfig && userConfig.gui) || {}) },
            refill: {
              ...(baseConfig.refill || {}),
              ...((userConfig && userConfig.refill) || {}),
              thresholds: {
                ...(((baseConfig.refill || {}).thresholds) || {}),
                ...((((userConfig || {}).refill || {}).thresholds) || {})
              },
              targetStacks: {
                ...(((baseConfig.refill || {}).targetStacks) || {}),
                ...((((userConfig || {}).refill || {}).targetStacks) || {})
              }
            },
            manualCornerA: { ...(baseConfig.manualCornerA || {}), ...((userConfig && userConfig.manualCornerA) || {}) },
            manualCornerB: { ...(baseConfig.manualCornerB || {}), ...((userConfig && userConfig.manualCornerB) || {}) }
          }

          const validated = validateConfig(derivePlacementFromConfig(mergedConfig))
          const missingRequiredFields = getMissingRequiredFields(validated)
          if (missingRequiredFields.length > 0) {
            jsonResponse(res, 400, {
              ok: false,
              error: 'Required configuration fields are missing.',
              missingRequiredFields,
              requiredFields: getRequiredFields(validated)
            })
            return
          }

          if (fs.existsSync(configPath)) {
            try {
              fs.copyFileSync(configPath, `${configPath}.bak`)
            } catch {}
          }

          saveConfigToDisk(validated)
          jsonResponse(res, 200, {
            ok: true,
            config: enrichConfigForWizard(validated),
            requiredFields: getRequiredFields(validated),
            missingRequiredFields: [],
            message: 'Configuration saved. Restart bot process to apply connection-level changes.'
          })
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message })
        }
      })

      req.on('error', () => {
        if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: 'Failed to read request body' })
      })
      return
    }

    if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname.startsWith('/assets/'))) {
      const relativePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname
      const fullPath = path.resolve(publicDir, relativePath.replace(/^\//, ''))

      if (!fullPath.startsWith(publicDir)) {
        jsonResponse(res, 403, { error: 'Forbidden' })
        return
      }

      fs.stat(fullPath, (err, stat) => {
        if (err || !stat.isFile()) {
          jsonResponse(res, 404, { error: 'Not Found' })
          return
        }

        res.writeHead(200, {
          'Content-Type': guessContentType(fullPath),
          'Cache-Control': reqUrl.pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-store'
        })
        fs.createReadStream(fullPath).pipe(res)
>>>>>>> main
      })

      req.on('end', async () => {
        let payload
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }

        const action = String(payload.action || '').toLowerCase()
        if (!action) {
          jsonResponse(res, 400, { ok: false, error: 'Missing action' })
          return
        }

        try {
          if (action === 'start') {
            await engine.startBuild()
            jsonResponse(res, 200, { ok: true, action, accepted: true })
            return
          }

          if (action === 'pause') {
            const accepted = engine.pauseBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          if (action === 'resume') {
            const accepted = engine.resumeBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          if (action === 'stop') {
            const accepted = engine.stopBuild()
            jsonResponse(res, 200, { ok: accepted, action, accepted })
            return
          }

          jsonResponse(res, 400, { ok: false, error: `Unsupported action: ${action}` })
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message })
        }
      })

      req.on('error', () => {
        if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: 'Failed to read request body' })
      })

      return
    }

<<<<<<< codex/build-gui-for-minefarmbot-pfl97s
    if (req.method === 'GET' && reqUrl.pathname === '/config') {
      const loaded = validateConfig(loadConfig())
      const wizardConfig = enrichConfigForWizard(loaded)
      jsonResponse(res, 200, {
        ok: true,
        config: wizardConfig,
        requiredFields: getRequiredFields(loaded),
        missingRequiredFields: getMissingRequiredFields(loaded)
      })
      return
    }

    if (req.method === 'POST' && reqUrl.pathname === '/config') {
      let body = ''
      let size = 0

      req.on('data', chunk => {
        size += chunk.length
        if (size > MAX_CONTROL_PAYLOAD_BYTES * 8) {
          jsonResponse(res, 413, { ok: false, error: 'Payload too large' })
          req.destroy()
          return
        }
        body += chunk
      })

      req.on('end', () => {
        let payload
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' })
          return
        }

        const userConfig = payload.config
        if (!userConfig || typeof userConfig !== 'object') {
          jsonResponse(res, 400, { ok: false, error: 'Missing config object' })
          return
        }

        try {
          const baseConfig = loadConfig()
          const mergedConfig = {
            ...baseConfig,
            ...userConfig,
            origin: { ...(baseConfig.origin || {}), ...((userConfig && userConfig.origin) || {}) },
            gui: { ...(baseConfig.gui || {}), ...((userConfig && userConfig.gui) || {}) },
            refill: {
              ...(baseConfig.refill || {}),
              ...((userConfig && userConfig.refill) || {}),
              thresholds: {
                ...(((baseConfig.refill || {}).thresholds) || {}),
                ...((((userConfig || {}).refill || {}).thresholds) || {})
              },
              targetStacks: {
                ...(((baseConfig.refill || {}).targetStacks) || {}),
                ...((((userConfig || {}).refill || {}).targetStacks) || {})
              }
            },
            manualCornerA: { ...(baseConfig.manualCornerA || {}), ...((userConfig && userConfig.manualCornerA) || {}) },
            manualCornerB: { ...(baseConfig.manualCornerB || {}), ...((userConfig && userConfig.manualCornerB) || {}) }
          }

          const validated = validateConfig(derivePlacementFromConfig(mergedConfig))
          const missingRequiredFields = getMissingRequiredFields(validated)
          if (missingRequiredFields.length > 0) {
            jsonResponse(res, 400, {
              ok: false,
              error: 'Required configuration fields are missing.',
              missingRequiredFields,
              requiredFields: getRequiredFields(validated)
            })
            return
          }

          if (fs.existsSync(configPath)) {
            try {
              fs.copyFileSync(configPath, `${configPath}.bak`)
            } catch {}
          }

          saveConfigToDisk(validated)
          jsonResponse(res, 200, {
            ok: true,
            config: enrichConfigForWizard(validated),
            requiredFields: getRequiredFields(validated),
            missingRequiredFields: [],
            message: 'Configuration saved. Restart bot process to apply connection-level changes.'
          })
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message })
        }
      })

      req.on('error', () => {
        if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: 'Failed to read request body' })
      })
      return
    }

    if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname.startsWith('/assets/'))) {
      const relativePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname
      const fullPath = path.resolve(publicDir, relativePath.replace(/^\//, ''))

      if (!fullPath.startsWith(publicDir)) {
        jsonResponse(res, 403, { error: 'Forbidden' })
        return
      }

      fs.stat(fullPath, (err, stat) => {
        if (err || !stat.isFile()) {
          jsonResponse(res, 404, { error: 'Not Found' })
          return
        }

        res.writeHead(200, {
          'Content-Type': guessContentType(fullPath),
          'Cache-Control': reqUrl.pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-store'
        })
        fs.createReadStream(fullPath).pipe(res)
      })
      return
    }

=======
>>>>>>> main
    jsonResponse(res, 404, { error: 'Not Found' })
  })

  const sendToClients = (event, payload) => {
    if (clients.size === 0) return
    const message = formatSse(event, payload)

    for (const client of clients) {
      try {
        client.write(message)
      } catch {
        clients.delete(client)
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
  }, SSE_HEARTBEAT_MS)

  const unsubStatus = engine.onStatus(status => sendToClients('status', status))
  const unsubLog = engine.onLog(entry => sendToClients('log', entry))
  const unsubWarn = engine.onWarning(entry => {
    sendToClients('log', entry)
    sendToClients('warning', entry)
  })
  const unsubError = engine.onError(entry => {
    sendToClients('log', entry)
    sendToClients('error', entry)
  })

  server.listen(port, host, () => {
    const urlHost = host === '0.0.0.0' ? 'localhost' : host
    console.log(`[GUI] Listening at http://${urlHost}:${port}`)
    console.log(`[GUI] Status endpoint: http://${urlHost}:${port}/status`)
  })

  return {
    server,
    close: () => {
      clearInterval(heartbeat)
      unsubStatus()
      unsubLog()
      unsubWarn()
      unsubError()

      for (const client of clients) {
        try {
          client.end()
        } catch {}
      }
      clients.clear()

      server.close()
    }
  }
}

module.exports = {
  startUiServer
}
