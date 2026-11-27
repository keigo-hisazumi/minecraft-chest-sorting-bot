const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { planBuild } = require('./builder')
const { planksPerLog, isPlank } = require('./crafting')
const { emptyAssignments } = require('./state')
const { createFakeBot } = require('./fakebot')

const CENTER = { x: 0, y: 64, z: 0 }
const stacks = (name, n) => Array.from({ length: n }, () => ({ name, count: 64, stackSize: 64, variant: '', protected: false }))

// 床のある世界に、指定チェストと整理先を置く
function setup({ sourceItems = [], chests = [], failed = [], blocked = false } = {}) {
  const bot = createFakeBot()
  bot.inventory = { inventoryStart: 9, slots: [] }
  const blockAt = bot.blockAt
  bot.blockAt = (position) => {
    const block = blockAt(position)
    if (block.name !== 'air') return { boundingBox: 'block', transparent: true, ...block }
    if (position.y === 63 || blocked) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position }
    return { ...block, boundingBox: 'empty' }
  }
  const record = (x, positions, items = []) => {
    if (positions === 1) bot.putChest(x, 64, 0)
    else bot.putLargeChest(x, 64, 0)
    return { positions: Array.from({ length: positions }, (v, i) => ({ x: x + i, y: 64, z: 0 })), items }
  }
  const source = record(0, 1, sourceItems)
  const survey = { source, chests: chests.map(([x, positions, items]) => record(x, positions, items)), failed }
  const world = { source: { positions: source.positions }, assignments: emptyAssignments() }
  return planBuild(bot, survey, world, new Vec3(CENTER.x, CENTER.y, CENTER.z))
}

test('整理先の単体チェストは広げ、足りない大きなチェストを数える', () => {
  const plan = setup({ sourceItems: [...stacks('stone', 3), ...stacks('sand', 3), ...stacks('dirt', 1)], chests: [[5, 1]] })
  assert.equal(plan.expansions.length, 1)
  // 専用 2 つと混合 1 つのうち、1 つは広げるチェストで足りる
  assert.equal(plan.newChests, 2)
  assert.deepEqual(plan.blocked, [])
})

test('足りていれば、新しく作らない', () => {
  const plan = setup({ sourceItems: stacks('stone', 3), chests: [[5, 2]] })
  assert.equal(plan.expansions.length + plan.newChests, 0)
})

test('広げられない単体チェストは、専用にできないものとして数える', () => {
  const plan = setup({ sourceItems: stacks('stone', 3), chests: [[5, 1]], blocked: true })
  assert.equal(plan.expansions.length, 0)
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.newChests, 1)
})

test('調べられないチェストがあれば、新しく作らない', () => {
  const plan = setup({ sourceItems: stacks('stone', 3), failed: [{ positions: [{ x: 9, y: 64, z: 0 }], reason: '開けません' }] })
  assert.equal(plan.newChests, 0)
  assert.ok(plan.skippedNew)
})

test('材料にする板材と原木', () => {
  const item = (name, isProtected = false) => ({ name, protected: isProtected })
  assert.ok(isPlank(item('oak_planks')))
  assert.ok(!isPlank(item('oak_planks', true)))
  for (const name of ['oak_log', 'stripped_dark_oak_wood', 'pale_oak_log', 'crimson_stem', 'stripped_warped_hyphae']) {
    assert.equal(planksPerLog(item(name)), 4, name)
  }
  assert.equal(planksPerLog(item('bamboo_block')), 2)
  for (const name of ['mushroom_stem', 'oak_planks', 'oak_sign', 'bamboo']) assert.equal(planksPerLog(item(name)), 0, name)
  assert.equal(planksPerLog(item('oak_log', true)), 0)
})
