'use strict'

function createRefillManager ({ getBot, cfg, goals, itemCountByName, hasRequiredInventoryForRemaining, requireInventoryForLayer, isBusyPlacing, sleepTicks, log }) {
  let lastRefillAttemptAtMs = 0
  let lastLowInventoryWarnAtMs = 0
  const ignoredContainerUntilMs = new Map()

  function reset () {
    lastRefillAttemptAtMs = 0
    lastLowInventoryWarnAtMs = 0
    ignoredContainerUntilMs.clear()
  }

  function needsRefillByThreshold () {
    if (!cfg.refill.enabled) return false
    const t = cfg.refill.thresholds
    return itemCountByName('sand') < t.sand ||
      itemCountByName('cactus') < t.cactus ||
      itemCountByName('string') < t.string ||
      itemCountByName('cobblestone') < t.cobblestone
  }

  function refillTargetsByItem () {
    const stacks = cfg.refill.targetStacks
    return {
      sand: stacks.sand * 64,
      cactus: stacks.cactus * 64,
      string: stacks.string * 64,
      cobblestone: stacks.cobblestone * 64
    }
  }

  function logLowInventoryWarning () {
    const now = Date.now()
    if ((now - lastLowInventoryWarnAtMs) < 45000) return
    lastLowInventoryWarnAtMs = now
    log(`[WARN] Materials low. Place a chest/barrel nearby to refill. sand=${itemCountByName('sand')}, cactus=${itemCountByName('cactus')}, string=${itemCountByName('string')}, cobblestone=${itemCountByName('cobblestone')}`)
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
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1))

    const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5))
    if (dist > 4) {
      throw new Error(`Could not get close enough to container at ${pos.toString()}`)
    }
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

    const want = Math.min(targetCount - current, available)
    if (want <= 0) return 0

    await container.withdraw(itemInfo.id, null, want)
    return want
  }

  async function tryOpportunisticRefill (force = false) {
    const bot = getBot()
    if (!cfg.refill.enabled) return false
    if (!bot || isBusyPlacing()) return false
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
          log(`[INFO] Refill complete from ${containerBlock.name}: +${taken.sand} sand, +${taken.cactus} cactus, +${taken.string} string, +${taken.cobblestone} cobblestone.`)
          return true
        }

        ignoredContainerUntilMs.set(containerKey, Date.now() + cfg.refill.ignoreEmptyMs)
        return false
      } finally {
        container.close()
      }
    } catch (err) {
      ignoredContainerUntilMs.set(containerKey, Date.now() + 15000)
      log(`[WARN] Refill attempt failed: ${err.message}`)
      await sleepTicks(1)
      return false
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
    reset
  }
}

module.exports = { createRefillManager }
