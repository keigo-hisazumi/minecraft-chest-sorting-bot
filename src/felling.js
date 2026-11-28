// 1 本の木の伐採
// 地上から届く原木を切り、高い原木は幹の跡に足場を積んで登って切る。
// それでも残った原木（横に張り出した枝など）は、その原木の真下から足場を積んで切り、原木を残さない。
// 移動、斧の用意、持ち物の扱いは BOT ごとに違うため、呼び出す側から関数で受け取る。
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

const { goals } = require('mineflayer-pathfinder')
const { cutFromTrunk, findPillarSpot } = require('./climb')
const { formatPosition, message } = require('./messages')
const { TREE_LABELS, isPlacedLeaves } = require('./trees')

// 地上から切りに行く原木の、根元からの高さの上限。これより高い原木は、幹の跡に柱を積んで登って切る
const GROUND_REACH = 5
// 掘るときに近づく距離
const DIG_REACH = 4
// 1 本の木で、柱を積んで登り直す回数の上限
const MAX_CLIMB_ROUNDS = 8
// 原木を切ってから、落ちたアイテムを拾いに行くまで待つ時間（tick）
const DROP_WAIT_TICKS = 20
// 落ちたアイテムを拾いに行く、中心からの距離
const COLLECT_DISTANCE = 8
// 拾うアイテム
const PICKUP = /(_log|_sapling|^stick|^apple)$/

/**
 * @typedef {object} FellingOps
 * @property {import('mineflayer').Bot} bot
 * @property {(goal: object) => Promise<boolean>} moveTo 目標へ移動する（道をふさぐ自然の葉は壊してよい）。着いたら true
 * @property {() => boolean} isCancelled 中止されたかを返す
 * @property {() => Promise<boolean>} ensureAxe 地上で斧を手に持つ。なければ作ってよい。持てなければ false
 * @property {() => Promise<boolean>} holdAxe 持っている斧を手に持つ（作らない）。なければ false
 * @property {() => Promise<boolean>} holdBlock 足場に積むブロックを手に持つ。なければ false
 * @property {() => boolean} canPickUp 拾ったアイテムを入れる空きがあるかを返す
 * @property {(text: string) => void} notify チャットへの通知
 */

// 手の届く場所へ移って、ブロックを壊す。壊せたら true
async function digAt(ops, position, name, near) {
  const { bot } = ops
  const target = () => bot.blockAt(position)
  if (target()?.name !== name) return false
  if (!bot.canDigBlock(target())) {
    await ops.moveTo(new goals.GoalLookAtBlock(position, bot.world, { reach: DIG_REACH }))
    // 見える位置がなければ、根元に立って下から掘る
    if (!ops.isCancelled() && !bot.canDigBlock(target()) && near) await ops.moveTo(new goals.GoalNear(near.x, near.y, near.z, 0))
  }
  if (ops.isCancelled() || target()?.name !== name || !bot.canDigBlock(target())) return false
  try {
    await bot.dig(target(), true)
  } catch (err) {
    console.error(`${formatPosition(position)} を壊せませんでした:`, err.message)
  }
  return target()?.name !== name
}

// 落ちている原木や苗木を拾う
async function collectDrops(ops, center) {
  const { bot } = ops
  await bot.waitForTicks(DROP_WAIT_TICKS)
  const tried = new Set()
  while (!ops.isCancelled() && ops.canPickUp()) {
    const drop = Object.values(bot.entities ?? {})
      .filter((e) => e.name === 'item' && !tried.has(e.id) && e.position.distanceTo(center) <= COLLECT_DISTANCE)
      .filter((e) => PICKUP.test(e.getDroppedItem?.()?.name ?? ''))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!drop) return
    tried.add(drop.id)
    const { x, y, z } = drop.position.floored()
    await ops.moveTo(new goals.GoalNear(x, y, z, 0))
    await bot.waitForTicks(5)
  }
}

// 指定した場所に立ち、柱を積んで登って、残った原木を切る
async function climbFrom(ops, tree, spot) {
  const { bot } = ops
  // 斧は、登る前に地上で用意する。柱の上では作りに行かない
  const axe = await ops.ensureAxe()
  if (ops.isCancelled()) return { cut: 0, reason: null, barehanded: !axe }
  if (!(await ops.moveTo(new goals.GoalBlock(spot.x, spot.y, spot.z)))) {
    return { cut: 0, reason: `${formatPosition(spot)} へ行けません`, barehanded: !axe }
  }
  let reason = null
  let barehanded = !axe
  const cut = await cutFromTrunk(bot, tree, {
    dig: async (block) => {
      // 中止されたあとも、積んだ柱は掘って降りるため、斧がなくても掘る
      if (!(await ops.holdAxe().catch(() => false))) barehanded = true
      await bot.dig(block, true)
    },
    holdBlock: ops.holdBlock,
    isCancelled: ops.isCancelled,
    onStop: (text) => {
      reason = text
    }
  })
  return { cut, reason, barehanded }
}

/**
 * 1 本の木（または切り残し）を、原木を残さないように切り、落ちた原木と苗木を拾う
 *
 * @param {FellingOps} ops
 * @param {{ type: string, logs: Array<import('vec3').Vec3>, base: Array<import('vec3').Vec3>, remnant?: boolean }} tree
 *   木（analyzeTree か analyzeRemnant の結果）
 * @returns {Promise<{ cut: number, rest: number, barehanded: boolean }>} 切った原木の数、残った原木の数、素手で切ったか
 */
async function fellTree(ops, tree) {
  const { bot } = ops
  const [base] = tree.base
  const name = `${tree.type}_log`
  const left = () => tree.logs.filter((p) => bot.blockAt(p)?.name === name)
  let cut = 0
  let barehanded = false
  // 切り残しは根元がないため、地上からは切らずに、真下から足場を積んで切る
  if (!tree.remnant) {
    for (const position of tree.logs.filter((p) => p.y - base.y <= GROUND_REACH)) {
      if (ops.isCancelled()) break
      // 斧が壊れたら作り直す。用意できなければ素手で掘る
      if (!(await ops.ensureAxe())) barehanded = true
      if (await digAt(ops, position, name, base)) cut++
    }
    if (cut === 0) return { cut, rest: left().length, barehanded }
    await collectDrops(ops, base)
  }
  // 柱を積み始めた場所。同じ場所からは、やり直さない
  const tried = new Set()
  let reason = null
  for (let round = 0; round < MAX_CLIMB_ROUNDS && left().length > 0 && !ops.isCancelled(); round++) {
    const remaining = left()
    // はじめは幹の跡から。次からは、残った原木の低い順に、その真下から
    const starts = tree.remnant ? [] : [base]
    const spot = [...starts, ...remaining.map((p) => findPillarSpot(bot, p))].find((p) => p && !tried.has(p.toString()))
    if (!spot) {
      reason ??= '柱を積める場所がありません'
      break
    }
    tried.add(spot.toString())
    const where = spot === base ? '幹に足場を積んで登ります' : `${formatPosition(spot)} から足場を積んで登ります`
    ops.notify(message.start('伐採', `高いところの原木 ${remaining.length} 個`, where))
    const climbed = await climbFrom(ops, tree, spot)
    cut += climbed.cut
    barehanded ||= climbed.barehanded
    if (climbed.reason) reason = climbed.reason
    await collectDrops(ops, spot)
  }
  const rest = left().length
  if (rest > 0 && !ops.isCancelled()) {
    const label = `${TREE_LABELS[tree.type] ?? tree.type}${tree.remnant ? 'の切り残し' : ''}`
    ops.notify(message.failed('伐採', `${label} ${formatPosition(base)} の原木 ${rest} 個`, reason))
  }
  return { cut, rest, barehanded }
}

/**
 * 移動のルールを、伐採用に変える。道をふさぐ自然の葉だけは壊してよい（置かれた葉は壊さない）
 *
 * @param {object} movements mineflayer-pathfinder の移動のルール（BOT ごとの通常のルール）
 * @param {object} registry bot.registry
 * @returns {object} 変えた移動のルール（movements と同じもの）
 */
function allowLeafBreaking(movements, registry) {
  movements.canDig = true
  movements.blocksCantBreak = new Set(registry.blocksArray.filter((b) => !b.name.endsWith('_leaves')).map((b) => b.id))
  movements.exclusionAreasBreak = [(block) => (isPlacedLeaves(block) ? 100 : 0)]
  return movements
}

module.exports = { GROUND_REACH, DIG_REACH, PICKUP, allowLeafBreaking, fellTree, digAt, collectDrops }
