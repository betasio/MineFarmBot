'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')

function formatSse (event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function jsonResponse (res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function startUiServer ({ engine, cfg }) {
  const guiConfig = cfg.gui || {}
  if (guiConfig.enabled === false) {
    return { server: null, close: () => {} }
  }

  const host = guiConfig.host || '0.0.0.0'
  const port = guiConfig.port || 8787
  const clients = new Set()
  const publicDir = path.join(__dirname, 'public')

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && reqUrl.pathname === '/status') {
      const payload = engine.getStatus()
      jsonResponse(res, 200, payload)
      return
    }

    if (req.method === 'GET' && reqUrl.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(formatSse('status', engine.getStatus()))
      clients.add(res)
      req.on('close', () => {
        clients.delete(res)
      })
      return
    }

    if (req.method === 'POST' && reqUrl.pathname === '/control') {
      let body = ''
      req.on('data', chunk => {
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

        const action = (payload.action || '').toLowerCase()
        if (!action) {
          jsonResponse(res, 400, { ok: false, error: 'Missing action' })
          return
        }

        try {
          if (action === 'start') {
            await engine.startBuild()
            jsonResponse(res, 200, { ok: true, action })
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

    if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname.startsWith('/assets/'))) {
      const relativePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname
      const fullPath = path.join(publicDir, relativePath.replace(/^\//, ''))
      if (!fullPath.startsWith(publicDir)) {
        jsonResponse(res, 403, { error: 'Forbidden' })
        return
      }
      if (!fs.existsSync(fullPath)) {
        jsonResponse(res, 404, { error: 'Not Found' })
        return
      }

      const ext = path.extname(fullPath)
      const contentType = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8'
      }[ext] || 'application/octet-stream'

      res.writeHead(200, { 'Content-Type': contentType })
      fs.createReadStream(fullPath).pipe(res)
      return
    }

    jsonResponse(res, 404, { error: 'Not Found' })
  })

  const sendToClients = (event, payload) => {
    if (clients.size === 0) return
    const message = formatSse(event, payload)
    for (const client of clients) {
      client.write(message)
    }
  }

  const unsubStatus = engine.onStatus(status => sendToClients('status', status))
  const forwardLog = (entry) => sendToClients('log', entry)
  const unsubLog = engine.onLog(forwardLog)
  const unsubWarn = engine.onWarning(entry => {
    forwardLog(entry)
    sendToClients('warning', entry)
  })
  const unsubError = engine.onError(entry => {
    forwardLog(entry)
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
      unsubStatus()
      unsubLog()
      unsubWarn()
      unsubError()
      for (const client of clients) {
        client.end()
      }
      clients.clear()
      server.close()
    }
  }
}

module.exports = {
  startUiServer
}
