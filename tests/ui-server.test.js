'use strict'

let nextPort = 19000

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { startUiServer } = require('../ui/server')

function createEngine () {
  const status = { running: false }
  return {
    startCount: 0,
    getStatus: () => status,
    onStatus: () => () => {},
    onLog: () => () => {},
    onWarning: () => () => {},
    onError: () => () => {},
    async startBuild () {
      this.startCount += 1
      status.running = true
    },
    pauseBuild: () => true,
    resumeBuild: () => true,
    stopBuild: () => true
  }
}

async function withServer (fn) {
  const cwd = process.cwd()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minefarmbot-ui-server-test-'))
  const initialConfig = {
    host: 'localhost',
    port: 25565,
    username: 'Bot',
    auth: 'offline',
    origin: { x: 0, y: 64, z: 0 },
    safePlatform: { x: 0, y: 64, z: 0 }
  }

  fs.writeFileSync(path.join(tempDir, 'config.json'), `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8')
  process.chdir(tempDir)

  const engine = createEngine()
  nextPort += 1
  const ui = startUiServer({ engine, cfg: { gui: { host: '127.0.0.1', port: nextPort } } })
  const { server } = ui

  if (!server.listening) {
    await new Promise(resolve => server.once('listening', resolve))
  }

  const { port } = server.address()

  try {
    await fn({ port, engine })
  } finally {
    ui.close()
    process.chdir(cwd)
  }
}

function requestJson ({ port, pathname, method = 'POST', contentType = 'application/json', body }) {
  const payload = body == null || typeof body === 'string' ? body : JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          payload: data ? JSON.parse(data) : null
        })
      })
    })

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('POST /control accepts valid payload', async () => {
  await withServer(async ({ port, engine }) => {
    const response = await requestJson({
      port,
      pathname: '/control',
      body: { action: 'start' }
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.ok, true)
    assert.equal(engine.startCount, 1)
  })
})

test('POST /control rejects malformed, unknown-key, oversized, and wrong content-type payloads', async () => {
  await withServer(async ({ port }) => {
    const malformed = await requestJson({
      port,
      pathname: '/control',
      body: '{"action":',
      contentType: 'application/json'
    })
    assert.equal(malformed.statusCode, 400)

    const unknownKey = await requestJson({
      port,
      pathname: '/control',
      body: { action: 'start', extra: true }
    })
    assert.equal(unknownKey.statusCode, 400)

    const oversized = await requestJson({
      port,
      pathname: '/control',
      body: { action: 'start', filler: 'x'.repeat(5000) }
    })
    assert.equal(oversized.statusCode, 413)

    const wrongType = await requestJson({
      port,
      pathname: '/control',
      body: { action: 'start' },
      contentType: 'text/plain'
    })
    assert.equal(wrongType.statusCode, 415)
  })
})

test('POST /config accepts valid payload and rejects unknown-key or oversized payloads', async () => {
  await withServer(async ({ port }) => {
    const valid = await requestJson({
      port,
      pathname: '/config',
      body: {
        config: {
          layers: 24,
          origin: { x: 1, y: 64, z: 1 },
          safePlatform: { x: 1, y: 64, z: 1 }
        }
      }
    })
    assert.equal(valid.statusCode, 200)
    assert.equal(valid.payload.ok, true)

    const unknownKey = await requestJson({
      port,
      pathname: '/config',
      body: {
        config: {
          unsupported: true
        }
      }
    })
    assert.equal(unknownKey.statusCode, 400)

    const oversized = await requestJson({
      port,
      pathname: '/config',
      body: {
        config: {
          username: 'a'.repeat(9000)
        }
      }
    })
    assert.equal(oversized.statusCode, 413)
  })
})
