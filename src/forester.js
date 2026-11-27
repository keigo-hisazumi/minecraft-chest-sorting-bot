// 伐採と植え直し
// 範囲内の自然の木を切って原木を集める。斧は、木の斧と石の斧だけを使う。
// 苗木の植え直しは、指示された場合だけ行う。切った場所は、指示されたときのために記録する。

const { goals } = require('mineflayer-pathfinder')
const { isInRange, formatPosition } = require('./chests')
const { countPlanks, plankValue, planksPerLog, isPlank, isAxeStone, craftPlanks, craftSticks, craftAxe } = require('./crafting')
const { createMovements } = require('./navigation')
const { TREE_LABELS, LOG_NAMES, SOIL, analyzeTree, isNaturalLeaves, isPlacedLeaves } = require('./trees')
const { toVec3, toChest, cargoStacks, emptyCargoSlots, refresh, moveStack, hold, release, hotbarSlots, withChest } = require('./window')

const AXES = ['stone_axe', 'wooden_axe']
// 手が届く距離（ブロック）
const DIG_REACH = 4
// 落ちたアイテムを拾いに行く、根元からの距離（ブロック）
const COLLECT_DISTANCE = 8
// 落ちたアイテムが拾えるようになるのを待つ時間（tick）
const DROP_WAIT_TICKS = 20
// 1 回の呼び出しで伐採する木の数の上限
const TREE_LIMIT = 40
// 拾うアイテム
const PICKUP = /(_log|_sapling|^stick|^apple)$/

const isAxe = (stack) => AXES.includes(stack.name) && !stack.protected
const heldValue = (bot) => cargoStacks(bot.inventory).reduce((total, s) => total + plankValue(s), 0)
const countHeld = (bot, matches) =>
  cargoStacks(bot.inventory).filter(matches).reduce((total, s) => total + s.count, 0)

/**
 * 伐採中の移動のルールを作る。道をふさぐ自然の葉だけは壊してよい。足場は置かない
 */
function createForestryMovements(bot) {
  const movements = createMovements(bot)
  movements.canDig = true
  movements.blocksCantBreak = new Set(bot.registry.blocksArray.filter((b) => !b.name.endsWith('_leaves')).map((b) => b.id))
  movements.exclusionAreasBreak = [(block) => (isPlacedLeaves(block) ? 100 : 0)]
  return movements
}

/**
 * 範囲内の木を調べる
 *
 * @returns {{ trees: object[], tall: number }} trees は伐採してよい木（BOT に近い順）、tall は大きすぎて切らない木の数
 */
function findTrees(bot, center) {
  const ids = LOG_NAMES.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined)
  const found = bot.findBlocks({ matching: ids, point: toVec3(center), maxDistance: 48, count: 4000 })
  const seen = new Set()
  const trees = []
  let tall = 0
  for (const position of found) {
    if (seen.has(position.toString())) continue
    const tree = analyzeTree((p) => bot.blockAt(p), position)
    for (const log of tree.logs) seen.add(log.toString())
    if (!tree.logs.every((p) => isInRange(center, p))) continue
    if (tree.ok) trees.push(tree)
    else if (tree.reason === 'tall') tall++
  }
  const distance = (tree) => bot.entity.position.distanceTo(tree.base[0])
  return { trees: trees.sort((a, b) => distance(a) - distance(b)), tall }
}

// チェストから、条件に合うアイテムを必要な数になるまで取り出す（枠の単位）
async function withdraw(context, records, matches, wanted) {
  const { bot, signal } = context
  for (const record of records) {
    if (countHeld(bot, matches) >= wanted) return
    if (!record.items.some(matches)) continue
    const chest = toChest(record)
    await withChest(context, chest, async (window) => {
      let held = countHeld(bot, matches)
      for (const stack of [...chest.slots.values()].filter(matches)) {
        signal.throwIfAborted()
        const empty = emptyCargoSlots(window)[0]
        if (held >= wanted || empty === undefined) break
        held += await moveStack(bot, window, stack.slot, empty)
        refresh(chest, window)
      }
      // 取り出した分は、調べた中身からも除く
      record.items = [...chest.slots.values()]
      return true
    })
  }
}

// 斧を手に持つ
async function holdAxe(bot) {
  const hotbar = hotbarSlots(bot.inventory).map((slot) => bot.inventory.slots[slot])
  const name = AXES.find((axe) => [...hotbar, ...cargoStacks(bot.inventory)].some((item) => item?.name === axe))
  return name ? hold(bot, name) : false
}

/**
 * 斧を手に持つ。なければチェストから取り出すか、作る
 *
 * @returns {Promise<boolean>} 持てた場合は true。材料がないなどで用意できなければ false
 */
async function ensureAxe(context, records) {
  const { bot, signal, getTable, notify } = context
  if (await holdAxe(bot)) return true
  await withdraw(context, records, isAxe, 1)
  if (await holdAxe(bot)) return true

  await withdraw(context, records, isAxeStone, 3)
  const name = countHeld(bot, isAxeStone) >= 3 ? 'stone_axe' : 'wooden_axe'
  const sticks = () => countHeld(bot, (s) => s.name === 'stick' && !s.protected)
  const needsTable = !(await getTable({ create: false }))
  const planks = (sticks() < 2 ? 2 : 0) + (name === 'wooden_axe' ? 3 : 0) + (needsTable ? 4 : 0)
  if (heldValue(bot) < planks) return false
  signal.throwIfAborted()
  if (countPlanks(cargoStacks(bot.inventory)) < planks) {
    notify('クラフトします: 板材')
    await craftPlanks(bot, planks, signal)
  }
  const table = await getTable({ create: true })
  if (!table) return false
  if (sticks() < 2) {
    notify('クラフトします: 棒')
    await craftSticks(bot)
  }
  const reached = await context.navigator.moveTo(new goals.GoalLookAtBlock(table.position, bot.world, { reach: DIG_REACH }))
  signal.throwIfAborted()
  if (reached.status !== 'arrived') return false
  notify(`クラフトします: ${name === 'stone_axe' ? '石の斧' : '木の斧'}`)
  await craftAxe(bot, table, name)
  return holdAxe(bot)
}

// 手の届く場所へ移って、ブロックを壊す
async function digAt(context, position, name, near) {
  const { bot, navigator, signal } = context
  const target = () => bot.blockAt(position)
  if (target()?.name !== name) return false
  if (!bot.canDigBlock(target())) {
    await navigator.moveTo(new goals.GoalLookAtBlock(position, bot.world, { reach: DIG_REACH }), createForestryMovements)
    signal.throwIfAborted()
    // 見える位置がなければ、根元に立って下から掘る
    if (!bot.canDigBlock(target()) && near) {
      await navigator.moveTo(new goals.GoalNear(near.x, near.y, near.z, 0), createForestryMovements)
      signal.throwIfAborted()
    }
  }
  if (target()?.name !== name || !bot.canDigBlock(target())) return false
  try {
    await bot.dig(target(), true)
  } catch (err) {
    console.error(`(${formatPosition(position)}) を壊せませんでした:`, err.message)
  }
  signal.throwIfAborted()
  return target()?.name !== name
}

// 落ちている原木や苗木を拾う
async function collectDrops(context, center) {
  const { bot, navigator, signal } = context
  await bot.waitForTicks(DROP_WAIT_TICKS)
  const tried = new Set()
  for (;;) {
    signal.throwIfAborted()
    if (emptyCargoSlots(bot.inventory).length === 0) return
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === 'item' && !tried.has(e.id) && e.position.distanceTo(center) <= COLLECT_DISTANCE)
      .filter((e) => PICKUP.test(e.getDroppedItem()?.name ?? ''))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!drop) return
    tried.add(drop.id)
    const { x, y, z } = drop.position.floored()
    await navigator.moveTo(new goals.GoalNear(x, y, z, 0), createForestryMovements)
    signal.throwIfAborted()
    await bot.waitForTicks(5)
  }
}

/**
 * 苗木を植え直す。指示された場合だけ呼び出す
 *
 * @param {object} context
 * @param {Array<{ x: number, y: number, z: number, name: string }>} pending 植え直す場所と苗木
 * @param {Array<object>} records チェストの中身。苗木がなければ取り出す
 * @returns {Promise<{ planted: number, pending: object[] }>} 植えた数と、まだ植えていない場所
 */
async function replant(context, pending, records) {
  const { bot, navigator, signal } = context
  const rest = []
  let planted = 0
  try {
    for (const [index, spot] of pending.entries()) {
      signal.throwIfAborted()
      const cell = toVec3(spot)
      const floor = bot.blockAt(cell.offset(0, -1, 0))
      let block = bot.blockAt(cell)
      // 読み込まれていない場所は、後で植える
      if (!block || !floor) {
        rest.push(spot)
        continue
      }
      // すでに植わっているか、地面でなくなった場所は、植え直さない
      if (block.name === spot.name || !SOIL.has(floor.name)) continue
      if (isNaturalLeaves(block)) {
        await digAt(context, cell, block.name)
        block = bot.blockAt(cell)
      }
      if (block.boundingBox !== 'empty') continue
      const sapling = (s) => s.name === spot.name && !s.protected
      if (countHeld(bot, sapling) === 0) {
        await withdraw(context, records, sapling, pending.slice(index).filter((p) => p.name === spot.name).length)
      }
      if (!(await hold(bot, spot.name))) {
        rest.push(spot)
        continue
      }
      // 植える場所には立たない
      const goal = new goals.GoalCompositeAll([
        new goals.GoalNear(cell.x, cell.y, cell.z, 3),
        new goals.GoalInvert(new goals.GoalNear(cell.x, cell.y, cell.z, 1))
      ])
      await navigator.moveTo(goal, createForestryMovements)
      signal.throwIfAborted()
      if (!(await hold(bot, spot.name))) {
        rest.push(spot)
        continue
      }
      try {
        await bot.placeBlock(bot.blockAt(cell.offset(0, -1, 0)), cell.minus(floor.position))
      } catch (err) {
        console.error(`(${formatPosition(cell)}) に苗木を植えられませんでした:`, err.message)
        signal.throwIfAborted()
      }
      await bot.waitForTicks(5)
      if (bot.blockAt(cell)?.name === spot.name) planted++
      else rest.push(spot)
    }
  } finally {
    await release(bot, (item) => item.name.endsWith('_sapling')).catch((err) => console.error('苗木を戻せませんでした:', err.message))
  }
  return { planted, pending: rest }
}

// 1 本の木を切り、落ちた原木と、落ちていれば苗木を拾う
async function fellTree(context, tree, records) {
  const { bot } = context
  let cut = 0
  for (const position of tree.logs) {
    // 斧が壊れたら作り直す。用意できなければ素手で掘る
    if (!(await ensureAxe(context, records))) context.barehanded = true
    if (await digAt(context, position, `${tree.type}_log`, tree.base[0])) cut++
  }
  if (cut > 0) await collectDrops(context, tree.base[0])
  return cut
}

/**
 * 手持ちの木材が、板材に換算して必要な数になるまで伐採する
 *
 * @param {object} context bot、navigator、signal、center、failed と、作業台を返す getTable、通知する notify
 * @param {object} options
 * @param {number} options.wanted 必要な板材の数
 * @param {Array<object>} options.records チェストの中身
 * @param {number} [options.maxTrees] 切る木の本数の上限（既定は TREE_LIMIT。TREE_LIMIT より多くはしない）
 * @param {Array<object>} options.pending 植え直していない場所
 * @param {(pending: Array<object>) => void} options.savePending 植え直していない場所を保存する関数
 * @returns {Promise<{ trees: number, logs: number, pending: object[], tall: number, exhausted: boolean, barehanded: boolean }>}
 *   exhausted は、必要な数が揃う前に切れる木がなくなったことを表す
 */
async function gatherWood(context, { wanted, records, maxTrees = TREE_LIMIT, pending, savePending }) {
  const { bot, signal, notify } = context
  const result = { trees: 0, logs: 0, pending, tall: 0, exhausted: false, barehanded: false }
  const skipped = new Set()
  // 伐採を始める前から空いている枠には、拾ったアイテムが入る
  const emptyBefore = new Set(hotbarSlots(bot.inventory).filter((slot) => !bot.inventory.slots[slot]))
  const stow = () => release(bot, (item, slot) => emptyBefore.has(slot) && PICKUP.test(item.name))
  const limit = Math.min(maxTrees, TREE_LIMIT)
  while (heldValue(bot) < wanted && result.trees < limit && emptyCargoSlots(bot.inventory).length > 1) {
    signal.throwIfAborted()
    const found = findTrees(bot, context.center)
    result.tall = found.tall
    const tree = found.trees.find((t) => !skipped.has(t.base[0].toString()))
    if (!tree) {
      result.exhausted = true
      break
    }
    skipped.add(tree.base[0].toString())
    notify(`伐採します: ${TREE_LABELS[tree.type]} (${formatPosition(tree.base[0])})`)
    // 切る前に植え直す場所を保存して、中断しても忘れないようにする
    const spots = tree.base.map(({ x, y, z }) => ({ x, y, z, name: `${tree.type}_sapling` }))
    const fresh = spots.filter((s) => !result.pending.some((p) => p.x === s.x && p.y === s.y && p.z === s.z))
    result.pending = [...result.pending, ...fresh]
    savePending(result.pending)
    const cut = await fellTree(context, tree, records)
    await stow()
    if (cut === 0) {
      // 1 本も切れなければ、植え直す必要はない
      result.pending = result.pending.filter((p) => !fresh.includes(p))
      savePending(result.pending)
      continue
    }
    result.trees++
    result.logs += cut
  }
  result.barehanded = Boolean(context.barehanded)
  return result
}

module.exports = { TREE_LIMIT, gatherWood, replant, findTrees, createForestryMovements }
