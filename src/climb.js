// 大きな木の伐採（幹の柱を登って切る）
// 地上から手が届かない高い原木は、切り終えた幹の跡にブロックを積んで登り、手の届く原木から切る。
// 積んだブロックは、切り終えたら上から順に掘って降り、跡に残さない。
// 採掘 BOT（minecraft-mining-bot）の src/climb.js と同じ処理を使う。

const { Vec3 } = require('vec3')
const { isNaturalLeaves } = require('./trees')

// 根元から登ってよい高さ（ブロック）
const MAX_CLIMB = 32
// ジャンプして、足元にブロックを置ける高さに届くまで待つ時間（tick）
const JUMP_TICKS = 20
// 着地するまで待つ時間（tick）
const LAND_TICKS = 20

const UP = new Vec3(0, 1, 0)
const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'

// 条件が満たされるまで、1 tick ずつ待つ
async function waitUntil(bot, condition, ticks) {
  for (let i = 0; i < ticks; i++) {
    if (condition()) return true
    await bot.waitForTicks(1)
  }
  return condition()
}

/**
 * その場でジャンプして、足元にブロックを置き、1 段高くなる
 * 手に置くブロックを持っておくこと。
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<import('vec3').Vec3 | null>} 置いた座標。置けなかったら null
 */
async function towerUp(bot) {
  const start = bot.entity.position.floored()
  const below = bot.blockAt(start.offset(0, -1, 0))
  if (!below || isAir(below)) return null
  bot.setControlState('jump', true)
  try {
    if (!(await waitUntil(bot, () => bot.entity.position.y >= start.y + 1, JUMP_TICKS))) return null
    await bot.placeBlock(below, UP)
  } catch {
    return null
  } finally {
    bot.setControlState('jump', false)
  }
  await waitUntil(bot, () => bot.entity.onGround, LAND_TICKS)
  return isAir(bot.blockAt(start)) ? null : start
}

/**
 * 積んだブロックを、上から順に掘って降りる
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Array<import('vec3').Vec3>} placed 積んだ座標（下から順）
 * @param {(block: object) => Promise<void>} dig ブロックを掘る関数
 */
async function descend(bot, placed, dig) {
  for (const position of [...placed].reverse()) {
    const block = bot.blockAt(position)
    if (isAir(block)) continue
    try {
      await dig(block)
    } catch (err) {
      // 掘れなければ、ブロックは残る（素手でも掘れるため、通常は起きない）
      console.error(`積んだブロック (${position.x}, ${position.y}, ${position.z}) を掘れませんでした:`, err.message)
      return
    }
    await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.y < position.y + 0.5, LAND_TICKS)
  }
}

/**
 * 幹の跡（根元の原木を切った場所）に立った状態から、柱を積んで登り、残った原木を切る
 * 切り終えるか、登れなくなるか、中止されたら、積んだブロックを掘って根元へ降りる。
 *
 * @param {import('mineflayer').Bot} bot 根元の原木の跡に立っている BOT
 * @param {{ type: string, logs: Array<import('vec3').Vec3>, base: Array<import('vec3').Vec3> }} tree 木（analyzeTree の結果）
 * @param {object} ops
 * @param {(block: object) => Promise<void>} ops.dig ブロックを掘る関数（道具の持ち替えを含む）
 * @param {() => Promise<boolean>} ops.holdBlock 積むブロックを手に持つ関数。持てなければ false
 * @param {() => boolean} [ops.isCancelled] 中止されたかを返す
 * @returns {Promise<number>} 切った原木の数
 */
async function cutFromTrunk(bot, tree, { dig, holdBlock, isCancelled = () => false }) {
  const name = `${tree.type}_log`
  const placed = []
  // 積んだブロックは、同じ原木でも切る対象にしない
  const isPlaced = (p) => placed.some((q) => q.equals(p))
  const remaining = () => tree.logs.filter((p) => !isPlaced(p) && bot.blockAt(p)?.name === name)
  const [column] = tree.base
  let cut = 0
  try {
    while (!isCancelled()) {
      // 手が届く原木を切る
      let progress = false
      for (const position of remaining()) {
        if (isCancelled()) break
        const block = bot.blockAt(position)
        if (!bot.canDigBlock(block)) continue
        await dig(block)
        if (bot.blockAt(position)?.name !== name) {
          cut++
          progress = true
        }
      }
      const left = remaining()
      if (left.length === 0 || progress) {
        if (left.length === 0) break
        continue
      }
      // 手が届かないので、1 段登る。頭の上をふさぐ原木と自然の葉は掘る
      const feet = bot.entity.position.floored()
      const top = Math.max(...left.map((p) => p.y))
      if (feet.y >= top || feet.y - column.y >= MAX_CLIMB) break
      const head = bot.blockAt(feet.offset(0, 2, 0))
      if (!isAir(head)) {
        if (head.name !== name && !isNaturalLeaves(head)) break
        await dig(head)
        if (!isAir(bot.blockAt(feet.offset(0, 2, 0)))) break
        if (head.name === name) cut++
      }
      if (!(await holdBlock())) break
      const position = await towerUp(bot)
      if (!position) break
      placed.push(position)
    }
  } finally {
    await descend(bot, placed, dig)
  }
  return cut
}

module.exports = { MAX_CLIMB, towerUp, descend, cutFromTrunk }
