// アイテムの移動
// 指定チェストと整理先を調査して振り分け先を決め、BOT のインベントリを使ってアイテムを移す。
// 足りないチェストは移す前に作って置き、専用チェストに入りきらない分は移したあとに廃棄する。

const { goals } = require('mineflayer-pathfinder')
const { buildChests } = require('./builder')
const { formatChest, overlaps } = require('./chests')
const { formatPosition, message } = require('./messages')
const { discardOverflow } = require('./discard')
const { createLayout, destinationFor, movableStacks } = require('./moves')
const { buildPlan } = require('./plan')
const { storeStack } = require('./store')
const { surveyChests, readChest } = require('./survey')
const { toChest, readCargo, cargoStacks, emptyCargoSlots, refresh, moveStack, withChest } = require('./window')

// 中身を入れ替えるために、空けておく枠の数
const RESERVED_SLOTS = 3
// 何も動かせない訪問がこの回数続いたら、その回の整理を終える
const STALL_LIMIT = 3
// 1 回の整理で訪問する回数の上限
const VISIT_LIMIT = 1000
// 整理のあとに待つ場所の、指定チェストからの距離（ブロック）
const WAIT_DISTANCE = 4

// 荷物を届け、必要ならよそへ移すアイテムを持ち出す
async function visit(context, chest, { pickup }) {
  const { bot, signal, layout, source } = context
  return withChest(context, chest, async (window) => {
    const result = { delivered: 0, taken: 0 }
    if (chest !== source) {
      for (const { slot, stack } of readCargo(window)) {
        if (!stack || destinationFor(layout, stack) !== chest) continue
        const { stored, taken } = await storeStack(context, window, chest, slot)
        result.delivered += stored
        result.taken += taken
      }
    }
    if (pickup) {
      for (const stack of movableStacks(layout, chest)) {
        signal.throwIfAborted()
        const empty = emptyCargoSlots(window)
        if (empty.length <= RESERVED_SLOTS) break
        result.taken += await moveStack(bot, window, stack.slot, empty[0])
        refresh(chest, window)
      }
    }
    return result
  })
}

// 届け先がない荷物を、指定チェストへ戻す
async function returnToSource(context) {
  const { source } = context
  const returned = await withChest(context, source, async (window) => {
    let count = 0
    for (const { slot, stack } of readCargo(window)) {
      if (stack) count += (await storeStack(context, window, source, slot)).stored
    }
    return count
  })
  return returned ?? 0
}

// 荷物が多く届くチェストを選ぶ
function busiestDestination(layout, stacks) {
  const counts = new Map()
  for (const stack of stacks) {
    const chest = destinationFor(layout, stack)
    if (chest) counts.set(chest, (counts.get(chest) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * 移せるアイテムがなくなるまで、チェストを回る
 * 持っている荷物を先に届け、次に指定チェスト、最後に整理先の入れ替えを行う。
 */
async function carry(context, chests) {
  const { bot, layout, source } = context
  let delivered = 0
  let stalls = 0
  for (let visits = 0; visits < VISIT_LIMIT && stalls < STALL_LIMIT; visits++) {
    if (source.unavailable) throw new Error('指定チェストを開けないか、近くへ行けません')
    const stacks = cargoStacks(bot.inventory)
    const sourceHasWork = movableStacks(layout, source).length > 0
    let chest = busiestDestination(layout, stacks)
    // 届けるついでの持ち出しは、指定チェストから移すものがなくなってから行う
    let pickup = !sourceHasWork
    if (!chest) {
      pickup = true
      if (emptyCargoSlots(bot.inventory).length > RESERVED_SLOTS) {
        chest = sourceHasWork ? source : (chests.find((c) => !c.unavailable && movableStacks(layout, c).length > 0) ?? null)
      }
    }
    if (!chest) {
      // 届け先のない荷物は指定チェストへ戻す。戻して枠が空けば、続きを行う
      if (stacks.length === 0 || (await returnToSource(context)) === 0) break
      continue
    }
    const result = await visit(context, chest, { pickup })
    if (!result) continue
    // チェストを 1 つ整理するごとに知らせる
    if (chest !== source && result.delivered > 0) {
      context.notify(message.done('整理', `${formatChest(chest.positions)} へ ${result.delivered} 個`))
    }
    delivered += result.delivered
    stalls = result.delivered + result.taken > 0 ? 0 : stalls + 1
  }
  // 途中で終えた場合に、荷物を持ったままにしない
  if (cargoStacks(bot.inventory).length > 0 && !source.unavailable) await returnToSource(context)
  return delivered
}

/**
 * 調査して振り分け先を決め、アイテムを 1 回分整理する
 *
 * @param {object} options
 * @param {import('mineflayer').Bot} options.bot
 * @param {import('./navigation').Navigator} options.navigator
 * @param {{ source: { positions: Array<object> }, excluded: Array, assignments: object }} options.world 登録情報
 * @param {(assignments: object) => void} options.saveAssignments 決めた振り分け先を保存する関数
 * @param {AbortSignal} options.signal 中止の合図
 * @param {typeof buildChests} [options.build] 足りないチェストを作る関数
 * @param {string} [options.discardLog] 廃棄を記録するファイル。なければ廃棄しない
 * @param {typeof discardOverflow} [options.discard] 入りきらないアイテムを廃棄する関数
 * @returns {Promise<{ delivered: number, shortage: string[], missingChests: number, sourceItems: number,
 *   carried: number, misplaced: number, failed: object[], build: object, discard: object, signature: string }>} 整理の結果。
 *   sourceItems は指定チェストに残った個数、misplaced は整理先に残った移すべきアイテムの枠の数
 */
async function sortOnce({
  bot,
  navigator,
  world,
  saveAssignments,
  saveReplant,
  notify = () => {},
  signal,
  build = buildChests,
  discardLog,
  discard = discardOverflow
}) {
  notify(message.start('調査', 'チェストの中身', 'アイテムを移す前に確かめます'))
  const inspect = () => surveyChests({ bot, navigator, source: world.source.positions, excluded: world.excluded, signal })
  let survey = await inspect()
  const built = await build({ bot, navigator, survey, world, signal, saveReplant, notify })
  // 材料を取り出したり、チェストを置いたりした場合は、調べ直す
  if (built.changed) survey = await inspect()
  // 荷物として持っている分も、合計に含める
  const holding = { positions: [], items: cargoStacks(bot.inventory) }
  // 専用チェストには、大きなチェストだけを使う
  const plan = buildPlan(
    { source: { ...survey.source, items: [...survey.source.items, ...holding.items] }, chests: survey.chests },
    {
      previous: world.assignments,
      canDedicate: (chest) => chest.positions.length === 2,
      capacity: (chest) => 27 * chest.positions.length
    }
  )
  const assignments = mergeAssignments(world.assignments, plan, survey)
  saveAssignments(assignments)

  const source = toChest(survey.source)
  const chests = survey.chests.map(toChest)
  const failed = [...survey.failed]
  // 専用にするのにチェストがないアイテムは、混合チェストへ入れずに、今の場所に残す
  const waiting = Object.fromEntries(plan.dedicated.map((d) => [d.name, null]))
  const layout = createLayout({ ...assignments, dedicated: { ...waiting, ...assignments.dedicated } }, chests)
  const context = { bot, navigator, signal, layout, source, failed, notify }
  notify(message.done('調査', `チェスト ${survey.chests.length + 1} 個`, `アイテム ${plan.itemKinds} 種類`))
  let delivered = await carry(context, chests)
  const discarded = await discard(context, { chests, center: source.positions[0], logFile: discardLog })
  // 廃棄のために取り出した分や、入れ替えた分を片付ける
  if (discarded.changed) delivered += await carry(context, chests)
  await navigator.moveTo(new goals.GoalNear(source.positions[0].x, source.positions[0].y, source.positions[0].z, WAIT_DISTANCE))
  signal.throwIfAborted()

  return {
    delivered,
    shortage: plan.dedicated.filter((d) => d.chest === null && d.total > 0).map((d) => d.name),
    missingChests: [...plan.mixed.chests, ...plan.protected.chests].filter((c) => c === null).length,
    sourceItems: total([...source.slots.values()]),
    carried: total(cargoStacks(bot.inventory)),
    misplaced: chests.reduce((count, c) => count + movableStacks(layout, c).length, 0),
    failed,
    build: built,
    discard: discarded,
    signature: signatureOf(source.positions, [...source.slots.values()])
  }
}

const total = (stacks) => stacks.reduce((count, s) => count + s.count, 0)

/**
 * 保存する振り分け先を作る
 * 専用にするアイテムは、チェストを割り当てられたものだけを残す（少なくなっても専用のままにする対象になる）。
 * 調査できなかったチェストの割り当ては、前回のまま残す。
 */
function mergeAssignments(previous, plan, survey) {
  const failed = survey.failed.map((f) => f.positions)
  const unseen = (positions) => Boolean(positions) && failed.some((f) => overlaps(f, positions))
  const dedicated = plan.dedicated.map((d) => {
    const before = previous.dedicated[d.name]
    // 調査できなかったチェストが専用だった場合は、別のチェストに替えない
    return [d.name, unseen(before) ? before : d.chest]
  })
  const list = (assigned, before) => [...assigned.filter(Boolean), ...before.filter(unseen)]
  return {
    dedicated: Object.fromEntries(dedicated.filter(([, positions]) => positions)),
    mixed: list(plan.mixed.chests, previous.mixed),
    protected: list(plan.protected.chests, previous.protected)
  }
}

/**
 * 指定チェストの中身を読む
 *
 * @returns {Promise<string>} 中身が変わったかを比べるための文字列
 */
async function readSourceSignature({ bot, navigator, world, signal }) {
  const record = await readChest({ bot, navigator, signal }, world.source.positions)
  if (!record.items) throw new Error(`指定チェスト ${formatPosition(world.source.positions[0])} を調査できません: ${record.reason}`)
  return signatureOf(record.positions, record.items)
}

// 指定チェストの位置と、アイテムごとの個数
function signatureOf(positions, items) {
  const counts = items.map((i) => `${i.name}:${i.variant}:${i.count}`).sort()
  return JSON.stringify([positions, counts])
}

module.exports = { sortOnce, readSourceSignature, signatureOf, RESERVED_SLOTS }
