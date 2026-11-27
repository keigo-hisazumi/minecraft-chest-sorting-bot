// チェストや作業台の画面と、BOT のインベントリの操作
// BOT のホットバーは食料などの持ち物に使い、それ以外の枠にあるアイテムは運んでいる荷物とみなす。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { CHEST_NAME, formatPosition } = require('./chests')
const { describeItem } = require('./items')
const { REACH } = require('./survey')

// インベントリのうち、荷物に使う枠の数（ホットバーを除く）
const CARGO_SLOTS = 27

const toVec3 = ({ x, y, z }) => new Vec3(x, y, z)

// 調査の結果から、チェストの中身の写しを作る
const toChest = (record) => ({
  positions: record.positions,
  size: 27 * record.positions.length,
  slots: new Map(record.items.map((item) => [item.slot, item])),
  unavailable: false
})

// 開いている画面（閉じているときは BOT のインベントリ）から、荷物の枠を読む
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

// 画面の更新が、この間（tick）届かなければ、落ち着いたとみなす
const QUIET_TICKS = 3
const WINDOW_PACKETS = ['window_items', 'set_slot']

// サーバーからの画面の更新が届かなくなるまで待つ
async function untilQuiet(bot) {
  let received = true
  const mark = () => {
    received = true
  }
  for (const name of WINDOW_PACKETS) bot._client?.on(name, mark)
  try {
    while (received) {
      received = false
      await bot.waitForTicks(QUIET_TICKS)
    }
  } finally {
    for (const name of WINDOW_PACKETS) bot._client?.removeListener(name, mark)
  }
}

/**
 * サーバーが持つ中身を受け取り直す
 * 受け取り直しの待ちは、前の操作に対する古い更新でも終わることがあるため、更新が落ち着くまで待つ。
 */
async function synchronize(bot, window) {
  if (bot._syncWindow) await bot._syncWindow(window)
  await untilQuiet(bot)
}

// カーソルに残ったアイテムは、閉じたときに落ちることがあるため、空き枠へ置く
async function clearCursor(bot, window) {
  if (!window.selectedItem) return
  const empty = emptyCargoSlots(window)[0] ?? window.firstEmptySlotRange(window.inventoryStart, window.inventoryStart + CARGO_SLOTS + 9)
  if (empty === null || empty === undefined) throw new Error('持っているアイテムを置く場所がありません')
  await bot.clickWindow(empty, 0, 0)
  await synchronize(bot, window)
}

/**
 * 画面の中で、1 つの枠のアイテムを別の枠へ移す
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
  await clearCursor(bot, window)
  const after = window.slots[from]?.count ?? 0
  return Math.max(0, before - after)
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

const hotbarSlots = (inventory) => Array.from({ length: 9 }, (v, i) => inventory.inventoryStart + CARGO_SLOTS + i)

/**
 * アイテムを手に持つ。ホットバーになければ、荷物から空き枠へ移す
 *
 * @returns {Promise<boolean>} 持てた場合は true。持っていないか、ホットバーに空きがなければ false
 */
async function hold(bot, name) {
  const { inventory } = bot
  const slots = hotbarSlots(inventory)
  let target = slots.find((slot) => inventory.slots[slot]?.name === name)
  if (target === undefined) {
    const item = cargoStacks(inventory).find((s) => s.name === name)
    target = slots.find((slot) => !inventory.slots[slot])
    if (!item || target === undefined) return false
    await moveStack(bot, inventory, item.slot, target)
  }
  bot.setQuickBarSlot(target - slots[0])
  return true
}

// ホットバーに残ったアイテムを、荷物へ戻して整理の対象にする。荷物に空きがなければ残す
async function release(bot, matches) {
  const { inventory } = bot
  for (const slot of hotbarSlots(inventory)) {
    const item = inventory.slots[slot]
    const empty = emptyCargoSlots(inventory)[0]
    if (item && matches(item, slot) && empty !== undefined) await moveStack(bot, inventory, slot, empty)
  }
}

/**
 * チェストのそばへ行って開き、操作して閉じる
 *
 * @returns {Promise<any>} operate の結果。行けない、開けない場合は null を返し、chest を使えない状態にする
 */
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
    console.error(`チェスト ${formatPosition(record.block.position)} を開けませんでした:`, err.message)
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

module.exports = {
  CARGO_SLOTS,
  toVec3,
  toChest,
  readCargo,
  cargoStacks,
  emptyCargoSlots,
  refresh,
  synchronize,
  clearCursor,
  moveStack,
  hotbarSlots,
  hold,
  release,
  withChest
}
