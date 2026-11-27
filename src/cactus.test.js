const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { throwSites, aimPitch } = require('./cactus')

const CUBE = [[0, 0, 0, 1, 1, 1]]
const CACTUS = new Vec3(0, 64, 0)

function createWorld() {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(new Vec3(x, y, z).toString(), name)
  put(0, 64, 0, 'cactus')
  const blockAt = (position) => {
    const name = blocks.get(position.toString()) ?? (position.y === 63 ? 'sand' : 'air')
    return name === 'air' || name === 'cactus' ? { name, boundingBox: 'empty', shapes: [] } : { name, boundingBox: 'block', shapes: CUBE }
  }
  const stands = () => throwSites(blockAt, CACTUS).map((s) => [s.stand.x, s.stand.z])
  return { put, stands }
}

test('サボテンから 1 マス空けた場所に立つ', () => {
  assert.deepEqual(createWorld().stands(), [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2]
  ])
})

test('間や立つ場所がふさがっている方向と、床がない方向からは投げない', () => {
  const world = createWorld()
  world.put(1, 64, 0, 'stone')
  world.put(-2, 65, 0, 'stone')
  world.put(0, 63, 2, 'air')
  assert.deepEqual(world.stands(), [[0, -2]])
})

test('別のサボテンに触れる場所には立たない', () => {
  const world = createWorld()
  world.put(3, 64, 1, 'cactus')
  assert.ok(!world.stands().some(([x, z]) => x === 2 && z === 0))
})

test('投げる角度は、距離が近いほど下を向く', () => {
  const near = aimPitch(1.6, 0.6)
  const far = aimPitch(2.6, 0.6)
  assert.ok(near < far, `${near} ${far}`)
  assert.ok(Math.abs(far) < 0.7)
})
