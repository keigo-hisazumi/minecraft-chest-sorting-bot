// 大きな木の伐採のテスト（node --test で実行）

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { cutFromTrunk } = require('./climb')

// 高さ 63 が地面で、(0, 64, 0) から高さ height のオークの幹がある世界と、ジャンプと着地だけを真似る BOT の偽物
// 根元の 2 つの原木は、地上から切ったものとして、はじめから空いている
function createTallTree({ height = 12, blocks: holdable = 64, x = 0.5 } = {}) {
  const blocks = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  const put = (p, name) => blocks.set(key(p), name)
  const logs = []
  for (let y = 64; y < 64 + height; y++) logs.push(new Vec3(0, y, 0))
  for (const p of logs.slice(2)) put(p, 'oak_log')
  put(new Vec3(0, 64 + height, 0), 'oak_leaves')
  const blockAt = (p) => {
    const name = blocks.get(key(p)) ?? (p.y <= 63 ? 'grass_block' : 'air')
    return { name, position: p, diggable: true, getProperties: () => ({ persistent: false }) }
  }
  const solid = (p) => blockAt(p).name !== 'air'
  let jumping = false
  let forward = false
  // 体が隣の列にかかっていると、幹の周りの葉に頭がぶつかって跳べない
  const offCenter = () => Math.abs(bot.entity.position.x - 0.5) >= 0.2
  const bot = {
    placedCount: 0,
    held: holdable,
    entity: { position: new Vec3(x, 64, 0.5), onGround: true },
    blockAt,
    canDigBlock: (block) => block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1,
    setControlState(state, value) {
      if (state === 'jump') jumping = value
      if (state === 'forward') forward = value
    },
    async lookAt() {},
    async waitForTicks() {
      const p = bot.entity.position
      if (forward) {
        bot.entity.position = new Vec3(p.x + Math.sign(0.5 - p.x) * Math.min(0.1, Math.abs(0.5 - p.x)), p.y, p.z)
        return
      }
      if (jumping && bot.entity.onGround && !offCenter()) {
        bot.entity.position = new Vec3(p.x, Math.floor(p.y) + 1.2, p.z)
        bot.entity.onGround = false
        return
      }
      // 足元に何もなければ、下のブロックの上まで落ちる
      let y = Math.floor(p.y)
      while (!solid(new Vec3(0, y - 1, 0))) y--
      bot.entity.position = new Vec3(p.x, y, p.z)
      bot.entity.onGround = true
    },
    async placeBlock(reference, face) {
      put(reference.position.plus(face), 'oak_log')
      bot.placedCount++
      bot.held--
    },
    async dig(block) {
      blocks.delete(key(block.position))
      bot.entity.onGround = false
    }
  }
  const tree = { type: 'oak', logs, base: [logs[0]] }
  const ops = {
    dig: (block) => bot.dig(block),
    holdBlock: async () => bot.held > 0
  }
  return { bot, tree, ops, blockAt }
}

test('cutFromTrunk: 柱を積んで登り、高い原木まで切ってから、柱を掘って降りる', async () => {
  const { bot, tree, ops, blockAt } = createTallTree({ height: 12 })
  const cut = await cutFromTrunk(bot, tree, ops)
  assert.equal(cut, 10)
  assert.ok(tree.logs.every((p) => blockAt(p).name === 'air'), '原木と柱が残っていない')
  assert.ok(bot.placedCount > 0)
  assert.equal(bot.entity.position.y, 64)
})

test('cutFromTrunk: 積むブロックがなければ、届く原木だけを切って終える', async () => {
  const { bot, tree, ops, blockAt } = createTallTree({ height: 12, blocks: 0 })
  const cut = await cutFromTrunk(bot, tree, ops)
  assert.ok(cut > 0 && cut < 10)
  assert.equal(blockAt(new Vec3(0, 75, 0)).name, 'oak_log')
  assert.equal(bot.placedCount, 0)
})

test('cutFromTrunk: 中止されたら、登るのをやめて柱を掘って降りる', async () => {
  const { bot, tree, ops } = createTallTree({ height: 20 })
  let digs = 0
  const cancelAfter = 6
  const cut = await cutFromTrunk(bot, tree, {
    ...ops,
    dig: async (block) => {
      digs++
      await bot.dig(block)
    },
    isCancelled: () => digs >= cancelAfter
  })
  assert.ok(cut < 18)
  assert.equal(bot.entity.position.y, 64)
})

test('cutFromTrunk: 体が幹の列からはみ出していれば、中央へ寄ってから登る', async () => {
  const { bot, tree, ops, blockAt } = createTallTree({ height: 12, x: 0.85 })
  const cut = await cutFromTrunk(bot, tree, ops)
  assert.equal(cut, 10)
  assert.ok(tree.logs.every((p) => blockAt(p).name === 'air'))
  assert.ok(Math.abs(bot.entity.position.x - 0.5) < 0.15)
})

test('cutFromTrunk: 原木を残して登るのをやめたら、理由を知らせる', async () => {
  const { bot, tree, ops } = createTallTree({ height: 12, blocks: 0 })
  const reasons = []
  await cutFromTrunk(bot, tree, { ...ops, onStop: (reason) => reasons.push(reason) })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /^足場にするブロックを持っていません（残り \d+ 個）$/)
})
