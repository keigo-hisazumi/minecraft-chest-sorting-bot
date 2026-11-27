// アイテムの移動
// 指定チェストと整理先を調査して振り分け先を決め、BOT のインベントリを使ってアイテムを移す。
// BOT のホットバーは食料などの持ち物に使い、それ以外の枠にあるアイテムは運んでいる荷物とみなす。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { CHEST_NAME, formatPosition, overlaps } = require('./chests')
const { describeItem } = require('./items')
const { createLayout, sameKind, destinationFor, evictableStacks, movableStacks } = require('./moves')
const { buildPlan } = require('./plan')
const { surveyChests, readChest, REACH } = require('./survey')

// インベントリのうち、荷物に使う枠の数（ホットバーを除く）
const CARGO_SLOTS = 27
// 中身を入れ替えるために、空けておく枠の数
const RESERVED_SLOTS = 3
// 何も動かせない訪問がこの回数続いたら、その回の整理を終える
const STALL_LIMIT = 3
// 1 回の整理で訪問する回数の上限
const VISIT_LIMIT = 1000
// 整理のあとに待つ場所の、指定チェストからの距離（ブロック）
const WAIT_DISTANCE = 4

const toVec3 = ({ x, y, z }) => new Vec3(x, y, z)

const toChest = (record) => ({
  positions: record.positions,
  size: 27 * record.positions.length,
  slots: new Map(record.items.map((item) => [item.slot, item])),
  unavailable: false
})

// 開いているウィンドウ（閉じているときは BOT のインベントリ）から、荷物の枠を読む
function readCargo(window) {
  const slots = []
  for (let slot = window.inventoryStart; slot < window.inventoryStart + CARGO_SLOTS; slot++) {
    const item = window.slots[slot]
    slots.push({ slot, stack: item ? { ...describeItem(item), slot } : null })
  }
  return slots
}

const cargoStacks = (window) => readCargo(window).flatMap((s) => (s.stack ? [s.stack] : []))
const emptyCargoSlots = (window) => readCargo(window).filter((s) => !s.stack).map((s) => s.slot)

function refresh(chest, window) {
  chest.slots = new Map()
  for (let slot = 0; slot < window.inventoryStart; slot++) {
    const item = window.slots[slot]
    if (item) chest.slots.set(slot, { ...describeItem(item), slot })
  }
}

// サーバーが持つ中身を受け取り直す
async function synchronize(bot, window) {
  if (bot._syncWindow) await bot._syncWindow(window)
  else await bot.waitForTicks(5)
}

/**
 * ウィンドウの中で、1 つの枠のアイテムを別の枠へ移す
 * 移し先は、空きか、同じアイテムの枠にする。入りきらない分は、元の枠へ戻す。
 *
 * @returns {Promise<number>} 移せた個数
 */
async function moveStack(bot, window, from, to) {
  const before = window.slots[from]?.count ?? 0
  await bot.clickWindow(from, 0, 0)
  await bot.clickWindow(to, 0, 0)
  if (window.selectedItem) await bot.clickWindow(from, 0, 0)
  await synchronize(bot, window)
  // カーソルに残ると、閉じたときに落ちることがあるため、空き枠へ置く
  if (window.selectedItem) {
    const empty = emptyCargoSlots(window)[0] ?? window.firstEmptySlotRange(0, window.inventoryStart)
    if (empty === null || empty === undefined) throw new Error('持っているアイテムを置く場所がありません')
    await bot.clickWindow(empty, 0, 0)
    await synchronize(bot, window)
  }
  const after = window.slots[from]?.count ?? 0
  return Math.max(0, before - after)
}

// チェストの中で、アイテムを足せる枠（同じアイテムの枠を先に使う）
function roomSlot(chest, stack) {
  const partial = [...chest.slots.values()].find((s) => sameKind(s, stack) && s.count < s.stackSize)
  if (partial) return partial.slot
  for (let slot = 0; slot < chest.size; slot++) {
    if (!chest.slots.has(slot)) return slot
  }
  return null
}

/**
 * 持っている 1 枠分のアイテムを、開いているチェストへ入れる
 * 整理先に空きがなければ、よそへ移すアイテムを取り出して空ける。指定チェストからは取り出さない。
 *
 * @returns {Promise<{ stored: number, taken: number }>} 入れた個数と、空けるために取り出した個数
 */
async function storeStack({ bot, signal, layout, source }, window, chest, cargoSlot) {
  const result = { stored: 0, taken: 0 }
  while (window.slots[cargoSlot]) {
    signal.throwIfAborted()
    const stack = describeItem(window.slots[cargoSlot])
    const target = roomSlot(chest, stack)
    if (target !== null) {
      const moved = await moveStack(bot, window, cargoSlot, target)
      refresh(chest, window)
      result.stored += moved
      if (moved === 0) break
      continue
    }
    const evict = chest === source ? undefined : evictableStacks(layout, chest)[0]
    const empty = emptyCargoSlots(window)[0]
    if (!evict || empty === undefined) break
    const moved = await moveStack(bot, window, evict.slot, empty)
    refresh(chest, window)
    result.taken += moved
    if (moved === 0) break
  }
  return result
}

// チェストのそばへ行って開き、操作して閉じる。行けない、開けない場合は null を返す
async function withChest({ bot, navigator, signal, failed }, chest, operate) {
  const record = await readyToOpen({ bot, navigator, signal }, chest)
  if (!record.block) {
    chest.unavailable = true
    failed.push({ positions: chest.positions, reason: record.reason })
    return null
  }
  let window
  try {
    window = await bot.openContainer(record.block)
  } catch (err) {
    console.error(`チェスト (${formatPosition(record.block.position)}) を開けませんでした:`, err.message)
    signal.throwIfAborted()
    chest.unavailable = true
    failed.push({ positions: chest.positions, reason: '開けません' })
    return null
  }
  try {
    if (window.inventoryStart !== chest.size) {
      chest.unavailable = true
      failed.push({ positions: chest.positions, reason: '大きさが変わりました' })
      return null
    }
    refresh(chest, window)
    return await operate(window)
  } finally {
    window.close()
  }
}

async function readyToOpen({ bot, navigator, signal }, chest) {
  signal.throwIfAborted()
  for (const position of chest.positions) {
    const result = await navigator.moveTo(new goals.GoalLookAtBlock(toVec3(position), bot.world, { reach: REACH }))
    signal.throwIfAborted()
    if (result.status !== 'arrived') continue
    const block = bot.blockAt(toVec3(position))
    if (block?.name !== CHEST_NAME) return { reason: 'チェストがありません' }
    return { block }
  }
  return { reason: '到達できません' }
}

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
 * @returns {Promise<{ delivered: number, shortage: string[], missingChests: number, sourceItems: number,
 *   carried: number, misplaced: number, failed: object[], signature: string }>} 整理の結果。
 *   sourceItems は指定チェストに残った個数、misplaced は整理先に残った移すべきアイテムの枠の数
 */
async function sortOnce({ bot, navigator, world, saveAssignments, signal }) {
  const survey = await surveyChests({ bot, navigator, source: world.source.positions, excluded: world.excluded, signal })
  // 荷物として持っている分も、合計に含める
  const holding = { positions: [], items: cargoStacks(bot.inventory) }
  // この段階ではチェストを作れないため、専用チェストには、今ある大きなチェストだけを使う
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
  const context = { bot, navigator, signal, layout, source, failed }
  const delivered = await carry(context, chests)
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
  if (!record.items) throw new Error(`指定チェスト (${formatPosition(world.source.positions[0])}) を調査できません: ${record.reason}`)
  return signatureOf(record.positions, record.items)
}

// 指定チェストの位置と、アイテムごとの個数
function signatureOf(positions, items) {
  const counts = items.map((i) => `${i.name}:${i.variant}:${i.count}`).sort()
  return JSON.stringify([positions, counts])
}

module.exports = { sortOnce, readSourceSignature, signatureOf, moveStack, RESERVED_SLOTS }
