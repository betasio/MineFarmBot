'use strict'

function createHumanizer ({ getBot, sleepTicks }) {
  let lastHumanLookAtMs = 0
  let busyPlacing = false

  function setBusyPlacing (busy) {
    busyPlacing = Boolean(busy)
  }

  function isBusyPlacing () {
    return busyPlacing
  }

  function reset () {
    lastHumanLookAtMs = 0
    busyPlacing = false
  }

  async function randomHeadMovement () {
    const bot = getBot()
    if (!bot || busyPlacing || Math.random() > 0.03) return
    if ((Date.now() - lastHumanLookAtMs) < 2000) return

    lastHumanLookAtMs = Date.now()
    const yaw = bot.entity.yaw + ((Math.random() - 0.5) * 1.2)
    const pitch = (Math.random() - 0.5) * 0.4

    try {
      await bot.look(yaw, pitch, true)
      await sleepTicks(5 + Math.floor(Math.random() * 10))
    } catch (err) {
      // ignore humanizer movement failures
    }
  }

  return {
    setBusyPlacing,
    isBusyPlacing,
    randomHeadMovement,
    reset
  }
}

module.exports = { createHumanizer }
