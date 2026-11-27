// チェストの判定と検索

const { Vec3 } = require('vec3')

// 対象は通常のチェストだけ（樽、トラップチェスト、銅のチェストなどは含めない）
const CHEST_NAME = 'chest'

// 「付近」の範囲（中心からの各軸の距離、ブロック）
const HORIZONTAL_RANGE = 32
const VERTICAL_RANGE = 8

// 範囲の直方体を含む、検索の半径
const SEARCH_DISTANCE = Math.ceil(Math.hypot(HORIZONTAL_RANGE, HORIZONTAL_RANGE, VERTICAL_RANGE)) + 1
// 検索で受け取るチェストの上限
const SEARCH_COUNT = 4096

const DIRECTIONS = {
  north: new Vec3(0, 0, -1),
  east: new Vec3(1, 0, 0),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0)
}

// 大きなチェストのもう半分がある方向。type が left なら向きの時計回り、right なら反時計回り
const PARTNER_DIRECTION = {
  left: { north: 'east', east: 'south', south: 'west', west: 'north' },
  right: { north: 'west', east: 'north', south: 'east', west: 'south' }
}

/**
 * 座標を x、y、z の順に並べ替える
 *
 * @param {Array<{ x: number, y: number, z: number }>} positions 座標
 * @returns {Array<{ x: number, y: number, z: number }>} 並べ替えた座標
 */
function sortPositions(positions) {
  return [...positions].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z)
}

/**
 * チェストが占める座標を返す。大きなチェストは 2 つの座標になる
 *
 * @param {import('prismarine-block').Block} block チェストのブロック
 * @returns {Array<{ x: number, y: number, z: number }>} チェストの座標
 */
function chestPositions(block) {
  const { x, y, z } = block.position
  const { type, facing } = block.getProperties()
  const direction = DIRECTIONS[PARTNER_DIRECTION[type]?.[facing]]
  if (!direction) return [{ x, y, z }]
  return sortPositions([
    { x, y, z },
    { x: x + direction.x, y, z: z + direction.z }
  ])
}

/**
 * 座標が、中心から見て「付近」の範囲内かを判定する
 *
 * @param {{ x: number, y: number, z: number }} center 中心の座標
 * @param {{ x: number, y: number, z: number }} position 判定する座標
 * @returns {boolean} 範囲内なら true
 */
function isInRange(center, position) {
  return (
    Math.abs(position.x - center.x) <= HORIZONTAL_RANGE &&
    Math.abs(position.z - center.z) <= HORIZONTAL_RANGE &&
    Math.abs(position.y - center.y) <= VERTICAL_RANGE
  )
}

/**
 * BOT の付近で、一番近いチェストを探す
 *
 * @param {import('mineflayer').Bot} bot
 * @param {(positions: Array<{ x: number, y: number, z: number }>) => boolean} isExcluded true を返したチェストは対象にしない
 * @returns {Array<{ x: number, y: number, z: number }> | null} チェストの座標。なければ null
 */
function findNearestChest(bot, isExcluded) {
  const origin = bot.entity.position
  const center = origin.floored()
  const distance = (p) => origin.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5))
  const candidates = bot
    .findBlocks({ matching: bot.registry.blocksByName[CHEST_NAME].id, maxDistance: SEARCH_DISTANCE, count: SEARCH_COUNT })
    .filter((position) => isInRange(center, position))
    .sort((a, b) => distance(a) - distance(b))
  for (const position of candidates) {
    const positions = chestPositions(bot.blockAt(position))
    if (!isExcluded(positions)) return positions
  }
  return null
}

module.exports = { CHEST_NAME, HORIZONTAL_RANGE, VERTICAL_RANGE, sortPositions, chestPositions, isInRange, findNearestChest }
