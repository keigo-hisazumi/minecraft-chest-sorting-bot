const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { expansionSites, newChestSites, tableSites, DIRECTIONS } = require('./sites')

const CUBE = [[0, 0, 0, 1, 1, 1]]
const CENTER = { x: 0, y: 64, z: 0 }

// 高さ 63 に床がある平らな世界
function createWorld() {
  const blocks = new Map()
  const blockAt = (position) => {
    const set = blocks.get(position.toString())
    if (set) return { ...set, position }
    if (position.y === 63) return { name: 'stone', boundingBox: 'block', shapes: CUBE, position }
    return { name: 'air', boundingBox: 'empty', shapes: [], position }
  }
  const put = (x, y, z, name, extra = {}) =>
    blocks.set(new Vec3(x, y, z).toString(), { name, boundingBox: 'block', shapes: CUBE, ...extra })
  const chest = (x, z, facing = 'north', type = 'single') =>
    put(x, 64, z, 'chest', { shapes: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]], transparent: true, getProperties: () => ({ facing, type }) })
  return { blockAt, put, chest }
}

const cells = (sites) => sites.map((s) => [s.cell.x, s.cell.z])

test('単体チェストは、向きの左右に広げ、正面に立つ', () => {
  const { blockAt, chest } = createWorld()
  chest(5, 0)
  const sites = expansionSites(blockAt, { x: 5, y: 64, z: 0 }, CENTER)
  assert.deepEqual(cells(sites).sort(), [
    [4, 0],
    [6, 0]
  ])
  for (const site of sites) {
    assert.equal(site.facing, 'north')
    assert.deepEqual(site.front, site.cell.plus(DIRECTIONS.north))
  }
})

test('上や正面がふさがっている場所と、床がない場所には広げない', () => {
  for (const block of [
    [4, 64, 0],
    [4, 65, 0],
    [4, 64, -1],
    [4, 65, -1]
  ]) {
    const world = createWorld()
    world.chest(5, 0)
    world.put(...block, 'stone')
    assert.deepEqual(cells(expansionSites(world.blockAt, { x: 5, y: 64, z: 0 }, CENTER)), [[6, 0]], String(block))
  }
  const world = createWorld()
  world.chest(5, 0)
  world.put(4, 63, 0, 'air', { boundingBox: 'empty', shapes: [] })
  assert.deepEqual(cells(expansionSites(world.blockAt, { x: 5, y: 64, z: 0 }, CENTER)), [[6, 0]])
})

test('元のチェストの上がふさがっている場合は広げない', () => {
  const { blockAt, chest, put } = createWorld()
  chest(5, 0)
  put(5, 65, 0, 'stone')
  assert.deepEqual(expansionSites(blockAt, { x: 5, y: 64, z: 0 }, CENTER), [])
})

test('別の単体チェストと繋がる場所と、チェストの正面には置かない', () => {
  const merge = createWorld()
  merge.chest(5, 0)
  merge.chest(3, 0)
  assert.deepEqual(cells(expansionSites(merge.blockAt, { x: 5, y: 64, z: 0 }, CENTER)), [[6, 0]])

  const blocking = createWorld()
  blocking.chest(5, 0)
  // (4, 0) を正面にするチェスト
  blocking.chest(3, 0, 'east')
  assert.deepEqual(cells(expansionSites(blocking.blockAt, { x: 5, y: 64, z: 0 }, CENTER)), [[6, 0]])

  const beside = createWorld()
  beside.chest(5, 0)
  // 大きなチェストの隣は、繋がらないため置ける
  beside.chest(3, 0, 'north', 'right')
  assert.equal(expansionSites(beside.blockAt, { x: 5, y: 64, z: 0 }, CENTER).length, 2)
})

test('扉の隣と、範囲の外には置かない', () => {
  const { blockAt, chest, put } = createWorld()
  chest(32, 0)
  put(30, 64, 0, 'oak_door')
  assert.deepEqual(expansionSites(blockAt, { x: 32, y: 64, z: 0 }, CENTER), [])
})

test('新しい大きなチェストは、条件を満たす 2 マスを中心の近くから選ぶ', () => {
  const { blockAt, chest } = createWorld()
  chest(0, 0)
  const sites = newChestSites(blockAt, CENTER, 'north')
  for (let i = 0; i < 20; i++) {
    const [first, second] = sites.next().value
    assert.equal(first.facing, second.facing)
    assert.equal(first.cell.distanceTo(second.cell), 1)
    for (const { cell, front, facing } of [first, second]) {
      assert.deepEqual(front, cell.plus(DIRECTIONS[facing]))
      // 元のチェストと、その正面は使わない
      assert.ok(!cell.equals(new Vec3(0, 64, 0)) && !cell.equals(new Vec3(0, 64, -1)))
      assert.equal(cell.y, 64)
    }
  }
})

test('置ける場所がなければ、候補を返さない', () => {
  const blockAt = (position) => ({ name: 'stone', boundingBox: 'block', shapes: CUBE, position })
  assert.equal(newChestSites(blockAt, CENTER).next().done, true)
  assert.equal(tableSites(blockAt, CENTER).next().done, true)
})
