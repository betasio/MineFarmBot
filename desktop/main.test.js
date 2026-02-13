'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const EventEmitter = require('node:events')
const Module = require('node:module')

function createHarness () {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minefarmbot-desktop-test-'))
  const userData = path.join(tempRoot, 'userData')
  fs.mkdirSync(userData, { recursive: true })

  const ipcHandlers = new Map()
  const sendEvents = []
  const openExternalCalls = []
  const spawnCalls = []
  const killSignals = []
  let latestChild = null

  class FakeStream extends EventEmitter {}

  class FakeChild extends EventEmitter {
    constructor () {
      super()
      this.stdout = new FakeStream()
      this.stderr = new FakeStream()
    }

    kill (signal) {
      killSignals.push(signal)
      this.emit('exit', 0, signal)
      return true
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor () {
      super()
      this.webContents = {
        send: (...args) => sendEvents.push(args)
      }
    }

    loadURL () { return Promise.resolve() }
    loadFile () { return Promise.resolve() }
    getBounds () { return { width: 1200, height: 800, x: 0, y: 0 } }
    isDestroyed () { return false }
    isVisible () { return true }
    isMinimized () { return false }
    show () {}
    hide () {}
    focus () {}
    restore () {}
  }

  class FakeTray {
    setToolTip () {}
    setContextMenu () {}
    on () {}
    destroy () {}
  }

  const electronMock = {
    app: {
      getPath: (name) => {
        if (name === 'userData') return userData
        throw new Error(`unexpected path lookup: ${name}`)
      },
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => Promise.resolve(),
      on: () => {}
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showErrorBox: () => {} },
    Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
    ipcMain: {
      handle: (channel, handler) => {
        ipcHandlers.set(channel, handler)
      }
    },
    shell: {
      openExternal: (url) => {
        openExternalCalls.push(url)
        return Promise.resolve()
      }
    }
  }

  const childProcessMock = {
    spawn: (...args) => {
      const child = new FakeChild()
      latestChild = child
      spawnCalls.push(args)
      return child
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock
    if (request === 'child_process') return childProcessMock
    return originalLoad.call(this, request, parent, isMain)
  }

  const originalEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  const mainPath = path.join(process.cwd(), 'desktop', 'main.js')
  delete require.cache[require.resolve(mainPath)]
  require(mainPath)
  Module._load = originalLoad
  process.env.NODE_ENV = originalEnv

  return {
    userData,
    ipcHandlers,
    sendEvents,
    openExternalCalls,
    spawnCalls,
    killSignals,
    getLatestChild: () => latestChild
  }
}

async function invoke (harness, channel, ...args) {
  const handler = harness.ipcHandlers.get(channel)
  assert.ok(handler, `missing handler for ${channel}`)
  return handler({}, ...args)
}

test('listProfiles is empty on first run and lists created profile metadata', async () => {
  const harness = createHarness()

  const firstList = await invoke(harness, 'desktop:listProfiles')
  assert.equal(firstList.ok, true)
  assert.deepEqual(firstList.profiles, [])

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'Alpha Profile',
    auth: 'offline',
    identity: 'alpha-user',
    host: 'play.example.net',
    port: 25565,
    guiPort: 8787
  })

  assert.equal(created.ok, true)
  assert.equal(created.profile.name, 'Alpha Profile')

  const secondList = await invoke(harness, 'desktop:listProfiles')
  assert.equal(secondList.ok, true)
  assert.equal(secondList.profiles.length, 1)
  assert.equal(secondList.profiles[0].name, 'Alpha Profile')
  assert.equal(secondList.profiles[0].auth, 'offline')
  assert.equal(secondList.profiles[0].host, 'play.example.net')
  assert.equal(secondList.profiles[0].username, 'alpha-user')
})

test('createProfile writes expected config/profile files under userData profiles directory', async () => {
  const harness = createHarness()

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'Structure Check',
    auth: 'microsoft',
    identity: 'test@example.com',
    host: 'mc.example.net'
  })

  assert.equal(created.ok, true)
  const profileDir = path.join(harness.userData, 'profiles', created.profile.id)
  const configPath = path.join(profileDir, 'config.json')
  const profilePath = path.join(profileDir, 'profile.json')
  const checkpointPath = path.join(profileDir, 'build-checkpoint.json')

  assert.equal(fs.existsSync(profileDir), true)
  assert.equal(fs.existsSync(configPath), true)
  assert.equal(fs.existsSync(profilePath), true)
  assert.equal(path.dirname(checkpointPath), profileDir)
})

test('launchProfile spawns bot process with expected environment variables', async () => {
  const harness = createHarness()

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'Spawn Env',
    auth: 'offline',
    identity: 'spawn-user',
    host: 'localhost'
  })

  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn) => {
    fn()
    return 0
  }

  try {
    const launched = await invoke(harness, 'desktop:launchProfile', created.profile.id)
    assert.equal(launched.ok, true)
  } finally {
    global.setTimeout = realSetTimeout
  }

  assert.equal(harness.spawnCalls.length, 1)
  const [, , options] = harness.spawnCalls[0]
  assert.equal(options.env.MINEFARMBOT_DESKTOP, '1')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(options.env.BOT_CONFIG_PATH, path.join(harness.userData, 'profiles', created.profile.id, 'config.json'))
  assert.equal(options.env.BOT_CHECKPOINT_PATH, path.join(harness.userData, 'profiles', created.profile.id, 'build-checkpoint.json'))
})

test('stop and restart transitions are correct and idempotent', async () => {
  const harness = createHarness()

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'Restart Test',
    auth: 'offline',
    identity: 'restart-user',
    host: 'localhost'
  })

  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn) => {
    fn()
    return 0
  }

  try {
    await invoke(harness, 'desktop:launchProfile', created.profile.id)
    const firstStop = await invoke(harness, 'desktop:stopBot')
    const secondStop = await invoke(harness, 'desktop:stopBot')
    assert.equal(firstStop.ok, true)
    assert.equal(secondStop.ok, true)

    const restartWithoutActive = await invoke(harness, 'desktop:restartBot')
    assert.equal(restartWithoutActive.ok, false)

    await invoke(harness, 'desktop:launchProfile', created.profile.id)
    const restartActive = await invoke(harness, 'desktop:restartBot')
    assert.equal(restartActive.ok, true)
  } finally {
    global.setTimeout = realSetTimeout
  }

  assert.ok(harness.killSignals.length >= 2)
  assert.equal(harness.spawnCalls.length, 3)
})

test('MSA device code output emits desktop:msa-code and invokes browser open callback path', async () => {
  const harness = createHarness()

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'MSA Flow',
    auth: 'microsoft',
    identity: 'msa@example.com',
    host: 'localhost'
  })

  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn) => {
    fn()
    return 0
  }

  try {
    const launched = await invoke(harness, 'desktop:launchProfile', created.profile.id)
    assert.equal(launched.ok, true)
  } finally {
    global.setTimeout = realSetTimeout
  }

  const child = harness.getLatestChild()
  assert.ok(child)
  child.stdout.emit('data', Buffer.from('To sign in, use the code ABC123 at https://www.microsoft.com/link\n'))

  assert.equal(harness.sendEvents.length, 1)
  assert.equal(harness.sendEvents[0][0], 'desktop:msa-code')
  assert.deepEqual(harness.sendEvents[0][1], { code: 'ABC123', url: 'https://www.microsoft.com/link' })
  assert.deepEqual(harness.openExternalCalls, ['https://www.microsoft.com/link'])
})


test('desktop IPC status transition emits only on state change', async () => {
  const harness = createHarness()

  const created = await invoke(harness, 'desktop:createProfile', {
    name: 'State Events',
    auth: 'offline',
    identity: 'state-user',
    host: 'localhost'
  })

  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn) => {
    fn()
    return 0
  }

  try {
    const launched = await invoke(harness, 'desktop:launchProfile', created.profile.id)
    assert.equal(launched.ok, true)
  } finally {
    global.setTimeout = realSetTimeout
  }

  const child = harness.getLatestChild()
  assert.ok(child)

  child.emit('message', { channel: 'status', payload: { lifecycleState: 'connecting' } })
  child.emit('message', { channel: 'status', payload: { lifecycleState: 'connecting' } })
  child.emit('message', { channel: 'status', payload: { lifecycleState: 'running' } })

  const transitions = harness.sendEvents.filter(event => event[0] === 'desktop:status-transition')
  assert.equal(transitions.length, 2)
  assert.equal(transitions[0][1].current, 'connecting')
  assert.equal(transitions[1][1].current, 'running')
})
