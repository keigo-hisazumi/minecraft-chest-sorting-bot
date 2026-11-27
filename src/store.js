// 開いているチェストへ、持っているアイテムを入れる

const { describeItem } = require('./items')
const { sameKind, evictableStacks } = require('./moves')
const { emptyCargoSlots, refresh, moveStack } = require('./window')

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

module.exports = { storeStack }
