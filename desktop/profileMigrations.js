'use strict'

const fs = require('fs')
const path = require('path')

const PROFILE_SCHEMA_VERSION = 2

function readJsonFile (filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tempPath, filePath)
}

function normalizeAuth (auth) {
  return String(auth || 'microsoft').toLowerCase() === 'offline' ? 'offline' : 'microsoft'
}

function normalizeProfileMeta (rawMeta, profileId) {
  const source = rawMeta && typeof rawMeta === 'object' ? { ...rawMeta } : {}
  const now = Date.now()
  const baseline = Number.isFinite(source.schemaVersion) ? source.schemaVersion : 1

  const normalized = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: String(source.id || profileId),
    name: String(source.name || source.profileName || profileId),
    auth: normalizeAuth(source.auth || source.authType),
    host: typeof source.host === 'string' && source.host.trim().length > 0
      ? source.host.trim()
      : (typeof source.serverHost === 'string' ? source.serverHost.trim() : undefined),
    username: typeof source.username === 'string' && source.username.trim().length > 0
      ? source.username.trim()
      : String(source.identity || source.email || source.offlineUsername || '').trim(),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now
  }

  if (!normalized.name) normalized.name = profileId
  if (!normalized.username) delete normalized.username
  if (!normalized.host) delete normalized.host

  const changed = baseline !== PROFILE_SCHEMA_VERSION || JSON.stringify(source) !== JSON.stringify(normalized)
  return { value: normalized, changed }
}

function mergeRefillDefaults (defaults, refill) {
  return {
    ...defaults,
    ...(refill || {}),
    thresholds: { ...(defaults.thresholds || {}), ...((refill && refill.thresholds) || {}) },
    targetStacks: { ...(defaults.targetStacks || {}), ...((refill && refill.targetStacks) || {}) }
  }
}

function normalizeConfigPayload (rawConfig, defaultConfig) {
  const source = rawConfig && typeof rawConfig === 'object' ? { ...rawConfig } : {}
  const baseline = Number.isFinite(source.schemaVersion) ? source.schemaVersion : 1
  const normalized = {
    ...defaultConfig,
    ...source,
    host: source.host || source.serverHost || defaultConfig.host,
    port: source.port || source.serverPort || defaultConfig.port,
    username: source.username || source.identity || source.email || source.offlineUsername || defaultConfig.username,
    auth: normalizeAuth(source.auth || source.authType || defaultConfig.auth),
    schemaVersion: PROFILE_SCHEMA_VERSION,
    origin: { ...defaultConfig.origin, ...(source.origin || {}) },
    safePlatform: { ...defaultConfig.safePlatform, ...(source.safePlatform || {}) },
    gui: { ...defaultConfig.gui, ...(source.gui || {}) },
    refill: mergeRefillDefaults(defaultConfig.refill || {}, source.refill)
  }

  const changed = baseline !== PROFILE_SCHEMA_VERSION || JSON.stringify(source) !== JSON.stringify(normalized)
  return { value: normalized, changed }
}

function migrateProfileFiles ({ profileId, metaPath, configPath, defaultConfig, validateConfig }) {
  const rawMeta = readJsonFile(metaPath)
  const metaResult = normalizeProfileMeta(rawMeta, profileId)
  if (metaResult.changed) writeJsonAtomic(metaPath, metaResult.value)

  const rawConfig = readJsonFile(configPath)
  if (rawConfig) {
    const cfgResult = normalizeConfigPayload(rawConfig, defaultConfig)
    const validated = validateConfig(cfgResult.value)
    if (cfgResult.changed || JSON.stringify(rawConfig) !== JSON.stringify(validated)) {
      writeJsonAtomic(configPath, validated)
    }
    return { meta: metaResult.value, config: validated }
  }

  return { meta: metaResult.value, config: null }
}

function migrateConfigFileIfNeeded ({ configPath, defaultConfig, validateConfig }) {
  const raw = readJsonFile(configPath)
  if (!raw) return { config: null, migrated: false }

  const cfgResult = normalizeConfigPayload(raw, defaultConfig)
  const validated = validateConfig(cfgResult.value)
  const changed = cfgResult.changed || JSON.stringify(raw) !== JSON.stringify(validated)
  if (changed) writeJsonAtomic(configPath, validated)
  return { config: validated, migrated: changed }
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  writeJsonAtomic,
  normalizeProfileMeta,
  normalizeConfigPayload,
  migrateProfileFiles,
  migrateConfigFileIfNeeded
}
