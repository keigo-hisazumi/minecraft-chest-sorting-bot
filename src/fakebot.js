// テスト用の簡易な BOT（ブロックの参照と検索だけを持つ）

const { Vec3 } = require('vec3')

function createFakeBot() {
  const blocks = new Map()
  const unloaded = new Set()
  const key = ({ x, y, z }) => `${x},${y},${z}`

  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    game: { dimension: 'overworld' },
    registry: { blocksByName: { chest: { id: 1 } } },
    blockAt(position) {
      if (unloaded.has(key(position))) return null
      return blocks.get(key(position)) ?? { name: 'air', position }
    },
    findBlocks() {
      return [...blocks.values()].filter((b) => b.name === 'chest').map((b) => b.position)
    },
    put(name, x, y, z, properties = { type: 'single', facing: 'north' }) {
      const position = new Vec3(x, y, z)
      blocks.set(key(position), { name, position, getProperties: () => properties })
    },
    putChest(x, y, z, properties) {
      bot.put('chest', x, y, z, properties)
    },
    // 北向きの大きなチェスト（x と x + 1）を置く
    putLargeChest(x, y, z) {
      bot.putChest(x, y, z, { type: 'left', facing: 'north' })
      bot.putChest(x + 1, y, z, { type: 'right', facing: 'north' })
    },
    remove(x, y, z) {
      blocks.delete(key({ x, y, z }))
    },
    unload(x, y, z) {
      unloaded.add(key({ x, y, z }))
    }
  }
  return bot
}

module.exports = { createFakeBot }
