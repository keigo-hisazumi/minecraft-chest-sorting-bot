// チェストの作成、設置、拡張
// チェスト内と手持ちの原木・板材からチェストを作り、整理先の単体チェストを広げ、足りない大きなチェストを置く。

const { goals } = require('mineflayer-pathfinder')
const { CHEST_NAME, chestPositions, isInRange, overlaps, formatPosition } = require('./chests')
const { countPlanks, plankValue, isPlank, planksPerLog, craftPlanks, craftTable, craftChests } = require('./crafting')
const { buildPlan } = require('./plan')
const { expansionSites, newChestSites, tableSites } = require('./sites')
const { REACH } = require('./survey')
const { toVec3, toChest, cargoStacks, emptyCargoSlots, refresh, moveStack, withChest, CARGO_SLOTS } = require('./window')

const TABLE_NAME = 'crafting_table'
const PLANKS_PER_CHEST = 8
const PLANKS_PER_TABLE = 4
// 1 回の整理で作るチェストの数の上限
const CHEST_LIMIT = 32
// 材料を取り出すときに、空けておく荷物の枠の数
const RESERVED_SLOTS = 4
// 置く場所に行けないなどの場合に、別の場所を試す回数
const SITE_ATTEMPTS = 5
// 置いた結果がサーバーから届くのを待つ時間（tick）
const SETTLE_TICKS = 5
// 向きごとの、BOT が向く角度。チェストは、置いた人の方を向く
const YAW_TOWARD_CHEST = { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 }

const isLarge = (record) => record.positions.length === 2
const total = (stacks, value) => stacks.reduce((sum, s) => sum + value(s), 0)

/**
 * 作るチェストを決める
 *
 * @returns {{ expansions: object[], blocked: object[], newChests: number, skippedNew: boolean }}
 *   expansions は広げる単体チェスト、blocked は隣に置けない単体チェスト
 */
function planBuild(bot, survey, world, center) {
  const blockAt = (position) => bot.blockAt(position)
  const singles = survey.chests.filter((record) => !isLarge(record))
  const expansions = singles.filter((record) => expansionSites(blockAt, record.positions[0], center).length > 0)
  const blocked = singles.filter((record) => !expansions.includes(record))
  // 広げられるチェストは、大きなチェストになるものとして、足りない数を数える
  const willBeLarge = (record) => isLarge(record) || expansions.some((e) => overlaps(e.positions, record.positions))
  const source = { ...survey.source, items: [...survey.source.items, ...cargoStacks(bot.inventory)] }
  const plan = buildPlan(
    { source, chests: survey.chests },
    { previous: world.assignments, canDedicate: willBeLarge, capacity: (record) => (willBeLarge(record) ? 54 : 27) }
  )
  const missing = [
    ...plan.dedicated.filter((d) => d.chest === null && d.total > 0),
    ...plan.mixed.chests.filter((c) => c === null),
    ...plan.protected.chests.filter((c) => c === null)
  ].length
  // 調べられないチェストがあると、足りないかを判断できない。作り続けないように、新しくは作らない
  const skippedNew = missing > 0 && survey.failed.length > 0
  return { expansions, blocked, newChests: skippedNew ? 0 : missing, skippedNew }
}

// 範囲内の作業台のうち、行けるものを返す
async function findTable(context) {
  const { bot, navigator, signal, center } = context
  const id = bot.registry.blocksByName[TABLE_NAME].id
  const found = bot
    .findBlocks({ matching: id, point: toVec3(center), maxDistance: 48, count: 64 })
    .filter((position) => isInRange(center, position))
  for (const position of found.slice(0, SITE_ATTEMPTS)) {
    const result = await navigator.moveTo(new goals.GoalLookAtBlock(position, bot.world, { reach: REACH }))
    signal.throwIfAborted()
    const block = bot.blockAt(position)
    if (result.status === 'arrived' && block?.name === TABLE_NAME) return block
  }
  return null
}

// 手に持つためにホットバーの空き枠へ移す。空きがなければ false
async function hold(bot, name) {
  const { inventory } = bot
  const hotbarStart = inventory.inventoryStart + CARGO_SLOTS
  const slots = Array.from({ length: 9 }, (v, i) => hotbarStart + i)
  let target = slots.find((slot) => inventory.slots[slot]?.name === name)
  if (target === undefined) {
    const item = cargoStacks(inventory).find((s) => s.name === name)
    target = slots.find((slot) => !inventory.slots[slot])
    if (!item || target === undefined) return false
    await moveStack(bot, inventory, item.slot, target)
  }
  bot.setQuickBarSlot(target - hotbarStart)
  return true
}

// 手元に残ったチェストと作業台は、荷物に戻して整理の対象にする
async function release(bot, name) {
  const { inventory } = bot
  const hotbarStart = inventory.inventoryStart + CARGO_SLOTS
  for (let slot = hotbarStart; slot < hotbarStart + 9; slot++) {
    const empty = emptyCargoSlots(inventory)[0]
    if (inventory.slots[slot]?.name === name && empty !== undefined) await moveStack(bot, inventory, slot, empty)
  }
}

// 正面のマスに立ち、床の上へ手に持ったブロックを置く
async function placeAt({ bot, navigator, signal }, { cell, front, facing }, name) {
  const result = await navigator.moveTo(new goals.GoalBlock(front.x, front.y, front.z))
  signal.throwIfAborted()
  if (result.status !== 'arrived' || bot.blockAt(cell)?.boundingBox !== 'empty') return false
  if (bot.heldItem?.name !== name) return false
  // 置いたチェストの向きは、BOT の向きで決まる
  await bot.look(YAW_TOWARD_CHEST[facing], -Math.PI / 4, true)
  await bot.waitForTicks(SETTLE_TICKS)
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  try {
    await bot._placeBlockWithOptions(floor, cell.minus(floor.position), { forceLook: 'ignore', swingArm: 'right' })
  } catch (err) {
    console.error(`(${formatPosition(cell)}) に置けませんでした:`, err.message)
    signal.throwIfAborted()
  }
  await bot.waitForTicks(SETTLE_TICKS)
  return bot.blockAt(cell)?.name === name
}

// 置いたチェストが大きなチェストになり、開けることを確かめる
async function verifyLargeChest(context, cell) {
  const block = context.bot.blockAt(cell)
  const positions = chestPositions(block)
  if (positions.length !== 2) return false
  const chest = toChest({ positions, items: [] })
  return (await withChest({ ...context, failed: [] }, chest, async () => true)) === true
}

async function expand(context, record) {
  const sites = expansionSites((p) => context.bot.blockAt(p), record.positions[0], context.center)
  for (const site of sites) {
    if (!(await hold(context.bot, CHEST_NAME))) return false
    if (await placeAt(context, site, CHEST_NAME)) return verifyLargeChest(context, site.cell)
  }
  return false
}

async function createLargeChest(context, preferred) {
  let attempts = 0
  for (const [first, second] of newChestSites((p) => context.bot.blockAt(p), context.center, preferred)) {
    if (attempts++ >= SITE_ATTEMPTS) break
    if (!(await hold(context.bot, CHEST_NAME))) return false
    if (!(await placeAt(context, first, CHEST_NAME))) continue
    // 2 つ目を置けなかった場合、1 つ目は単体チェストとして残り、次の整理で広げる
    if (!(await hold(context.bot, CHEST_NAME)) || !(await placeAt(context, second, CHEST_NAME))) return false
    return verifyLargeChest(context, second.cell)
  }
  return false
}

// チェストから、板材、原木の順に、必要な分の材料を取り出す
async function withdrawMaterials(context, records, wanted) {
  const { bot, signal } = context
  const held = () => total(cargoStacks(bot.inventory), plankValue)
  for (const usable of [isPlank, (stack) => planksPerLog(stack) > 0]) {
    for (const record of records) {
      if (held() >= wanted) return
      if (!record.items.some(usable)) continue
      const chest = toChest(record)
      await withChest(context, chest, async (window) => {
        for (const stack of [...chest.slots.values()].filter(usable)) {
          signal.throwIfAborted()
          const empty = emptyCargoSlots(window)
          if (held() >= wanted || empty.length <= RESERVED_SLOTS) break
          await moveStack(bot, window, stack.slot, empty[0])
          refresh(chest, window)
          // 開いている間は BOT のインベントリに反映されないため、数え直すために閉じる前の画面を使う
          if (total(cargoStacks(window), plankValue) >= wanted) break
        }
        return true
      })
    }
  }
}

// 手持ちの材料で作れる数に、作るチェストを減らす。広げる分を先にする
function affordable(chestItems, expansions, newChests) {
  const expand = Math.min(expansions.length, chestItems)
  const create = Math.min(newChests, Math.floor((chestItems - expand) / 2))
  return { expand, create }
}

/**
 * 必要なチェストを作って置く
 *
 * @param {object} options
 * @param {import('mineflayer').Bot} options.bot
 * @param {import('./navigation').Navigator} options.navigator
 * @param {object} options.survey 調査の結果
 * @param {object} options.world 登録情報
 * @param {AbortSignal} options.signal 中止の合図
 * @returns {Promise<{ changed: boolean, expanded: number, created: number, tablePlaced: boolean, problems: string[] }>}
 *   changed が true の場合は、調査し直す必要がある
 */
async function buildChests({ bot, navigator, survey, world, signal }) {
  const center = world.source.positions[0]
  const context = { bot, navigator, signal, center, failed: [] }
  const result = { changed: false, expanded: 0, created: 0, tablePlaced: false, problems: [] }
  const { expansions, blocked, newChests, skippedNew } = planBuild(bot, survey, world, center)
  if (blocked.length > 0) {
    result.problems.push(`隣に置けず広げられない単体チェスト: ${blocked.length} 個（${formatPosition(blocked[0].positions[0])} など）`)
  }
  if (skippedNew) result.problems.push('調べられないチェストがあるため、新しいチェストは作りません')
  const wantedItems = Math.min(CHEST_LIMIT, expansions.length + 2 * newChests)
  if (wantedItems === 0) return result

  let table = await findTable(context)
  const stock = () => cargoStacks(bot.inventory)
  const heldChests = () => total(stock().filter((s) => s.name === CHEST_NAME && !s.protected), (s) => s.count)
  const hasTable = () => table !== null || stock().some((s) => s.name === TABLE_NAME)
  const planksFor = (items) => {
    const toCraft = Math.max(0, items - heldChests())
    return toCraft * PLANKS_PER_CHEST + (toCraft > 0 && !hasTable() ? PLANKS_PER_TABLE : 0)
  }

  const records = [survey.source, ...survey.chests]
  const needed = planksFor(wantedItems)
  const available = total(stock(), plankValue) + total(records.flatMap((r) => r.items), plankValue)
  // 1 個も作れないほど少ない場合は、取り出さない
  if (total(stock(), plankValue) < needed && available >= planksFor(1)) {
    result.changed = true
    await withdrawMaterials(context, records, needed)
  }
  // 材料が足りる数まで減らす
  let items = wantedItems
  while (items > 0 && planksFor(items) > total(stock(), plankValue)) items--
  if (items < wantedItems) {
    result.problems.push(`板材が ${planksFor(wantedItems) - total(stock(), plankValue)} 枚足りないため、一部のチェストを作れません`)
  }
  const { expand: expandCount, create: createCount } = affordable(items, expansions, newChests)
  const chestItems = expandCount + 2 * createCount
  if (chestItems === 0) return result
  result.changed = true

  const toCraft = Math.max(0, chestItems - heldChests())
  if (toCraft > 0) {
    const planks = toCraft * PLANKS_PER_CHEST + (hasTable() ? 0 : PLANKS_PER_TABLE)
    if (countPlanks(stock()) < planks) await craftPlanks(bot, planks, signal)
    if (!table) {
      if (!hasTable()) await craftTable(bot)
      table = await placeTable(context)
      if (!table) {
        result.problems.push('作業台を置く場所がないか、ホットバーに空きがありません')
        return result
      }
      result.tablePlaced = true
    }
    const reached = await navigator.moveTo(new goals.GoalLookAtBlock(table.position, bot.world, { reach: REACH }))
    signal.throwIfAborted()
    if (reached.status !== 'arrived') throw new Error('作業台に近づけません')
    await craftChests(bot, table, toCraft, signal)
  }

  const preferred = bot.blockAt(toVec3(center))?.getProperties().facing
  try {
    for (const record of expansions.slice(0, expandCount)) {
      signal.throwIfAborted()
      if (await expand(context, record)) result.expanded++
    }
    for (let i = 0; i < createCount; i++) {
      signal.throwIfAborted()
      if (!(await createLargeChest(context, preferred))) break
      result.created++
    }
  } finally {
    // 切断した場合は戻せない。手元に残ったチェストは、次に置くときに使う
    await release(bot, CHEST_NAME).catch((err) => console.error('残ったチェストを戻せませんでした:', err.message))
  }
  if (result.expanded < expandCount || result.created < createCount) {
    result.problems.push('チェストを置けませんでした。置く場所と、ホットバーの空きを確認してください')
  }
  return result
}

async function placeTable(context) {
  let attempts = 0
  for (const site of tableSites((p) => context.bot.blockAt(p), context.center)) {
    if (attempts++ >= SITE_ATTEMPTS || !(await hold(context.bot, TABLE_NAME))) break
    if (await placeAt(context, site, TABLE_NAME)) return context.bot.blockAt(site.cell)
  }
  return null
}

module.exports = { buildChests, planBuild }
