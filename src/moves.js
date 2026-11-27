// アイテムをどこへ移すかの判断
// チェストの中身の写し（枠の番号と、入っているアイテム）だけを使い、操作はしない。

const { overlaps } = require('./chests')

/**
 * 割り当てを、調査できたチェストに結び付ける
 *
 * @param {{ dedicated: object, mixed: Array, protected: Array }} assignments 割り当て
 * @param {Array<{ positions: Array<object> }>} chests 整理先のチェスト（指定チェストは含めない）
 */
function createLayout(assignments, chests) {
  const find = (positions) => (positions ? (chests.find((c) => overlaps(c.positions, positions)) ?? null) : null)
  return {
    dedicated: new Map(Object.entries(assignments.dedicated).map(([name, positions]) => [name, find(positions)])),
    mixed: assignments.mixed.map(find).filter(Boolean),
    protected: assignments.protected.map(find).filter(Boolean)
  }
}

// アイテムを入れてよいチェスト（優先する順）
// 専用にするアイテムは、専用チェストがないか使えない間は、どこへも移さない
function targetsFor(layout, stack) {
  if (!layout.dedicated.has(stack.name)) return layout.mixed
  const dedicated = layout.dedicated.get(stack.name)
  if (!dedicated || dedicated.unavailable) return []
  return [dedicated, ...(stack.protected ? layout.protected : [])]
}

const sameKind = (a, b) => a.name === b.name && a.variant === b.variant

// 空き枠があるか、同じアイテムのスタックに足せるか
function hasRoom(chest, stack) {
  return chest.slots.size < chest.size || [...chest.slots.values()].some((s) => sameKind(s, stack) && s.count < s.stackSize)
}

// チェストに入っているアイテムを、そのままにしてよいか
function isSettled(layout, chest, stack) {
  const targets = targetsFor(layout, stack)
  if (!targets.includes(chest)) return false
  // 保護対象チェストにある分は、専用チェストに空きができたら移す
  const dedicated = layout.dedicated.get(stack.name)
  return !dedicated || dedicated === chest || !hasRoom(dedicated, stack)
}

// よそへ移せば、このチェストに空きを作れるアイテム
function evictableStacks(layout, chest) {
  return [...chest.slots.values()].filter(
    (stack) => !isSettled(layout, chest, stack) && targetsFor(layout, stack).some((t) => t !== chest && !t.unavailable)
  )
}

/**
 * 持っているアイテムを届けるチェストを返す
 *
 * @returns {object | null} 入れられるチェスト。なければ null
 */
function destinationFor(layout, stack, from = null) {
  return (
    targetsFor(layout, stack).find(
      (t) => t !== from && !t.unavailable && (hasRoom(t, stack) || evictableStacks(layout, t).length > 0)
    ) ?? null
  )
}

// チェストから持ち出して、よそへ移すアイテム
function movableStacks(layout, chest) {
  return [...chest.slots.values()].filter((stack) => !isSettled(layout, chest, stack) && destinationFor(layout, stack, chest))
}

module.exports = { createLayout, targetsFor, sameKind, hasRoom, isSettled, evictableStacks, destinationFor, movableStacks }
