'use strict'

function createRefillManager ({ getBot, cfg, goals, itemCountByName, hasRequiredInventoryForRemaining, requireInventoryForLayer, isBusyPlacing, isStableForRefill, sleepTicks, log, info, warn, onLog, onRefillStatus }) {
  const emitInfo = typeof info === 'function'
    ? info
    : (message) => {
        if (typeof onLog === 'function') onLog({ level: 'info', message })
        else if (typeof log === 'function') log(message)
      }
  const emitWarn = typeof warn === 'function'
    ? warn
    : (message) => {
        if (typeof onLog === 'function') onLog({ level: 'warn', message })
        else if (typeof log === 'function') log(message)
      }
  let lastRefillAttemptAtMs = 0
  let lastLowInventoryWarnAtMs = 0
  let lastRefillSuccessAtMs = null
  let lastRefillContainer = null
  const ignoredContainerUntilMs = new Map()

  function reset () {
    lastRefillAttemptAtMs = 0
    lastLowInventoryWarnAtMs = 0
    lastRefillSuccessAtMs = null
    lastRefillContainer = null
    ignoredContainerUntilMs.clear()
  }

  function needsRefillByThreshold () {
    const bot = getBot()
    if (!cfg.refill.enabled || !bot || !bot.inventory) return false
    const t = cfg.refill.thresholds
    return itemCountByName('sand') < t.sand ||
      itemCountByName('cactus') < t.cactus ||
      itemCountByName('string') < t.string ||
      itemCountByName('cobblestone') < t.cobblestone
  }

  
function getItemStackSize (itemName) {
  const bot = getBot()
  if (!bot || !bot.registry || !bot.registry.itemsByName) return 64
  const itemInfo = bot.registry.itemsByName[itemName]
  return itemInfo && Number.isFinite(itemInfo.stackSize) ? itemInfo.stackSize : 64
}

function freeSpaceForItem (itemName) {
  const bot = getBot()
  if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) return 0
  const stackSize = getItemStackSize(itemName)
  let free = 0

  for (const slot of bot.inventory.slots) {
    if (!slot) {
      free += stackSize
      continue
    }

    if (slot.name === itemName) {
      free += Math.max(0, stackSize - slot.count)
    }
  }

  return free
}

function refillTargetsByItem () {
    const stacks = cfg.refill.targetStacks
    return {
      sand: stacks.sand * getItemStackSize('sand'),
      cactus: stacks.cactus * getItemStackSize('cactus'),
      string: stacks.string * getItemStackSize('string'),
      cobblestone: stacks.cobblestone * getItemStackSize('cobblestone')
    }
  }

  function getRefillStatus () {
    const thresholds = cfg && cfg.refill ? cfg.refill.thresholds : null
    const items = {}
    const low = {}
    if (thresholds) {
      for (const name of Object.keys(thresholds)) {
        const count = itemCountByName(name)
        items[name] = count
        low[name] = count < thresholds[name]
      }
    }
    return {
      enabled: Boolean(cfg.refill && cfg.refill.enabled),
      needsRefill: needsRefillByThreshold(),
      thresholds,
      items,
      low,
      lastRefillAttemptAtMs: lastRefillAttemptAtMs || null,
      lastRefillSuccessAtMs,
      lastRefillContainer
    }
  }

  function logLowInventoryWarning () {
    const now = Date.now()
    if ((now - lastLowInventoryWarnAtMs) < 45000) return
    lastLowInventoryWarnAtMs = now
    emitWarn(`Materials low. Place a chest/barrel nearby to refill. sand=${itemCountByName('sand')}, cactus=${itemCountByName('cactus')}, string=${itemCountByName('string')}, cobblestone=${itemCountByName('cobblestone')}`)
  }

  function pruneIgnoredContainers () {
    if (ignoredContainerUntilMs.size < 200) return
    const now = Date.now()
    for (const [key, until] of ignoredContainerUntilMs.entries()) {
      if (until <= now) ignoredContainerUntilMs.delete(key)
    }
  }

  function findNearbyContainer (radius = cfg.refill.radius) {
    pruneIgnoredContainers()

    const bot = getBot()
    const base = bot.entity.position.floored()
    const now = Date.now()
    const names = new Set(['chest', 'trapped_chest', 'barrel'])

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const pos = base.offset(dx, dy, dz)
          const key = pos.toString()
          const ignoredUntil = ignoredContainerUntilMs.get(key) || 0
          if (ignoredUntil > now) continue

          const block = bot.blockAt(pos)
          if (!block || !names.has(block.name)) continue
          return block
        }
      }
    }

    return null
  }

  async function gotoContainerForInteraction (containerBlock) {
    const bot = getBot()
    const pos = containerBlock.position

    let lastErr = null
    for (const radius of [1, 2]) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, radius))
        const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5))
        if (dist <= 4.5) return
      } catch (err) {
        lastErr = err
      }
    }

    throw new Error(lastErr ? `Could not get close enough to container at ${pos.toString()}: ${lastErr.message}` : `Could not get close enough to container at ${pos.toString()}`)
  }

  async function withdrawItemIfNeeded (container, itemName, targetCount) {
    const bot = getBot()
    const current = itemCountByName(itemName)
    if (current >= targetCount) return 0

    const itemInfo = bot.registry.itemsByName[itemName]
    if (!itemInfo) return 0

    const available = container.containerItems()
      .filter(i => i.name === itemName)
      .reduce((sum, i) => sum + i.count, 0)
    if (available <= 0) return 0

    const free = freeSpaceForItem(itemName)
    if (free <= 0) return 0

    const want = Math.min(targetCount - current, available, free)
    if (want <= 0) return 0

    await container.withdraw(itemInfo.id, null, want)
    return want
  }

  async function tryOpportunisticRefill (force = false) {
    const bot = getBot()
    if (!cfg.refill.enabled) return false
    if (!bot || isBusyPlacing()) return false
    if (!isStableForRefill()) return false
    if (!force && !needsRefillByThreshold()) return false

    if (typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) return false

    const now = Date.now()
    if (!force && (now - lastRefillAttemptAtMs) < cfg.refill.cooldownMs) return false
    lastRefillAttemptAtMs = now

    logLowInventoryWarning()
    const containerBlock = findNearbyContainer(cfg.refill.radius)
    if (!containerBlock) return false

    const containerKey = containerBlock.position.toString()
    try {
      lastRefillContainer = {
        name: containerBlock.name,
        position: {
          x: containerBlock.position.x,
          y: containerBlock.position.y,
          z: containerBlock.position.z
        }
      }
      await gotoContainerForInteraction(containerBlock)
      const container = await bot.openContainer(containerBlock)
      try {
        const targets = refillTargetsByItem()
        const taken = {
          sand: await withdrawItemIfNeeded(container, 'sand', targets.sand),
          cactus: await withdrawItemIfNeeded(container, 'cactus', targets.cactus),
          string: await withdrawItemIfNeeded(container, 'string', targets.string),
          cobblestone: await withdrawItemIfNeeded(container, 'cobblestone', targets.cobblestone)
        }

        const totalTaken = taken.sand + taken.cactus + taken.string + taken.cobblestone
        if (totalTaken > 0) {
          lastRefillSuccessAtMs = Date.now()
          emitInfo(`Refill complete from ${containerBlock.name}: +${taken.sand} sand, +${taken.cactus} cactus, +${taken.string} string, +${taken.cobblestone} cobblestone.`)
          return true
        }

        ignoredContainerUntilMs.set(containerKey, Date.now() + cfg.refill.ignoreEmptyMs)
        return false
      } finally {
        container.close()
      }
    } catch (err) {
      ignoredContainerUntilMs.set(containerKey, Date.now() + 15000)
      emitWarn(`Refill attempt failed: ${err.message}`)
      await sleepTicks(1)
      return false
    } finally {
      if (typeof onRefillStatus === 'function') onRefillStatus(getRefillStatus())
    }
  }

  async function ensureInventoryForRemaining (remainingCells) {
    if (hasRequiredInventoryForRemaining(remainingCells)) return

    const refilled = await tryOpportunisticRefill(true)
    if (refilled && hasRequiredInventoryForRemaining(remainingCells)) return

    requireInventoryForLayer(remainingCells)
  }

  return {
    tryOpportunisticRefill,
    ensureInventoryForRemaining,
    needsRefillByThreshold,
    getRefillStatus,
    reset
  }
}

module.exports = { createRefillManager }
