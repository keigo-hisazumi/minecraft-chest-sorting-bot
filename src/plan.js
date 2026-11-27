// 振り分けの計画
// チェストの中身から、どのアイテムをどのチェストへ入れるかを決める。アイテムは動かさない。

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
 * 整理先のチェストを、専用、混合、保護対象の順に割り当てる
 * 足りない分は null（新しく作る）にする。移す量が少なくなるように、そのアイテムが多いチェストを優先する。
 *
 * @param {Array<{ positions: Array<object>, items: Array<object> }>} chests 整理先のチェスト
 * @param {string[]} dedicatedNames 専用チェストを作るアイテム（優先する順）
 * @param {number} mixedCount 混合チェストの数
 * @param {number} protectedCount 保護対象チェストの数
 */
function assignChests(chests, dedicatedNames, mixedCount, protectedCount) {
  const free = new Set(chests)
  const countOf = (chest, name) => sum(chest.items.filter((i) => i.name === name).map((i) => i.count))
  // 大きなチェストを先に、中身が少ない順に使う
  const byEase = (a, b) => b.positions.length - a.positions.length || a.items.length - b.items.length
  const take = (compare, filter = () => true) => {
    const chosen = [...free].filter(filter).sort(compare)[0] ?? null
    if (chosen) free.delete(chosen)
    return chosen
  }

  const dedicated = new Map(dedicatedNames.map((name) => [name, null]))
  // まず、アイテムがすでに入っているチェストを、入っている数が多い組み合わせから割り当てる
  const holdings = dedicatedNames
    .flatMap((name) => chests.map((chest) => ({ name, chest, count: countOf(chest, name) })))
    .filter((holding) => holding.count > 0)
    .sort((a, b) => b.count - a.count || byEase(a.chest, b.chest))
  for (const { name, chest } of holdings) {
    if (dedicated.get(name) || !free.has(chest)) continue
    dedicated.set(name, chest)
    free.delete(chest)
  }
  for (const name of dedicatedNames) {
    if (!dedicated.get(name)) dedicated.set(name, take(byEase))
  }

  const isDedicated = new Set(dedicatedNames)
  const mixedItems = (chest) => chest.items.filter((i) => !isDedicated.has(i.name)).length
  const mixed = Array.from({ length: mixedCount }, () => take((a, b) => mixedItems(b) - mixedItems(a) || byEase(a, b)))
  const protectedChests = Array.from({ length: protectedCount }, () => take(byEase))

  const positions = (chest) => chest?.positions ?? null
  return {
    dedicated: new Map([...dedicated].map(([name, chest]) => [name, positions(chest)])),
    mixed: mixed.map(positions),
    protected: protectedChests.map(positions)
  }
}

/**
 * 振り分けの計画を作る
 *
 * @param {object} survey
 * @param {{ positions: Array<object>, items: Array<object> }} survey.source 指定チェストの中身
 * @param {Array<{ positions: Array<object>, items: Array<object> }>} survey.chests 整理先のチェストの中身
 * @returns {object} 計画
 */
function buildPlan({ source, chests }) {
  const totals = totalItems([source, ...chests]).sort((a, b) => b.total - a.total || compareText(a.name, b.name))
  const isDedicated = (entry) => entry.total >= THRESHOLD_STACKS * entry.stackSize
  const dedicatedEntries = totals.filter(isDedicated)
  const mixedEntries = totals.filter((entry) => !isDedicated(entry)).sort((a, b) => compareText(a.name, b.name))

  const filled = dedicatedEntries.map((entry) => ({ entry, ...fillDedicated(entry.variants.values()) }))
  const mixedSlots = sum(mixedEntries.flatMap((entry) => [...entry.variants.values()].map(slotsFor)))
  const protectedSlots = sum(filled.flatMap((f) => f.overflow.map(slotsFor)))

  const assigned = assignChests(
    chests,
    dedicatedEntries.map((e) => e.name),
    Math.ceil(mixedSlots / LARGE_CHEST_SLOTS),
    Math.ceil(protectedSlots / LARGE_CHEST_SLOTS)
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
