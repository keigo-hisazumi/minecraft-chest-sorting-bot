// 伐採
// 範囲内の自然の木を切って原木を集める。斧は、木の斧と石の斧だけを使う。苗木は植え直さない。

const { goals } = require('mineflayer-pathfinder')
const { VERTICAL_RANGE, isInRange } = require('./chests')
const { formatPosition, message } = require('./messages')
const { countPlanks, plankValue, isAxeStone, craftPlanks, craftSticks, craftAxe } = require('./crafting')
const { createMovements } = require('./navigation')
const { TREE_LABELS, LOG_NAMES, analyzeTree, analyzeRemnant } = require('./trees')
const { MAX_CLIMB } = require('./climb')
const { fellTree: fellTree_, allowLeafBreaking, PICKUP, DIG_REACH } = require('./felling')
const { toVec3, toChest, cargoStacks, emptyCargoSlots, refresh, moveStack, hold, release, hotbarSlots, withChest } = require('./window')

const AXES = ['stone_axe', 'wooden_axe']
// 1 回の呼び出しで伐採する木の数の上限
const TREE_LIMIT = 40

const isAxe = (stack) => AXES.includes(stack.name) && !stack.protected
const heldValue = (bot) => cargoStacks(bot.inventory).reduce((total, s) => total + plankValue(s), 0)
const countHeld = (bot, matches) =>
  cargoStacks(bot.inventory).filter(matches).reduce((total, s) => total + s.count, 0)

/**
 * 伐採中の移動のルールを作る。道をふさぐ自然の葉だけは壊してよい。足場は置かない
 */
function createForestryMovements(bot) {
  return allowLeafBreaking(createMovements(bot), bot.registry)
}

/**
 * 木が範囲内にあるかを判定する
 * 原木は水平の範囲に収まり、根元（切り残しなら一番下の原木）が上下の範囲に収まればよい。
 * 高い木の上の方は、上下の範囲を超えても切る（登って切るため）。
 */
function inArea(center, tree) {
  const [base] = tree.base
  const flat = (p) => ({ x: p.x, y: center.y, z: p.z })
  if (!tree.logs.every((p) => isInRange(center, flat(p)))) return false
  // 切り残しは、根元より高い位置に浮いているため、木の高さの分まで上を許す
  const above = tree.remnant ? VERTICAL_RANGE + MAX_CLIMB : VERTICAL_RANGE
  return base.y - center.y >= -VERTICAL_RANGE && base.y - center.y <= above
}

/**
 * 範囲内の木を調べる
 *
 * @returns {{ trees: object[] }} trees は伐採してよい木と切り残し（remnant が true。中心に近い順）
 */
function findTrees(bot, center) {
  const ids = LOG_NAMES.map((name) => bot.registry.blocksByName[name]?.id).filter((id) => id !== undefined)
  const found = bot.findBlocks({ matching: ids, point: toVec3(center), maxDistance: 48, count: 4000 })
  const seen = new Set()
  const trees = []
  for (const position of found) {
    if (seen.has(position.toString())) continue
    let tree = analyzeTree((p) => bot.blockAt(p), position)
    // 根元を切ったあとに上部が残った木（切り残し）も、切る対象にする
    if (!tree.ok && tree.reason === 'built') tree = analyzeRemnant((p) => bot.blockAt(p), position)
    for (const log of tree.logs) seen.add(log.toString())
    if (!inArea(center, tree)) continue
    if (tree.ok) trees.push(tree)
  }
  const distance = (tree) => toVec3(center).distanceTo(tree.base[0])
  return { trees: trees.sort((a, b) => distance(a) - distance(b)) }
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
  const { bot } = context
  if (await holdAxe(bot)) return true
  // 一度用意できなかったら、同じ作業の間は作り直そうとしない（木を切るたびにクラフトを試して、手を止めないため）
  if (context.axeUnavailable) return false
  await withdraw(context, records, isAxe, 1)
  if (await holdAxe(bot)) return true
  const made = await makeAxe(context, records)
  if (!made) context.axeUnavailable = true
  return made
}

// 斧を作って手に持つ。材料か作業台がなければ false
async function makeAxe(context, records) {
  const { bot, signal, getTable, notify } = context

  await withdraw(context, records, isAxeStone, 3)
  const name = countHeld(bot, isAxeStone) >= 3 ? 'stone_axe' : 'wooden_axe'
  const sticks = () => countHeld(bot, (s) => s.name === 'stick' && !s.protected)
  const needsTable = !(await getTable({ create: false }))
  const planks = (sticks() < 2 ? 2 : 0) + (name === 'wooden_axe' ? 3 : 0) + (needsTable ? 4 : 0)
  if (heldValue(bot) < planks) return false
  signal.throwIfAborted()
  if (countPlanks(cargoStacks(bot.inventory)) < planks) {
    notify(message.start('クラフト', '板材'))
    await craftPlanks(bot, planks, signal)
  }
  const table = await getTable({ create: true })
  if (!table) return false
  if (sticks() < 2) {
    notify(message.start('クラフト', '棒'))
    await craftSticks(bot)
  }
  const reached = await context.navigator.moveTo(new goals.GoalLookAtBlock(table.position, bot.world, { reach: DIG_REACH }))
  signal.throwIfAborted()
  if (reached.status !== 'arrived') return false
  notify(message.start('クラフト', name === 'stone_axe' ? '石の斧' : '木の斧'))
  await craftAxe(bot, table, name)
  return holdAxe(bot)
}

// 共通の伐採処理（felling.js）に渡す、この BOT での移動・斧・持ち物の扱い
function forestryOps(context, records) {
  const { bot, navigator, signal } = context
  const own = (tree) => (tree ? `${tree.type}_log` : null)
  return {
    bot,
    moveTo: async (goal) => (await navigator.moveTo(goal, createForestryMovements)).status === 'arrived',
    isCancelled: () => signal.aborted,
    ensureAxe: () => ensureAxe(context, records),
    holdAxe: () => holdAxe(bot),
    holdBlock: async () => {
      // 足場には原木を使う（同じ種類があれば優先する）
      const names = context.tree ? [own(context.tree), ...LOG_NAMES.filter((n) => n !== own(context.tree))] : LOG_NAMES
      for (const name of names) {
        if (await hold(bot, name)) return true
      }
      return false
    },
    canPickUp: () => emptyCargoSlots(bot.inventory).length > 0,
    notify: context.notify ?? (() => {})
  }
}

// 1 本の木を切り、落ちた原木と、落ちていれば苗木を拾う。切った原木の数を返す
async function fellTree(context, tree, records) {
  context.tree = tree
  try {
    const result = await fellTree_(forestryOps(context, records), tree)
    if (result.barehanded) context.barehanded = true
    return result.cut
  } finally {
    context.tree = null
  }
}


/**
 * 手持ちの木材が、板材に換算して必要な数になるまで伐採する
 *
 * @param {object} context bot、navigator、signal、center、failed と、作業台を返す getTable、通知する notify
 * @param {object} options
 * @param {number} options.wanted 必要な板材の数
 * @param {Array<object>} options.records チェストの中身
 * @param {number} [options.maxTrees] 切る木の本数の上限（既定は TREE_LIMIT。Infinity なら、切れる木がなくなるまで切る）
 * @returns {Promise<{ trees: number, remnants: number, logs: number, exhausted: boolean, barehanded: boolean }>}
 *   remnants は切った切り残し（根元を切ったあとに上部が残った木）の数で、trees には含めない
 *   exhausted は、必要な数が揃う前に切れる木がなくなったことを表す
 */
async function gatherWood(context, { wanted, records, maxTrees = TREE_LIMIT }) {
  const { bot, signal, notify } = context
  const result = { trees: 0, remnants: 0, logs: 0, exhausted: false, barehanded: false }
  const skipped = new Set()
  // 伐採を始める前から空いている枠には、拾ったアイテムが入る
  const emptyBefore = new Set(hotbarSlots(bot.inventory).filter((slot) => !bot.inventory.slots[slot]))
  const stow = () => release(bot, (item, slot) => emptyBefore.has(slot) && PICKUP.test(item.name))
  while (heldValue(bot) < wanted && result.trees < maxTrees && emptyCargoSlots(bot.inventory).length > 1) {
    signal.throwIfAborted()
    const found = findTrees(bot, context.center)
    const tree = found.trees.find((t) => !skipped.has(t.base[0].toString()))
    if (!tree) {
      result.exhausted = true
      break
    }
    skipped.add(tree.base[0].toString())
    const label = `${TREE_LABELS[tree.type]}${tree.remnant ? 'の切り残し' : ''}`
    notify(message.start('伐採', `${label} ${formatPosition(tree.base[0])}`, tree.remnant ? `原木 ${tree.logs.length} 個` : null))
    const cut = await fellTree(context, tree, records)
    await stow()
    if (cut === 0) continue
    // 切り残しは、切った木の本数に数えない
    if (tree.remnant) result.remnants++
    else result.trees++
    result.logs += cut
  }
  result.barehanded = Boolean(context.barehanded)
  return result
}

module.exports = { TREE_LIMIT, gatherWood, findTrees, createForestryMovements }
