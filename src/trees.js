// 自然の木の判定
// 建築物の原木を壊さないように、自然に生えた形と言い切れる木だけを対象にする。ブロックを参照するだけで、操作はしない。

const { Vec3 } = require('vec3')

// 伐採する地上の木の種類と、通知に使う名前
const TREE_LABELS = {
  oak: 'オーク',
  spruce: 'トウヒ',
  birch: 'シラカバ',
  jungle: 'ジャングル',
  acacia: 'アカシア',
  cherry: 'サクラ',
  dark_oak: 'ダークオーク',
  pale_oak: 'ペールオーク'
}
const TREE_TYPES = Object.keys(TREE_LABELS)
const LOG_NAMES = TREE_TYPES.map((type) => `${type}_log`)

// 1 本の木とみなす原木の数の上限
const MAX_LOGS = 32
// 地上から全部の原木に手が届く、根元からの高さと水平の広がりの上限
const MAX_HEIGHT = 5
const MAX_SPREAD = 2
// 自然の木とみなすのに必要な、原木に接した葉の数
const MIN_LEAVES = 4

// 木の根元になる地面
const SOIL = new Set([
  'grass_block',
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'podzol',
  'mycelium',
  'mud',
  'moss_block',
  'pale_moss_block'
])

// 原木の隣にあっても自然とみなすブロック（空気と、自然に生えるもの）
const NATURAL = new RegExp(
  '^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|bush|firefly_bush|dead_bush|short_dry_grass|tall_dry_grass|' +
    'vine|glow_lichen|hanging_roots|snow|moss_carpet|pale_moss_carpet|pale_hanging_moss|leaf_litter|wildflowers|pink_petals|' +
    'dandelion|poppy|blue_orchid|allium|azure_bluet|\\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|' +
    'rose_bush|peony|(open|closed)_eyeblossom|brown_mushroom|red_mushroom|sweet_berry_bush|cocoa|bee_nest)$'
)

const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
].map(([x, y, z]) => new Vec3(x, y, z))
const AROUND = []
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) {
      if (x || y || z) AROUND.push(new Vec3(x, y, z))
    }
  }
}

const isLeaves = (block) => Boolean(block?.name.endsWith('_leaves'))
// プレイヤーが置いた葉は persistent が付く
const isPlacedLeaves = (block) => isLeaves(block) && String(block.getProperties().persistent) === 'true'
const isNaturalLeaves = (block) => isLeaves(block) && !isPlacedLeaves(block)

// 同じ種類の原木のつながりを集める（斜めも含む）。上限を超えたら途中でやめる
function connectedLogs(blockAt, start, name) {
  const found = new Map([[start.toString(), start]])
  const queue = [start]
  while (queue.length > 0 && found.size <= MAX_LOGS) {
    const position = queue.shift()
    for (const offset of AROUND) {
      const next = position.plus(offset)
      if (found.has(next.toString()) || blockAt(next)?.name !== name) continue
      found.set(next.toString(), next)
      queue.push(next)
    }
  }
  return [...found.values()]
}

/**
 * 原木のつながりが、伐採してよい自然の木かを判定する
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} start 原木の座標
 * @returns {{ ok: boolean, reason?: 'built' | 'tall', type: string, logs: Vec3[], base: Vec3[] }}
 *   logs は低い順。base は根元の原木。built は建築物の可能性、tall は手が届かない大きさ
 */
function analyzeTree(blockAt, start) {
  const name = blockAt(start).name
  const type = name.slice(0, -'_log'.length)
  const logs = connectedLogs(blockAt, start, name).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
  const base = logs.filter((p) => p.y === logs[0].y)
  const tree = { ok: false, type, logs, base }
  const rejected = (reason) => ({ ...tree, reason })
  if (logs.length > MAX_LOGS) return rejected('built')
  // 根元はすべて地面の上にある
  if (!base.every((p) => SOIL.has(blockAt(p.offset(0, -1, 0))?.name))) return rejected('built')
  const natural = (block) =>
    Boolean(block) && (block.name === name || isNaturalLeaves(block) || SOIL.has(block.name) || NATURAL.test(block.name))
  // 原木の隣に、人が置いたと考えられるブロックがあれば対象にしない
  if (!logs.every((p) => FACES.every((face) => natural(blockAt(p.plus(face)))))) return rejected('built')
  const leaves = new Set()
  for (const position of logs) {
    for (const offset of AROUND) {
      const next = position.plus(offset)
      const block = blockAt(next)
      if (block?.name === `${type}_leaves` && isNaturalLeaves(block)) leaves.add(next.toString())
    }
  }
  if (leaves.size < MIN_LEAVES) return rejected('built')
  const reachable = logs.every(
    (p) => p.y - base[0].y <= MAX_HEIGHT && Math.abs(p.x - base[0].x) <= MAX_SPREAD && Math.abs(p.z - base[0].z) <= MAX_SPREAD
  )
  return reachable ? { ...tree, ok: true } : rejected('tall')
}

module.exports = { TREE_LABELS, TREE_TYPES, LOG_NAMES, SOIL, analyzeTree, isNaturalLeaves, isPlacedLeaves }
