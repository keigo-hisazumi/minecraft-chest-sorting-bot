// 振り分けの計画
// チェストの中身から、どのアイテムをどのチェストへ入れるかを決める。アイテムは動かさない。

const { overlaps } = require('./chests')
const { emptyAssignments } = require('./state')

// 大きなチェストの枠の数
const LARGE_CHEST_SLOTS = 54
// 専用チェストを作る個数（最大スタック数の倍数）
const THRESHOLD_STACKS = 3
// クラフトに使う板材の枚数
const PLANKS_PER_NEW_CHEST = 16
const PLANKS_PER_EXPANSION = 8

const sum = (values) => values.reduce((total, v) => total + v, 0)
const slotsFor = ({ count, stackSize }) => Math.ceil(count / stackSize)
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * アイテムを名前ごとにまとめる。同じ枠にまとめられるものは 1 つの variant にする
 *
 * @param {Array<{ items: Array<object> }>} records チェストの中身
 */
function totalItems(records) {
  const totals = new Map()
  for (const item of records.flatMap((record) => record.items)) {
    const entry = totals.get(item.name) ?? { name: item.name, total: 0, stackSize: 0, variants: new Map() }
    totals.set(item.name, entry)
    entry.total += item.count
    entry.stackSize = Math.max(entry.stackSize, item.stackSize)
    const variant = entry.variants.get(item.variant) ?? { ...item, count: 0 }
    variant.count += item.count
    entry.variants.set(item.variant, variant)
  }
  return [...totals.values()]
}

/**
 * 専用チェスト 1 つに入る分と、あふれる分を分ける
 * 捨てる量が少なくなるように、保護対象でないものから先に入れる。
 */
function fillDedicated(variants) {
  const ordered = [...variants].sort((a, b) => Number(a.protected) - Number(b.protected) || compareText(a.variant, b.variant))
  let slotsLeft = LARGE_CHEST_SLOTS
  let discard = 0
  const overflow = []
  for (const variant of ordered) {
    const used = Math.min(slotsFor(variant), slotsLeft)
    slotsLeft -= used
    const rest = variant.count - Math.min(variant.count, used * variant.stackSize)
    if (rest === 0) continue
    if (variant.protected) overflow.push({ ...variant, count: rest })
    else discard += rest
  }
  return { discard, overflow }
}

/**
 * 整理先のチェストを、専用、混合、保護対象に割り当てる
 * 前回の割り当てを引き継ぎ、残りは専用、混合、保護対象の順に決める。足りない分は null（新しく作る）にする。
 * 移す量が少なくなるように、そのアイテムが多いチェストを優先する。
 *
 * @param {Array<{ positions: Array<object>, items: Array<object> }>} chests 整理先のチェスト
 * @param {object} request
 * @param {string[]} request.dedicatedNames 専用チェストを作るアイテム（優先する順）
 * @param {number} request.mixedSlots 混合チェストに必要な枠の数
 * @param {number} request.protectedSlots 保護対象チェストに必要な枠の数
 * @param {object} options buildPlan の options
 */
function assignChests(chests, { dedicatedNames, mixedSlots, protectedSlots }, { previous, canDedicate, capacity }) {
  const free = new Set(chests)
  const countOf = (chest, name) => sum(chest.items.filter((i) => i.name === name).map((i) => i.count))
  // 大きなチェストを先に、中身が少ない順に使う
  const byEase = (a, b) => b.positions.length - a.positions.length || a.items.length - b.items.length
  const use = (chest) => {
    free.delete(chest)
    return chest
  }
  const take = (compare, filter = () => true) => {
    const chosen = [...free].filter(filter).sort(compare)[0]
    return chosen ? use(chosen) : null
  }
  // 前回と同じ場所のチェスト（大きなチェストに広げられていても一致する）
  const takeAt = (positions, filter) => (positions ? take(byEase, (c) => overlaps(c.positions, positions) && filter(c)) : null)

  const dedicated = new Map(dedicatedNames.map((name) => [name, null]))
  for (const name of dedicatedNames) dedicated.set(name, takeAt(previous.dedicated[name], canDedicate))
  const keep = (list) => list.map((positions) => takeAt(positions, () => true)).filter(Boolean)
  const mixed = mixedSlots > 0 ? keep(previous.mixed) : []
  const protectedChests = protectedSlots > 0 ? keep(previous.protected) : []

  // アイテムがすでに入っているチェストを、入っている数が多い組み合わせから割り当てる
  const holdings = dedicatedNames
    .flatMap((name) => chests.map((chest) => ({ name, chest, count: countOf(chest, name) })))
    .filter((holding) => holding.count > 0 && canDedicate(holding.chest))
    .sort((a, b) => b.count - a.count || byEase(a.chest, b.chest))
  for (const { name, chest } of holdings) {
    if (!dedicated.get(name) && free.has(chest)) dedicated.set(name, use(chest))
  }
  for (const name of dedicatedNames) {
    if (!dedicated.get(name)) dedicated.set(name, take(byEase, canDedicate))
  }

  // 枠が足りるまでチェストを増やし、足りない分は新しいチェストの数だけ null を足す
  const fill = (list, slots, compare) => {
    let rest = slots - sum(list.map(capacity))
    while (rest > 0) {
      const chest = take(compare)
      if (!chest) break
      list.push(chest)
      rest -= capacity(chest)
    }
    return [...list, ...Array(Math.max(0, Math.ceil(rest / LARGE_CHEST_SLOTS))).fill(null)]
  }
  const isDedicated = new Set(dedicatedNames)
  const mixedItems = (chest) => chest.items.filter((i) => !isDedicated.has(i.name)).length
  const positions = (chest) => chest?.positions ?? null
  return {
    dedicated: new Map([...dedicated].map(([name, chest]) => [name, positions(chest)])),
    mixed: fill(mixed, mixedSlots, (a, b) => mixedItems(b) - mixedItems(a) || byEase(a, b)).map(positions),
    protected: fill(protectedChests, protectedSlots, byEase).map(positions)
  }
}

/**
 * 振り分けの計画を作る
 *
 * @param {object} survey
 * @param {{ positions: Array<object>, items: Array<object> }} survey.source 指定チェストの中身
 * @param {Array<{ positions: Array<object>, items: Array<object> }>} survey.chests 整理先のチェストの中身
 * @param {object} [options]
 * @param {{ dedicated: object, mixed: Array, protected: Array }} [options.previous] 前回の割り当て
 * @param {(chest: object) => boolean} [options.canDedicate] 専用チェストにできるか（既定は、広げる前提ですべて可）
 * @param {(chest: object) => number} [options.capacity] チェストの枠の数（既定は、広げる前提で大きなチェストの枠の数）
 * @returns {object} 計画
 */
function buildPlan({ source, chests }, { previous = emptyAssignments(), canDedicate = () => true, capacity = () => LARGE_CHEST_SLOTS } = {}) {
  const totals = totalItems([source, ...chests]).sort((a, b) => b.total - a.total || compareText(a.name, b.name))
  // 一度専用チェストを作ったアイテムは、少なくなっても（なくなっても）専用のままにする
  for (const name of Object.keys(previous.dedicated)) {
    if (!totals.some((entry) => entry.name === name)) totals.push({ name, total: 0, stackSize: 1, variants: new Map() })
  }
  const isDedicated = (entry) => Object.hasOwn(previous.dedicated, entry.name) || entry.total >= THRESHOLD_STACKS * entry.stackSize
  const dedicatedEntries = totals.filter(isDedicated)
  const mixedEntries = totals.filter((entry) => !isDedicated(entry)).sort((a, b) => compareText(a.name, b.name))

  const filled = dedicatedEntries.map((entry) => ({ entry, ...fillDedicated(entry.variants.values()) }))
  const mixedSlots = sum(mixedEntries.flatMap((entry) => [...entry.variants.values()].map(slotsFor)))
  const protectedSlots = sum(filled.flatMap((f) => f.overflow.map(slotsFor)))

  const assigned = assignChests(
    chests,
    { dedicatedNames: dedicatedEntries.map((e) => e.name), mixedSlots, protectedSlots },
    { previous, canDedicate, capacity }
  )

  const dedicated = filled.map(({ entry, discard, overflow }) => ({
    name: entry.name,
    total: entry.total,
    chest: assigned.dedicated.get(entry.name),
    discard,
    protectedOverflow: sum(overflow.map((v) => v.count))
  }))
  const newChests = [...assigned.dedicated.values(), ...assigned.mixed, ...assigned.protected].filter((c) => c === null).length
  // 整理先の単体チェストは、すべて大きなチェストにする
  const expansions = chests.filter((chest) => chest.positions.length === 1).map((chest) => chest.positions)

  return {
    chestCount: chests.length + 1,
    itemKinds: totals.length,
    dedicated,
    mixed: { items: mixedEntries.map(({ name, total }) => ({ name, total })), chests: assigned.mixed },
    protected: { chests: assigned.protected },
    discard: dedicated.filter((d) => d.discard > 0).map((d) => ({ name: d.name, count: d.discard })),
    expansions,
    newChests,
    planks: newChests * PLANKS_PER_NEW_CHEST + expansions.length * PLANKS_PER_EXPANSION
  }
}

module.exports = { buildPlan, LARGE_CHEST_SLOTS }
