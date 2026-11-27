// 板材、作業台、チェストのクラフト
// 画面の枠へ材料を 1 つずつ置いてクラフトする。板材は、種類が混ざっていてもよい。

const { synchronize, clearCursor, moveStack, readCargo, emptyCargoSlots } = require('./window')

// 画面の枠の番号。0 が完成品
const RESULT_SLOT = 0
// BOT のインベントリの画面にある、2×2 の材料の枠
const INVENTORY_GRID = [1, 2, 3, 4]
// 作業台の画面にある、3×3 の材料の枠
const TABLE_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9]
// 作業台の画面で、チェストの材料を置く枠（中央の 5 は空ける）
const CHEST_PATTERN = [1, 2, 3, 4, 6, 7, 8, 9]

// クラフトに使える原木と、1 本から作れる板材の数
const LOG_PATTERNS = [
  [/^(stripped_)?(oak|spruce|birch|jungle|acacia|cherry|dark_oak|pale_oak|mangrove)_(log|wood)$/, 4],
  [/^(stripped_)?(crimson|warped)_(stem|hyphae)$/, 4],
  [/^(stripped_)?bamboo_block$/, 2]
]

// 名前や付加情報で保護しているアイテムは、材料に使わない
const isPlank = (stack) => stack.name.endsWith('_planks') && !stack.protected
const planksPerLog = (stack) => (stack.protected ? 0 : (LOG_PATTERNS.find(([pattern]) => pattern.test(stack.name))?.[1] ?? 0))

const countPlanks = (stacks) => stacks.filter(isPlank).reduce((total, s) => total + s.count, 0)
// 原木も板材にした場合の、板材の数
const plankValue = (stack) => stack.count * (isPlank(stack) ? 1 : planksPerLog(stack))

// 材料の枠に残ったアイテムを、荷物へ戻す
async function clearGrid(bot, window, grid) {
  await clearCursor(bot, window)
  for (const slot of grid) {
    if (!window.slots[slot]) continue
    const empty = emptyCargoSlots(window)[0]
    if (empty === undefined) throw new Error('クラフトの材料を戻す空き枠がありません')
    await moveStack(bot, window, slot, empty)
  }
}

// 完成品を 1 回分取り出して、荷物へ置く
async function takeResult(bot, window, name) {
  const result = window.slots[RESULT_SLOT]
  if (result?.name !== name) throw new Error(`${name} をクラフトできませんでした`)
  const target = readCargo(window).find(({ stack }) => stack && stack.name === name && stack.count + result.count <= stack.stackSize)
  const slot = target?.slot ?? emptyCargoSlots(window)[0]
  if (slot === undefined) throw new Error('完成品を置く空き枠がありません')
  await bot.clickWindow(RESULT_SLOT, 0, 0)
  await bot.clickWindow(slot, 0, 0)
  await synchronize(bot, window)
  await clearCursor(bot, window)
}

/**
 * 荷物の原木から、板材が指定した数になるまで作る
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} wanted 必要な板材の数
 */
async function craftPlanks(bot, wanted, signal) {
  const window = bot.inventory
  const grid = INVENTORY_GRID[0]
  while (countPlanks(readCargo(window).flatMap((s) => s.stack ?? [])) < wanted) {
    signal.throwIfAborted()
    const log = readCargo(window).find(({ stack }) => stack && planksPerLog(stack) > 0)
    if (!log) throw new Error('板材にする原木がありません')
    const missing = wanted - countPlanks(readCargo(window).flatMap((s) => s.stack ?? []))
    const times = Math.min(log.stack.count, Math.ceil(missing / planksPerLog(log.stack)))
    try {
      await moveStack(bot, window, log.slot, grid)
      for (let i = 0; i < times; i++) {
        const plank = window.slots[RESULT_SLOT]
        if (!plank) throw new Error('板材をクラフトできませんでした')
        await takeResult(bot, window, plank.name)
      }
    } finally {
      await clearGrid(bot, window, INVENTORY_GRID)
    }
  }
}

// 材料の枠へ材料を 1 つずつ置き、完成品を取り出す
// recipe は、置く枠の番号と、その枠に置けるアイテムの判定の組
async function craftShaped(bot, window, recipe, grid, name) {
  try {
    for (const [slot, usable] of recipe) {
      const material = readCargo(window).find(({ stack }) => stack && usable(stack))
      if (!material) throw new Error(`${name} の材料が足りません`)
      // 持ち上げて、右クリックで 1 つ置き、残りを元の枠へ戻す
      await bot.clickWindow(material.slot, 0, 0)
      await bot.clickWindow(slot, 1, 0)
      if (window.selectedItem) await bot.clickWindow(material.slot, 0, 0)
      await synchronize(bot, window)
      await clearCursor(bot, window)
    }
    await takeResult(bot, window, name)
  } finally {
    await clearGrid(bot, window, grid)
  }
}

const planksAt = (slots) => slots.map((slot) => [slot, isPlank])

// 荷物の板材 4 枚から作業台を作る
const craftTable = (bot) => craftShaped(bot, bot.inventory, planksAt(INVENTORY_GRID), INVENTORY_GRID, 'crafting_table')

// 荷物の板材 2 枚から棒を 4 本作る
const craftSticks = (bot) => craftShaped(bot, bot.inventory, planksAt([1, 3]), INVENTORY_GRID, 'stick')

// 斧の頭に使う石
const isAxeStone = (stack) => !stack.protected && ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(stack.name)

/**
 * 作業台の画面で、木の斧か石の斧を作る
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} table 作業台のブロック
 * @param {'wooden_axe' | 'stone_axe'} name 作る斧
 */
async function craftAxe(bot, table, name) {
  const head = name === 'stone_axe' ? isAxeStone : isPlank
  const isStick = (stack) => stack.name === 'stick' && !stack.protected
  const recipe = [...[1, 2, 4].map((slot) => [slot, head]), ...[5, 8].map((slot) => [slot, isStick])]
  const window = await bot.openBlock(table)
  try {
    await craftShaped(bot, window, recipe, TABLE_GRID, name)
  } finally {
    window.close()
  }
}

/**
 * 作業台の画面で、チェストを指定した数だけ作る
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} table 作業台のブロック
 * @param {number} count 作る数
 */
async function craftChests(bot, table, count, signal) {
  const window = await bot.openBlock(table)
  try {
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted()
      await craftShaped(bot, window, planksAt(CHEST_PATTERN), TABLE_GRID, 'chest')
    }
  } finally {
    window.close()
  }
}

module.exports = { isPlank, planksPerLog, isAxeStone, countPlanks, plankValue, craftPlanks, craftTable, craftSticks, craftAxe, craftChests }
