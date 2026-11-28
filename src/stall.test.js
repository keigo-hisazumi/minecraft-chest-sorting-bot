// 移動が止まったときの立て直しのテスト（node --test で実行）

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { watchStall } = require('./stall')

function createBot({ moving }) {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, stopped: 0 }
  bot.pathfinder = { isMoving: () => moving, stop: () => bot.stopped++ }
  return bot
}

const notArrived = { isEnd: () => false }

test('watchStall: 動く経路があるのに止まったままなら、経路探索を止める', async () => {
  const bot = createBot({ moving: true })
  const watch = watchStall(bot, notArrived, 10)
  await new Promise((resolve) => setTimeout(resolve, 600))
  watch.stop()
  assert.equal(watch.stalled, true)
  assert.ok(bot.stopped > 0)
})

test('watchStall: 経路を探している間（動く経路がない間）は、止まったとみなさない', async () => {
  const bot = createBot({ moving: false })
  const watch = watchStall(bot, notArrived, 10)
  await new Promise((resolve) => setTimeout(resolve, 600))
  watch.stop()
  assert.equal(watch.stalled, false)
  assert.equal(bot.stopped, 0)
})
