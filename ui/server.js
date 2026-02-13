'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const { loadConfig, validateConfig } = require('../config')

const MAX_CONTROL_PAYLOAD_BYTES = 4096
const MAX_CONFIG_PAYLOAD_BYTES = 8192
const SSE_HEARTBEAT_MS = 15000
const CONTROL_RATE_LIMIT_WINDOW_MS = 5000
const CONTROL_RATE_LIMIT_MAX_REQUESTS = 8
const BASE_REQUIRED_CONFIG_FIELDS = [
  'host',
  'port',
  'auth',
  'farmSize',
  'buildPlacementMode'
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

function getByPath (obj, pathStr) {
  return pathStr.split('.').reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj)
}

function getRequiredConfigFields (config) {
  const mode = String((config && config.buildPlacementMode) || 'manual').toLowerCase()
  if (mode === 'easy_center') return BASE_REQUIRED_CONFIG_FIELDS
  return [...BASE_REQUIRED_CONFIG_FIELDS, 'origin.x', 'origin.y', 'origin.z', 'safePlatform.x', 'safePlatform.y', 'safePlatform.z']
}

function getMissingRequiredFields (config) {
  const missing = []
  const requiredFields = getRequiredConfigFields(config)
  for (const field of requiredFields) {
    const value = getByPath(config, field)
    if (value == null || value === '' || (typeof value === 'number' && Number.isNaN(value))) missing.push(field)
  }

  const auth = String(config.auth || 'microsoft').toLowerCase()
  if (!config.username || String(config.username).trim().length === 0) {
    missing.push(auth === 'offline' ? 'offlineUsername' : 'microsoftEmail')
  }

  return [...new Set(missing)]
}

function guessContentType (filePath) {
  const ext = path.extname(filePath)
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8'
  }[ext] || 'application/octet-stream'
}

function isLoopbackAddress (remoteAddress) {
  if (!remoteAddress || typeof remoteAddress !== 'string') return false
  return remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
}

function requireLocalAccess (req, res) {
  // This UI API intentionally trusts only local callers. If you expose it behind a
  // reverse proxy, terminate and enforce auth/ACLs at the proxy, and keep the
  // upstream connection local so req.socket.remoteAddress remains loopback.
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: local access only' })
    return false
  }
  return true
}

function assertMethod (req, res, expectedMethod) {
  if (req.method !== expectedMethod) {
    jsonResponse(res, 405, { ok: false, error: `Method not allowed. Use ${expectedMethod}.` })
    return false
  }
  return true
}

function assertJsonContentType (req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    jsonResponse(res, 415, { ok: false, error: 'Unsupported media type. Expected application/json.' })
    return false
  }
  return true
}


function getValueType (value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateShape (obj, schema, root = 'payload') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return `${root} must be an object`
  }

  const allowedKeys = Object.keys(schema)
  for (const key of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      return `${root}.${key} is not allowed`
    }
  }

  for (const key of allowedKeys) {
    const rule = schema[key]
    const value = obj[key]

    if (rule.required && !Object.prototype.hasOwnProperty.call(obj, key)) {
      return `${root}.${key} is required`
    }
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue

    const allowedTypes = Array.isArray(rule.type) ? rule.type : [rule.type]
    const valueType = getValueType(value)

    if (!allowedTypes.includes(valueType)) {
      return `${root}.${key} must be of type ${allowedTypes.join(' or ')}`
    }

    if (allowedTypes.includes('object') && rule.schema) {
      const nestedError = validateShape(value, rule.schema, `${root}.${key}`)
      if (nestedError) return nestedError
    }
  }

  return null
}

function parseJsonBody (req, res, { maxBytes }) {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    let tooLarge = false

    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        jsonResponse(res, 413, { ok: false, error: 'Payload too large' })
        return
      }
      body += chunk
    })

    req.on('end', () => {
      if (res.headersSent || tooLarge) {
        resolve(null)
        return
      }
      try {
        const parsed = body ? JSON.parse(body) : {}
        resolve(parsed)
      } catch {
        jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' })
        resolve(null)
      }
    })

    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 400, { ok: false, error: 'Failed to read request body' })
      resolve(null)
    })
  })
}

const CONTROL_SCHEMA = {
  action: { required: true, type: 'string' }
}

const CONFIG_PATCH_SCHEMA = {
  host: { type: 'string' },
  port: { type: 'number' },
  username: { type: 'string' },
  password: { type: ['string', 'null'] },
  auth: { type: 'string' },
  version: { type: ['string', 'boolean'] },
  layers: { type: 'number' },
  buildDelayTicks: { type: 'number' },
  farmSize: { type: 'number' },
  buildPlacementMode: { type: 'string' },
  removeScaffold: { type: 'boolean' },
  facingYawDegrees: { type: 'number' },
  origin: {
    type: 'object',
    schema: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }
  },
  safePlatform: {
    type: 'object',
    schema: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }
  },
  gui: {
    type: 'object',
    schema: {
      enabled: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'number' }
    }
  },
  refill: {
    type: 'object',
    schema: {
      enabled: { type: 'boolean' },
      radius: { type: 'number' },
      cooldownMs: { type: 'number' },
      ignoreEmptyMs: { type: 'number' },
      thresholds: {
        type: 'object',
        schema: {
          sand: { type: 'number' },
          cactus: { type: 'number' },
          string: { type: 'number' },
          cobblestone: { type: 'number' }
        }
      },
      targetStacks: {
        type: 'object',
        schema: {
          sand: { type: 'number' },
          cactus: { type: 'number' },
          string: { type: 'number' },
          cobblestone: { type: 'number' }
        }
      }
    }
  }
}

const CONFIG_SCHEMA = {
  config: {
    required: true,
    type: 'object',
    schema: CONFIG_PATCH_SCHEMA
  }
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
  const configPath = path.join(process.cwd(), 'config.json')
  const controlRateLimit = []

  function saveConfigToDisk (nextConfig) {
    const payload = `${JSON.stringify(nextConfig, null, 2)}\n`
    fs.writeFileSync(configPath, payload, 'utf8')
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (!requireLocalAccess(req, res)) return

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

    if (reqUrl.pathname === '/control') {
      if (!assertMethod(req, res, 'POST')) return
      if (!assertJsonContentType(req, res)) return

      const now = Date.now()
      while (controlRateLimit.length > 0 && now - controlRateLimit[0] > CONTROL_RATE_LIMIT_WINDOW_MS) {
        controlRateLimit.shift()
      }
      if (controlRateLimit.length >= CONTROL_RATE_LIMIT_MAX_REQUESTS) {
        jsonResponse(res, 429, { ok: false, error: 'Too many control requests. Slow down.' })
        return
      }
      controlRateLimit.push(now)

      parseJsonBody(req, res, { maxBytes: MAX_CONTROL_PAYLOAD_BYTES }).then(async payload => {
        if (!payload) return

        const schemaError = validateShape(payload, CONTROL_SCHEMA)
        if (schemaError) {
          jsonResponse(res, 400, { ok: false, error: `Invalid payload: ${schemaError}` })
          return
        }

        const action = String(payload.action || '').toLowerCase()

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
      return
    }

    if (req.method === 'GET' && reqUrl.pathname === '/config') {
      const loaded = validateConfig(loadConfig())
      jsonResponse(res, 200, {
        ok: true,
        config: loaded,
        requiredFields: getRequiredConfigFields(validated),
        missingRequiredFields: getMissingRequiredFields(loaded)
      })
      return
    }

    if (reqUrl.pathname === '/config' && req.method !== 'GET') {
      if (!assertMethod(req, res, 'POST')) return
      if (!assertJsonContentType(req, res)) return

      parseJsonBody(req, res, { maxBytes: MAX_CONFIG_PAYLOAD_BYTES }).then(payload => {
        if (!payload) return

        const schemaError = validateShape(payload, CONFIG_SCHEMA)
        if (schemaError) {
          jsonResponse(res, 400, { ok: false, error: `Invalid payload: ${schemaError}` })
          return
        }

        const userConfig = payload.config

        try {
          const baseConfig = loadConfig()
          const validated = validateConfig({
            ...baseConfig,
            ...userConfig,
            origin: { ...(baseConfig.origin || {}), ...((userConfig && userConfig.origin) || {}) },
            safePlatform: { ...(baseConfig.safePlatform || {}), ...((userConfig && userConfig.safePlatform) || {}) },
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
            }
          })
          const missingRequiredFields = getMissingRequiredFields(validated)
          if (missingRequiredFields.length > 0) {
            jsonResponse(res, 400, {
              ok: false,
              error: 'Required configuration fields are missing.',
              missingRequiredFields,
              requiredFields: getRequiredConfigFields(validated)
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
            config: validated,
            requiredFields: getRequiredConfigFields(validated),
            missingRequiredFields: [],
            message: 'Configuration saved. Restart bot process to apply connection-level changes.'
          })
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message })
        }
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
