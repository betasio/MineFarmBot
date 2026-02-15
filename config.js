'use strict'

const fs = require('fs')
const path = require('path')
const { PROFILE_SCHEMA_VERSION, migrateConfigFileIfNeeded } = require('./desktop/profileMigrations')

const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 25565,
  username: 'CactusBuilderBot',
  password: null,
  auth: 'microsoft',
  version: false,
  layers: 18,
  buildDelayTicks: 3,
  farmSize: 9,
  placementMode: 'manual',
  removeScaffold: false,
  safePlatform: { x: 0, y: 64, z: 0 },
  origin: { x: 0, y: 64, z: 0 },
  facingYawDegrees: 0,
  gui: {
    enabled: true,
    host: '0.0.0.0',
    port: 8787
  },
  refill: {
    enabled: true,
    radius: 7,
    cooldownMs: 30000,
    ignoreEmptyMs: 120000,
    thresholds: { sand: 64, cactus: 64, string: 64, cobblestone: 128 },
    targetStacks: { sand: 6, cactus: 6, string: 6, cobblestone: 8 }
  }
}

function resolveConfigPath () {
  if (process.env.BOT_CONFIG_PATH && process.env.BOT_CONFIG_PATH.trim().length > 0) {
    return process.env.BOT_CONFIG_PATH.trim()
  }
  return path.join(process.cwd(), 'config.json')
}

function clampInteger (value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.floor(num)))
}

function normalizeOddSize (value, fallback = DEFAULT_CONFIG.farmSize) {
  let size = clampInteger(value, 3, 63, fallback)
  if (size % 2 === 0) size += 1
  if (size > 63) size = 63
  return size
}

function normalizeVersion (value) {
  if (value == null || value === false) return false
  const raw = String(value).trim()
  if (!raw) return false
  const lowered = raw.toLowerCase()
  if (lowered === 'false' || lowered === 'auto' || lowered === 'default' || lowered === 'null' || lowered === 'undefined') return false
  return raw
}

function validateConfig (config) {
  const refill = {
    ...DEFAULT_CONFIG.refill,
    ...(config.refill || {}),
    thresholds: { ...DEFAULT_CONFIG.refill.thresholds, ...((config.refill && config.refill.thresholds) || {}) },
    targetStacks: { ...DEFAULT_CONFIG.refill.targetStacks, ...((config.refill && config.refill.targetStacks) || {}) }
  }

  return {
    ...config,
    layers: clampInteger(config.layers, 1, 128, DEFAULT_CONFIG.layers),
    farmSize: normalizeOddSize(config.farmSize, DEFAULT_CONFIG.farmSize),
    placementMode: String(config.placementMode || DEFAULT_CONFIG.placementMode).toLowerCase() === 'easy' ? 'easy' : 'manual',
    buildDelayTicks: clampInteger(config.buildDelayTicks, 1, 40, DEFAULT_CONFIG.buildDelayTicks),
    version: normalizeVersion(config.version),
    removeScaffold: Boolean(config.removeScaffold),
    facingYawDegrees: Number.isFinite(Number(config.facingYawDegrees)) ? Number(config.facingYawDegrees) : DEFAULT_CONFIG.facingYawDegrees,
    gui: {
      ...DEFAULT_CONFIG.gui,
      ...(config.gui || {}),
      enabled: config.gui && Object.prototype.hasOwnProperty.call(config.gui, 'enabled')
        ? Boolean(config.gui.enabled)
        : DEFAULT_CONFIG.gui.enabled,
      host: (config.gui && typeof config.gui.host === 'string' && config.gui.host.trim().length > 0)
        ? config.gui.host
        : DEFAULT_CONFIG.gui.host,
      port: clampInteger(
        config.gui && config.gui.port,
        1024,
        65535,
        DEFAULT_CONFIG.gui.port
      )
    },
    refill: {
      ...refill,
      enabled: Boolean(refill.enabled),
      radius: clampInteger(refill.radius, 2, 12, DEFAULT_CONFIG.refill.radius),
      cooldownMs: clampInteger(refill.cooldownMs, 5000, 180000, DEFAULT_CONFIG.refill.cooldownMs),
      ignoreEmptyMs: clampInteger(refill.ignoreEmptyMs, 10000, 600000, DEFAULT_CONFIG.refill.ignoreEmptyMs),
      thresholds: {
        sand: clampInteger(refill.thresholds.sand, 1, 2304, DEFAULT_CONFIG.refill.thresholds.sand),
        cactus: clampInteger(refill.thresholds.cactus, 1, 2304, DEFAULT_CONFIG.refill.thresholds.cactus),
        string: clampInteger(refill.thresholds.string, 1, 2304, DEFAULT_CONFIG.refill.thresholds.string),
        cobblestone: clampInteger(refill.thresholds.cobblestone, 1, 2304, DEFAULT_CONFIG.refill.thresholds.cobblestone)
      },
      targetStacks: {
        sand: clampInteger(refill.targetStacks.sand, 1, 36, DEFAULT_CONFIG.refill.targetStacks.sand),
        cactus: clampInteger(refill.targetStacks.cactus, 1, 36, DEFAULT_CONFIG.refill.targetStacks.cactus),
        string: clampInteger(refill.targetStacks.string, 1, 36, DEFAULT_CONFIG.refill.targetStacks.string),
        cobblestone: clampInteger(refill.targetStacks.cobblestone, 1, 36, DEFAULT_CONFIG.refill.targetStacks.cobblestone)
      }
    }
  }
}

function loadConfig () {
  const configPath = resolveConfigPath()
  if (!fs.existsSync(configPath)) {
    console.warn(`[WARN] ${path.basename(configPath)} not found. Falling back to defaults.`)
    return DEFAULT_CONFIG
  }

  try {
    const migrated = migrateConfigFileIfNeeded({
      configPath,
      defaultConfig: DEFAULT_CONFIG,
      validateConfig
    })
    const parsed = migrated.config
    if (!parsed) return DEFAULT_CONFIG
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      schemaVersion: Number.isFinite(parsed.schemaVersion) ? parsed.schemaVersion : PROFILE_SCHEMA_VERSION,
      origin: { ...DEFAULT_CONFIG.origin, ...(parsed.origin || {}) },
      safePlatform: { ...DEFAULT_CONFIG.safePlatform, ...(parsed.safePlatform || {}) },
      gui: { ...DEFAULT_CONFIG.gui, ...(parsed.gui || {}) }
    }
  } catch (err) {
    console.warn(`[WARN] Failed to parse ${path.basename(configPath)}: ${err.message}. Falling back to defaults.`)
    return DEFAULT_CONFIG
  }
}

module.exports = {
  DEFAULT_CONFIG,
  resolveConfigPath,
  clampInteger,
  normalizeOddSize,
  normalizeVersion,
  validateConfig,
  loadConfig
}
