// テスト用の簡易な世界。チェストと BOT のインベントリを持ち、左クリックだけを再現する

const { createFakeBot } = require('./fakebot')

const MAIN_SLOTS = 27
const HOTBAR_SLOTS = 9
// BOT のインベントリの画面で、荷物の枠が始まる番号
const INVENTORY_START = 9

// 同じ名前と付加情報のアイテムだけが、同じ枠にまとまる
const sameKind = (a, b) => a.name === b.name && (a.tag ?? '') === (b.tag ?? '')

function toItem({ name, count, stackSize = 64, tag }, slot) {
  const componentMap = new Map(tag ? [[tag, { type: tag, data: 'x' }]] : [])
  return { name, count, stackSize, tag, slot, componentMap, components: [...componentMap.values()], removedComponents: [] }
}

function createFakeWorld() {
  const bot = createFakeBot()
  // 座標ごとの中身。大きなチェストは、2 つの座標が同じ中身を指す
  const containers = new Map()
  const inventory = Array(MAIN_SLOTS + HOTBAR_SLOTS).fill(null)
  const locked = new Set()
  const opened = []

  const key = ({ x, y, z }) => `${x},${y},${z}`

  // 画面。先頭がチェスト、続きが BOT のインベントリ
  function createWindow(slots, size) {
    const read = (i) => (i < size ? slots[i] : inventory[i - size])
    const write = (i, item) => {
      if (i < size) slots[i] = item
      else inventory[i - size] = item
    }
    return {
      inventoryStart: size,
      selectedItem: null,
      slots: new Proxy([], {
        get: (target, property) => {
          const i = Number(property)
          return Number.isInteger(i) && read(i) ? toItem(read(i), i) : null
        }
      }),
      containerItems() {
        return slots.flatMap((item, i) => (item ? [toItem(item, i)] : []))
      },
      firstEmptySlotRange(start, end) {
        for (let i = start; i < end; i++) if (!read(i)) return i
        return null
      },
      close() {
        assertEmptyCursor(this)
        bot.currentWindow = null
      },
      click(i) {
        const cursor = this.selectedItem
        const target = read(i)
        if (!cursor) {
          write(i, null)
          this.selectedItem = target
        } else if (!target) {
          write(i, cursor)
          this.selectedItem = null
        } else if (sameKind(cursor, target)) {
          const moved = Math.min(cursor.count, (target.stackSize ?? 64) - target.count)
          write(i, { ...target, count: target.count + moved })
          this.selectedItem = cursor.count > moved ? { ...cursor, count: cursor.count - moved } : null
        } else {
          write(i, cursor)
          this.selectedItem = target
        }
      }
    }
  }

  function assertEmptyCursor(window) {
    if (window.selectedItem) throw new Error('カーソルにアイテムを持ったまま閉じました')
  }

  Object.defineProperty(bot, 'inventory', {
    get() {
      const window = createWindow([], 0)
      window.slots = new Proxy([], {
        get: (target, property) => {
          const i = Number(property) - INVENTORY_START
          return Number.isInteger(i) && inventory[i] ? toItem(inventory[i], i + INVENTORY_START) : null
        }
      })
      window.inventoryStart = INVENTORY_START
      return window
    }
  })

  bot.openContainer = async (block) => {
    const slots = containers.get(key(block.position))
    if (locked.has(slots)) throw new Error('開けません')
    opened.push(key(block.position))
    bot.currentWindow = createWindow(slots, slots.length)
    return bot.currentWindow
  }
  bot.clickWindow = async (slot) => bot.currentWindow.click(slot)
  bot.waitForTicks = async () => {}

  function add(x, positions, items) {
    const slots = Array(27 * positions).fill(null)
    items.forEach((item, i) => {
      slots[i] = { ...item }
    })
    for (let dx = 0; dx < positions; dx++) containers.set(key({ x: x + dx, y: 64, z: 0 }), slots)
    return slots
  }

  const world = {
    bot,
    inventory,
    opened,
    navigator: { moveTo: async () => ({ status: 'arrived' }) },
    single(x, items = []) {
      bot.putChest(x, 64, 0)
      return add(x, 1, items)
    },
    large(x, items = []) {
      bot.putLargeChest(x, 64, 0)
      return add(x, 2, items)
    },
    lock(slots) {
      locked.add(slots)
    },
    // すべてのチェストと BOT にある、アイテムの種類ごとの個数
    totals() {
      const totals = {}
      const all = [...new Set(containers.values()), inventory]
      for (const item of all.flat()) {
        if (item) totals[`${item.name}:${item.tag ?? ''}`] = (totals[`${item.name}:${item.tag ?? ''}`] ?? 0) + item.count
      }
      return totals
    }
  }
  return world
}

module.exports = { createFakeWorld }
