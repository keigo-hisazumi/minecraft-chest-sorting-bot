// チェストと作業台を置く場所の選び方
// ブロックを参照するだけで、操作はしない。

const { Vec3 } = require('vec3')
const { CHEST_NAME, HORIZONTAL_RANGE, VERTICAL_RANGE, isInRange } = require('./chests')

const DIRECTIONS = {
  north: new Vec3(0, 0, -1),
  east: new Vec3(1, 0, 0),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0)
}
// 向きに対して左右の方向（大きなチェストが繋がる方向）
const SIDES = { north: ['east', 'west'], south: ['west', 'east'], east: ['south', 'north'], west: ['north', 'south'] }
const UP = new Vec3(0, 1, 0)
const DOWN = new Vec3(0, -1, 0)

const AIR = new Set(['air', 'cave_air', 'void_air'])
// 右クリックすると画面が開くなど、上に置くときの土台にしないブロック
const NOT_FLOOR = /chest|table|furnace|smoker|barrel|shulker_box|hopper|dispenser|dropper|crafter|anvil|loom|stonecutter|grindstone|beacon|note_block|jukebox|lectern|leaves/
// 横に置くと出入りをふさぐブロック
const DOORWAY = /door|fence_gate/

const isAir = (block) => Boolean(block) && AIR.has(block.name)
const isFullCube = (block) =>
  block?.boundingBox === 'block' && block.shapes?.length === 1 && block.shapes[0].join() === '0,0,0,1,1,1'
const isFloor = (block) => isFullCube(block) && !NOT_FLOOR.test(block.name)

/**
 * チェストか作業台を置くマスと、置くときに立つマスの条件を確かめる
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} cell 置くマス
 * @param {Vec3} front BOT が立つマス（チェストの正面）
 * @returns {boolean} 置ける場合は true
 */
function isFreeCell(blockAt, cell, front) {
  // 置くマスの上は、開けられるように空けておく
  if (!isAir(blockAt(cell)) || !isAir(blockAt(cell.plus(UP))) || !isFloor(blockAt(cell.plus(DOWN)))) return false
  // 正面は、立って開けられる通路にする
  if (!isAir(blockAt(front)) || !isAir(blockAt(front.plus(UP))) || !isFloor(blockAt(front.plus(DOWN)))) return false
  return Object.values(DIRECTIONS).every((direction) => {
    const neighbor = blockAt(cell.plus(direction))
    if (!neighbor) return false
    if (DOORWAY.test(neighbor.name)) return false
    if (neighbor.name !== CHEST_NAME) return true
    // 隣のチェストの正面はふさがない
    return !neighbor.position.plus(DIRECTIONS[neighbor.getProperties().facing]).equals(cell)
  })
}

/**
 * 置いたチェストが、意図しない単体チェストと繋がらないかを確かめる
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} cell 置くマス
 * @param {string} facing 置くチェストの向き
 * @param {Vec3} partner 繋げる相手のマス
 */
function connectsOnlyTo(blockAt, cell, facing, partner) {
  return SIDES[facing].every((side) => {
    const position = cell.plus(DIRECTIONS[side])
    if (position.equals(partner)) return true
    const neighbor = blockAt(position)
    if (neighbor?.name !== CHEST_NAME) return true
    const properties = neighbor.getProperties()
    return properties.type !== 'single' || properties.facing !== facing
  })
}

const placement = (cell, facing) => ({ cell, front: cell.plus(DIRECTIONS[facing]), facing })

/**
 * 単体チェストを大きなチェストにするために、隣へ置く場所を返す
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {{ x: number, y: number, z: number }} position 単体チェストの座標
 * @param {{ x: number, y: number, z: number }} center 範囲の中心（指定チェスト）
 * @returns {Array<{ cell: Vec3, front: Vec3, facing: string }>} 候補
 */
function expansionSites(blockAt, position, center) {
  const chest = blockAt(new Vec3(position.x, position.y, position.z))
  if (chest?.name !== CHEST_NAME || chest.getProperties().type !== 'single') return []
  // 上に不透過のブロックがあると、広げても開けられない
  const above = blockAt(chest.position.plus(UP))
  if (!above || (above.boundingBox === 'block' && !above.transparent)) return []
  const { facing } = chest.getProperties()
  return SIDES[facing]
    .map((side) => placement(chest.position.plus(DIRECTIONS[side]), facing))
    .filter(
      ({ cell, front }) => isInRange(center, cell) && isFreeCell(blockAt, cell, front) && connectsOnlyTo(blockAt, cell, facing, chest.position)
    )
}

// 中心から近い順の、範囲内のずれ。高さが違う場所は後にする
let offsets = null
function sortedOffsets() {
  if (offsets) return offsets
  offsets = []
  for (let x = -HORIZONTAL_RANGE; x <= HORIZONTAL_RANGE; x++) {
    for (let z = -HORIZONTAL_RANGE; z <= HORIZONTAL_RANGE; z++) {
      for (let y = -VERTICAL_RANGE; y <= VERTICAL_RANGE; y++) offsets.push(new Vec3(x, y, z))
    }
  }
  const cost = (o) => Math.hypot(o.x, o.z) + Math.abs(o.y) * 8
  offsets.sort((a, b) => cost(a) - cost(b))
  return offsets
}

/**
 * 大きなチェストを新しく置く場所を、中心から近い順に返す
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {{ x: number, y: number, z: number }} center 範囲の中心（指定チェスト）
 * @param {string} preferred 優先する向き
 * @returns {Generator<Array<{ cell: Vec3, front: Vec3, facing: string }>>} 順に置く 2 か所の組
 */
function* newChestSites(blockAt, center, preferred = 'north') {
  const origin = new Vec3(center.x, center.y, center.z)
  const facings = [preferred, ...Object.keys(DIRECTIONS).filter((f) => f !== preferred)]
  for (const offset of sortedOffsets()) {
    const first = origin.plus(offset)
    if (!isAir(blockAt(first))) continue
    for (const facing of facings) {
      const second = first.plus(DIRECTIONS[SIDES[facing][0]])
      if (!isInRange(center, second)) continue
      const pair = [placement(first, facing), placement(second, facing)]
      const free = pair.every(({ cell, front }, i) => isFreeCell(blockAt, cell, front) && connectsOnlyTo(blockAt, cell, facing, pair[1 - i].cell))
      if (free) yield pair
    }
  }
}

/**
 * 作業台を置く場所を、中心から近い順に返す
 *
 * @returns {Generator<{ cell: Vec3, front: Vec3, facing: string }>}
 */
function* tableSites(blockAt, center) {
  const origin = new Vec3(center.x, center.y, center.z)
  for (const offset of sortedOffsets()) {
    const cell = origin.plus(offset)
    if (!isAir(blockAt(cell))) continue
    for (const facing of Object.keys(DIRECTIONS)) {
      const site = placement(cell, facing)
      if (isFreeCell(blockAt, site.cell, site.front)) yield site
    }
  }
}

module.exports = { DIRECTIONS, expansionSites, newChestSites, tableSites }
