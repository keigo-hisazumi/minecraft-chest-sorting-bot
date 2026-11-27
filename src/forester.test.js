const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { gatherWood } = require('./forester')

// 斧を持った BOT と、自然のオークが 1 本だけある世界。掘ったブロックは空気になる
function setup() {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(new Vec3(x, y, z).toString(), name)
  for (let y = 64; y < 68; y++) put(0, y, 0, 'oak_log')
  for (const [x, z] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]) {
    put(x, 67, z, 'oak_leaves')
  }
  const logs = [64, 65, 66, 67].map((y) => new Vec3(0, y, 0))
  const events = []
  const slots = []
  slots[36] = { name: 'wooden_axe', count: 1, stackSize: 1 }
  const bot = {
    entity: { position: new Vec3(2.5, 64, 0.5) },
    entities: {},
    inventory: { inventoryStart: 9, slots },
    registry: { blocksByName: { oak_log: { id: 1 } }, blocksArray: [] },
    findBlocks: () => logs.filter((p) => blocks.get(p.toString()) === 'oak_log'),
    blockAt(position) {
      const name = blocks.get(position.toString()) ?? (position.y === 63 ? 'grass_block' : 'air')
      return { name, position, getProperties: () => ({ persistent: false }) }
    },
    canDigBlock: () => true,
    async dig(block) {
      events.push(`dig ${block.name} ${block.position.y}`)
      blocks.delete(block.position.toString())
    },
    placeBlock: async () => events.push('place'),
    setQuickBarSlot() {},
    waitForTicks: async () => {}
  }
  const context = {
    bot,
    navigator: { moveTo: async () => ({ status: 'arrived' }) },
    signal: new AbortController().signal,
    center: { x: 0, y: 64, z: 0 },
    notify: (message) => events.push(message),
    getTable: async () => null,
    failed: []
  }
  return { context, events }
}

test('伐採する前に通知し、原木だけを切って、植え直さずに場所を記録する', async () => {
  const { context, events } = setup()
  let saved = null
  const result = await gatherWood(context, {
    wanted: 16,
    records: [],
    pending: [],
    savePending: (spots) => {
      saved = spots
    }
  })
  assert.deepEqual(events, [
    '伐採します: オーク (0, 64, 0)',
    'dig oak_log 64',
    'dig oak_log 65',
    'dig oak_log 66',
    'dig oak_log 67'
  ])
  assert.deepEqual(saved, [{ x: 0, y: 64, z: 0, name: 'oak_sapling' }])
  assert.equal(result.trees, 1)
  assert.equal(result.logs, 4)
  assert.ok(result.exhausted)
})
