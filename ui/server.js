'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')

const MAX_CONTROL_PAYLOAD_BYTES = 4096
const SSE_HEARTBEAT_MS = 15000

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
          const handlers = {
            start: async () => {
              const status = engine.getStatus()
              const build = status && status.build ? status.build : {}
              const buildState = String(build.state || build.status || '').toLowerCase()
              if (['running', 'paused', 'stopping'].includes(buildState) || build.stopRequested) {
                return { accepted: true, idempotent: true, message: 'Build is already active' }
              }
              await engine.startBuild()
              return { accepted: true, message: 'Build start requested' }
            },
            pause: async () => ({ accepted: engine.pauseBuild(), message: 'Pause requested' }),
            resume: async () => ({ accepted: engine.resumeBuild(), message: 'Resume requested' }),
            stop: async () => {
              const status = engine.getStatus()
              const build = status && status.build ? status.build : {}
              const buildState = String(build.state || build.status || '').toLowerCase()
              if (buildState === 'stopping' || build.stopRequested) {
                return { accepted: true, idempotent: true, message: 'Safe stop already requested' }
              }
              if (!['running', 'paused'].includes(buildState)) {
                return { accepted: true, idempotent: true, message: 'Build is not running; nothing to stop' }
              }
              return { accepted: engine.stopBuild(), message: 'Safe stop requested' }
            },
            reconnect: async () => {
              const status = engine.getStatus()
              if (status && status.reconnectScheduled) {
                return { accepted: true, idempotent: true, message: 'Reconnect already scheduled' }
              }
              return { ...(await engine.reconnectNow()) }
            },
            force_refill: async () => ({ ...(await engine.forceRefillNow()) }),
            return_home: async () => ({ ...(await engine.returnHome()) }),
            open_checkpoint: async () => ({ ...(await engine.openCheckpoint()) })
          }

          const handler = handlers[action]
          if (!handler) {
            jsonResponse(res, 400, {
              ok: false,
              action,
              error: {
                code: 'UNSUPPORTED_ACTION',
                message: `Unsupported action: ${action}`
              }
            })
            return
          }

          const result = await handler()
          const accepted = Boolean(result && result.accepted)
          jsonResponse(res, accepted ? 200 : 409, {
            ok: accepted,
            action,
            accepted,
            message: result && result.message ? result.message : null,
            data: result || null,
            error: accepted
              ? null
              : {
                  code: 'ACTION_REJECTED',
                  message: (result && result.message) || `Action rejected: ${action}`
                }
          })
        } catch (err) {
          jsonResponse(res, 500, {
            ok: false,
            action,
            error: {
              code: 'ACTION_FAILED',
              message: err.message
            }
          })
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
