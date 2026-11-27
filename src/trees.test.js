const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { analyzeTree } = require('./trees')

// 高さ 63 に草ブロックがあり、(0, 64, 0) から自然のオークが生えた世界
function createWorld({ height = 5, leaves = true } = {}) {
  const blocks = new Map()
  const put = (x, y, z, name, properties = {}) => blocks.set(new Vec3(x, y, z).toString(), { name, properties })
  const blockAt = (position) => {
    const set = blocks.get(position.toString())
    const name = set?.name ?? (position.y === 63 ? 'grass_block' : 'air')
    return { name, position, getProperties: () => set?.properties ?? {} }
  }
  for (let y = 0; y < height; y++) put(0, 64 + y, 0, 'oak_log')
  if (leaves) {
    const top = 64 + height - 1
    for (const [x, z] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ]) {
      put(x, top, z, 'oak_leaves', { persistent: false })
    }
    put(0, top + 1, 0, 'oak_leaves', { persistent: false })
  }
  const analyze = () => analyzeTree(blockAt, new Vec3(0, 64, 0))
  return { put, analyze }
}

test('地面から生えて自然の葉がある幹は、伐採してよい', () => {
  const tree = createWorld().analyze()
  assert.ok(tree.ok)
  assert.equal(tree.type, 'oak')
  assert.deepEqual(
    tree.logs.map((p) => p.y),
    [64, 65, 66, 67, 68]
  )
  assert.deepEqual(tree.base, [new Vec3(0, 64, 0)])
})

test('葉がない原木の柱は、建築物とみなす', () => {
  assert.equal(createWorld({ leaves: false }).analyze().reason, 'built')
})

test('プレイヤーが置いた葉だけの柱や、置いた葉に接した幹は対象にしない', () => {
  const placed = createWorld({ leaves: false })
  for (const x of [-1, 1]) {
    placed.put(x, 68, 0, 'oak_leaves', { persistent: true })
    placed.put(x, 67, 0, 'oak_leaves', { persistent: true })
  }
  assert.equal(placed.analyze().reason, 'built')

  const mixed = createWorld()
  mixed.put(1, 64, 0, 'oak_leaves', { persistent: 'true' })
  assert.equal(mixed.analyze().reason, 'built')
})

test('人が置くブロックが隣にある幹は対象にしない', () => {
  for (const name of ['oak_planks', 'glass_pane', 'torch', 'wall_torch', 'cobblestone', 'oak_fence', 'ladder', 'stripped_oak_log', 'oak_wood', 'spruce_log', 'water']) {
    const world = createWorld()
    world.put(1, 65, 0, name)
    assert.equal(world.analyze().reason, 'built', name)
  }
})

test('草花やつたが隣にあっても対象にする', () => {
  const world = createWorld()
  world.put(1, 64, 0, 'short_grass')
  world.put(-1, 64, 0, 'red_tulip')
  world.put(0, 65, 1, 'vine')
  world.put(0, 64, -1, 'dirt')
  assert.ok(world.analyze().ok)
})

test('根元が地面でない幹は対象にしない', () => {
  const world = createWorld()
  world.put(0, 63, 0, 'oak_planks')
  assert.equal(world.analyze().reason, 'built')
})

test('斜めに繋がった建築物の原木があれば、全体を対象にしない', () => {
  const world = createWorld()
  world.put(1, 69, 0, 'oak_log')
  world.put(2, 69, 0, 'oak_planks')
  assert.equal(world.analyze().reason, 'built')
})

test('手が届かない高さの木は切らない', () => {
  assert.equal(createWorld({ height: 8 }).analyze().reason, 'tall')
})
