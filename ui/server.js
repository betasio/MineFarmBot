'use strict'

const http = require('http')

function formatSse (event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startUiServer ({ engine, cfg }) {
  const guiConfig = cfg.gui || {}
  if (guiConfig.enabled === false) {
    return { server: null, close: () => {} }
  }

  const host = guiConfig.host || '0.0.0.0'
  const port = guiConfig.port || 8787
  const clients = new Set()

  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      const payload = engine.getStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }

    if (req.url === '/events') {
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

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  })

  const sendToClients = (event, payload) => {
    if (clients.size === 0) return
    const message = formatSse(event, payload)
    for (const client of clients) {
      client.write(message)
    }
  }

  const unsubStatus = engine.onStatus(status => sendToClients('status', status))
  const unsubLog = engine.onLog(entry => sendToClients('log', entry))
  const unsubWarn = engine.onWarning(entry => sendToClients('warning', entry))
  const unsubError = engine.onError(entry => sendToClients('error', entry))

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
