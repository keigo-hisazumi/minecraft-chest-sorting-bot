const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { allowPlantReplacement, escape, findStep, isInPit } = require('./escape')

// 高さ 63 以下が土の世界。holes の座標は空気、put で置いたブロックはその名前になる
// BOT は (0, 61, 0) に立つ（足元のマスと、その上の 2 マスが空いた、深さ 3 の 1 ブロックの穴）
function setup({ holes = [], put = {}, blocks = 0 } = {}) {
  const world = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  for (const [x, y, z] of [[0, 61, 0], [0, 62, 0], [0, 63, 0], ...holes]) world.set(`${x},${y},${z}`, 'air')
  for (const [k, name] of Object.entries(put)) world.set(k, name)
  const blockAt = (p) => {
    const name = world.get(key(p)) ?? (p.y <= 63 ? 'dirt' : 'air')
    const boundingBox = name === 'air' || name === 'short_grass' || name === 'poppy' ? 'empty' : 'block'
    return { name, position: p, boundingBox }
  }
  const controls = {}
  let look = null
  const events = []
  const bot = {
    held: blocks,
    entity: { position: new Vec3(0.5, 61, 0.5), onGround: true },
    blockAt,
    dig: async (block) => {
      events.push(`dig ${block.name} ${key(block.position)}`)
      world.set(key(block.position), 'air')
    },
    lookAt: async (p) => {
      look = p
    },
    setControlState: (name, value) => {
      controls[name] = value
    },
    waitForTicks: async () => {
      if (!controls.forward || !look) return
      // 向いているマスへ 1 tick で移る。ジャンプしていれば、1 段上がる
      const here = bot.entity.position
      const cell = new Vec3(Math.floor(look.x), Math.floor(here.y), Math.floor(look.z))
      const blocked = blockAt(cell).boundingBox === 'block'
      if (blocked && !controls.jump) return
      bot.entity.position = new Vec3(cell.x + 0.5, here.y + (blocked ? 1 : 0), cell.z + 0.5)
    }
  }
  // 1 段積んで登る（足元にブロックを置き、1 つ上に立つ）
  const tower = async () => {
    const feet = bot.entity.position.floored()
    world.set(key(feet), 'dirt')
    events.push(`place ${key(feet)}`)
    bot.held--
    bot.entity.position = bot.entity.position.offset(0, 1, 0)
    return feet
  }
  const holdBlock = async () => bot.held > 0
  const messages = []
  return { bot, world, events, messages, ops: { holdBlock, tower, notify: (m) => messages.push(m) } }
}

test('allowPlantReplacement: 足場を置くと置き換わる草だけを、置き換えられるブロックに加える', () => {
  const registry = { blocksByName: { short_grass: { id: 1, boundingBox: 'empty' }, poppy: { id: 2, boundingBox: 'empty' } } }
  const movements = allowPlantReplacement({ replaceables: new Set([0]) }, registry)
  assert.deepEqual([...movements.replaceables], [0, 1])
})

test('isInPit: 周りを 2 段以上の壁に囲まれていれば穴の中とみなす', () => {
  const { bot } = setup()
  const blockAt = (p) => bot.blockAt(p)
  // 深さ 3 の穴の底
  assert.equal(isInPit(blockAt, new Vec3(0, 61, 0)), true)
  // 深さ 1 なら、1 段跳び上がって出られる
  assert.equal(isInPit(blockAt, new Vec3(0, 63, 0)), false)
})

test('isInPit: 隣が空いていれば穴の中とみなさない', () => {
  const { bot } = setup({ holes: [[1, 61, 0], [1, 62, 0]] })
  assert.equal(isInPit((p) => bot.blockAt(p), new Vec3(0, 61, 0)), false)
})

test('findStep: 自然の地形の壁だけを掘って段を作る', () => {
  const { bot } = setup({ put: { '1,62,0': 'oak_planks', '1,63,0': 'oak_planks' } })
  const plan = findStep((p) => bot.blockAt(p), new Vec3(0, 61, 0))
  // 東の壁は板材（人が置いた物）なので使わず、西の土の壁に段を作る
  assert.deepEqual(plan.step, new Vec3(-1, 62, 0))
  assert.deepEqual(plan.dig, [new Vec3(-1, 62, 0), new Vec3(-1, 63, 0)])
})

test('findStep: 掘ってはいけないマスは掘らない', () => {
  const { bot } = setup()
  const plan = findStep((p) => bot.blockAt(p), new Vec3(0, 61, 0), (p) => p.x !== 1)
  assert.deepEqual(plan.step, new Vec3(-1, 62, 0))
})

test('findStep: 周りがすべて人が置いたブロックなら段を作らない', () => {
  const put = {}
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const y of [62, 63]) put[`${x},${y},${z}`] = 'cobblestone'
  }
  const { bot } = setup({ put })
  assert.equal(findStep((p) => bot.blockAt(p), new Vec3(0, 61, 0)), null)
})

test('escape: 穴の中で足場のブロックを持っていれば、積んで登って抜け出す', async () => {
  const { bot, events, messages, ops } = setup({ blocks: 5 })
  assert.equal(await escape(bot, ops), true)
  assert.deepEqual(events, ['place 0,61,0', 'place 0,62,0'])
  assert.deepEqual(bot.entity.position.floored(), new Vec3(0, 63, 0))
  assert.deepEqual(messages, ['脱出します: 穴の中 (0, 61, 0)（動けなくなったため、登って抜け出します）', '脱出しました: 穴の中 (0, 61, 0)'])
})

test('escape: 足場のブロックがなければ、土の壁を掘って段を作り、登って抜け出す', async () => {
  const { bot, events, ops } = setup()
  assert.equal(await escape(bot, ops), true)
  assert.ok(events.includes('dig dirt 1,62,0'))
  assert.ok(events.includes('dig dirt 1,63,0'))
  // 段に登ったあとは、穴の縁へ 1 段跳び上がって出られる
  assert.deepEqual(bot.entity.position.floored(), new Vec3(1, 62, 0))
})

test('escape: 足場もなく、掘れる壁もなければ、抜け出せないことを知らせる', async () => {
  const put = {}
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const y of [62, 63]) put[`${x},${y},${z}`] = 'cobblestone'
  }
  const { bot, messages, ops } = setup({ put })
  assert.equal(await escape(bot, ops), false)
  assert.match(messages.at(-1), /^脱出できませんでした: 穴の中 \(0, 61, 0\)/)
})

test('escape: 穴の中でなければ、経路の途中で止まったときだけ、隣のマスへ 1 歩よける', async () => {
  const { bot, ops } = setup({ holes: [[1, 61, 0], [1, 62, 0]] })
  assert.equal(await escape(bot, ops), false)
  assert.deepEqual(bot.entity.position.floored(), new Vec3(0, 61, 0))
  assert.equal(await escape(bot, { ...ops, stalled: true }), true)
  assert.deepEqual(bot.entity.position.floored(), new Vec3(1, 61, 0))
})
