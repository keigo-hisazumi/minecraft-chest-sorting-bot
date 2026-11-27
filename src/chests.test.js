const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { chestPositions, isInRange, findChests, findNearestChest } = require('./chests')
const { createFakeBot } = require('./fakebot')

const block = (type, facing) => ({ position: new Vec3(0, 64, 0), getProperties: () => ({ type, facing }) })

test('単体のチェストは座標が 1 つ', () => {
  assert.deepEqual(chestPositions(block('single', 'north')), [{ x: 0, y: 64, z: 0 }])
})

test('大きなチェストは、向きと左右からもう半分の座標を求める', () => {
  const cases = [
    ['left', 'north', 1, 0],
    ['left', 'east', 0, 1],
    ['left', 'south', -1, 0],
    ['left', 'west', 0, -1],
    ['right', 'north', -1, 0],
    ['right', 'east', 0, -1],
    ['right', 'south', 1, 0],
    ['right', 'west', 0, 1]
  ]
  for (const [type, facing, x, z] of cases) {
    const positions = chestPositions(block(type, facing))
    assert.equal(positions.length, 2)
    assert.ok(
      positions.some((p) => p.x === x && p.z === z),
      `${type} ${facing}`
    )
  }
})

test('範囲は水平 32、上下 8 ブロック', () => {
  const center = { x: 0, y: 64, z: 0 }
  assert.ok(isInRange(center, { x: 32, y: 72, z: -32 }))
  assert.ok(!isInRange(center, { x: 33, y: 64, z: 0 }))
  assert.ok(!isInRange(center, { x: 0, y: 64, z: -33 }))
  assert.ok(!isInRange(center, { x: 0, y: 73, z: 0 }))
  assert.ok(!isInRange(center, { x: 0, y: 55, z: 0 }))
})

test('範囲内のチェストをすべて返し、大きなチェストは 1 つにまとめる', () => {
  const bot = createFakeBot()
  bot.putChest(3, 64, 0)
  // 片方だけが範囲内の大きなチェスト
  bot.putLargeChest(32, 64, 0)
  bot.putChest(34, 64, 0)
  assert.deepEqual(findChests(bot, { x: 0, y: 64, z: 0 }), [
    [{ x: 3, y: 64, z: 0 }],
    [
      { x: 32, y: 64, z: 0 },
      { x: 33, y: 64, z: 0 }
    ]
  ])
})

test('範囲内で一番近いチェストを返し、除外したものと範囲外は選ばない', () => {
  const bot = createFakeBot()
  bot.putChest(10, 64, 0)
  bot.putChest(3, 64, 0)
  // 距離は近いが、上下の範囲外
  bot.putChest(0, 74, 0)
  assert.deepEqual(
    findNearestChest(bot, () => false),
    [{ x: 3, y: 64, z: 0 }]
  )
  assert.deepEqual(
    findNearestChest(bot, (positions) => positions[0].x === 3),
    [{ x: 10, y: 64, z: 0 }]
  )
  assert.equal(
    findNearestChest(bot, () => true),
    null
  )
})
