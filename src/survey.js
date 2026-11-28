// チェストの中身の調査
// 指定チェストと整理先のチェストを順に開いて、中身を読む。アイテムは動かさない。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { CHEST_NAME, chestPositions, findChests, overlaps } = require('./chests')
const { formatPosition } = require('./messages')
const { describeItem } = require('./items')

// チェストを開くときに手が届く距離（ブロック）
const REACH = 4
// 指定チェストが読み込まれていないときに、近づく距離（ブロック）
const APPROACH_DISTANCE = 8

const toVec3 = ({ x, y, z }) => new Vec3(x, y, z)

/**
 * 1 つのチェストのそばへ行き、中身を読む
 *
 * @returns {Promise<{ positions: Array<object>, items: Array<object> } | { positions: Array<object>, reason: string }>}
 *   読めなかった場合は reason に理由が入る
 */
async function readChest({ bot, navigator, signal }, positions) {
  const isChest = (p) => bot.blockAt(toVec3(p))?.name === CHEST_NAME
  const found = positions.find(isChest)
  if (!found) return { positions, reason: 'チェストがありません' }
  // 調査を始めてから、大きなチェストに変わっていることがある
  const current = chestPositions(bot.blockAt(toVec3(found)))

  // 大きなチェストは、片方に近づけなければ、もう片方も試す
  let block = null
  for (const position of current) {
    const result = await navigator.moveTo(new goals.GoalLookAtBlock(toVec3(position), bot.world, { reach: REACH }))
    signal.throwIfAborted()
    if (result.status === 'arrived' && isChest(position)) {
      block = bot.blockAt(toVec3(position))
      break
    }
  }
  if (!block) return { positions: current, reason: '到達できません' }

  let window
  try {
    window = await bot.openContainer(block)
  } catch (err) {
    console.error(`チェスト ${formatPosition(block.position)} を開けませんでした:`, err.message)
    signal.throwIfAborted()
    return { positions: current, reason: '開けません' }
  }
  try {
    signal.throwIfAborted()
    return { positions: current, items: window.containerItems().map((item) => ({ ...describeItem(item), slot: item.slot })) }
  } finally {
    window.close()
  }
}

/**
 * 指定チェストと整理先のチェストを調査する
 *
 * @param {object} options
 * @param {import('mineflayer').Bot} options.bot
 * @param {import('./navigation').Navigator} options.navigator
 * @param {Array<{ x: number, y: number, z: number }>} options.source 指定チェストの座標
 * @param {Array<Array<{ x: number, y: number, z: number }>>} options.excluded 除外したチェスト
 * @param {AbortSignal} options.signal 中止の合図
 * @returns {Promise<{ source: object, chests: object[], failed: object[] }>}
 */
async function surveyChests({ bot, navigator, source, excluded, signal }) {
  signal.throwIfAborted()
  const context = { bot, navigator, signal }
  const center = source[0]
  if (!bot.blockAt(toVec3(center))) {
    await navigator.moveTo(new goals.GoalNear(center.x, center.y, center.z, APPROACH_DISTANCE))
    signal.throwIfAborted()
    if (!bot.blockAt(toVec3(center))) throw new Error('指定チェストの近くへ行けませんでした')
  }

  const sourceRecord = await readChest(context, source)
  // 指定チェストの中身がないと、正しい計画にならない
  if (!sourceRecord.items) throw new Error(`指定チェスト ${formatPosition(center)} を調査できません: ${sourceRecord.reason}`)

  const remaining = findChests(bot, center).filter(
    (positions) => !overlaps(positions, sourceRecord.positions) && !excluded.some((chest) => overlaps(chest, positions))
  )
  const chests = []
  const failed = []
  while (remaining.length > 0) {
    // 今いる場所から近い順に回る
    const distance = (positions) => bot.entity.position.distanceTo(toVec3(positions[0]))
    remaining.sort((a, b) => distance(a) - distance(b))
    const record = await readChest(context, remaining.shift())
    if (record.items) chests.push(record)
    else failed.push(record)
  }
  return { source: sourceRecord, chests, failed }
}

module.exports = { surveyChests, readChest, REACH }
