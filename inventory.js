'use strict'

function createInventoryManager ({ getBot, cfg }) {
  function itemCountByName (name) {
    const bot = getBot()
    return bot.inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0)
  }

  async function equipItem (itemName, destination = 'hand') {
    const bot = getBot()
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (!item) {
      throw new Error(`Missing inventory item: ${itemName}`)
    }
    await bot.equip(item, destination)
  }

  function requireInventoryForLayer (remainingCells) {
    const sand = itemCountByName('sand')
    const cactus = itemCountByName('cactus')
    const stringCount = itemCountByName('string')
    const buffer = Math.ceil(remainingCells * 0.05)
    const needed = remainingCells + buffer

    if (sand < needed || cactus < needed || stringCount < needed) {
      throw new Error(`Insufficient inventory for remaining ${remainingCells} cells (+${buffer} buffer). sand=${sand}, cactus=${cactus}, string=${stringCount}`)
    }
  }

  function hasRequiredInventoryForRemaining (remainingCells) {
    const sand = itemCountByName('sand')
    const cactus = itemCountByName('cactus')
    const stringCount = itemCountByName('string')
    const buffer = Math.ceil(remainingCells * 0.05)
    const needed = remainingCells + buffer
    return sand >= needed && cactus >= needed && stringCount >= needed
  }

  function requireCobblestoneForLayer (layerIndex) {
    const cellsPerLayer = 16 * 16
    const spineNeeded = (layerIndex + 1) * 4
    const conservativeScaffoldNeeded = cfg.removeScaffold ? cellsPerLayer : 0
    const needed = spineNeeded + conservativeScaffoldNeeded
    const cobble = itemCountByName('cobblestone')

    if (cobble < needed) {
      throw new Error(`Insufficient cobblestone for layer ${layerIndex + 1}. needed~=${needed}, have=${cobble}`)
    }
  }

  function getMaterialCounts () {
    const bot = getBot()
    const thresholds = cfg && cfg.refill ? cfg.refill.thresholds : null
    const items = {}
    const low = {}

    if (!bot) {
      return { items, thresholds, low }
    }

    const tracked = thresholds ? Object.keys(thresholds) : []
    for (const name of tracked) {
      const count = itemCountByName(name)
      items[name] = count
      low[name] = thresholds ? count < thresholds[name] : false
    }

    return { items, thresholds, low }
  }

  function getInventorySnapshot () {
    return getMaterialCounts()
  }

  return {
    itemCountByName,
    equipItem,
    requireInventoryForLayer,
    hasRequiredInventoryForRemaining,
    requireCobblestoneForLayer,
    getMaterialCounts,
    getInventorySnapshot
  }
}

module.exports = { createInventoryManager }
