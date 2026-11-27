// インベントリ操作のテスト（node --test で実行）

const test = require('node:test')
const assert = require('node:assert/strict')
const { hold } = require('./window')

// クリックで、カーソルと枠のアイテムを入れ替えるだけの、インベントリの偽物
function createBot(items) {
  const inventory = { inventoryStart: 9, slots: [], selectedItem: null }
  for (const [slot, name] of Object.entries(items)) inventory.slots[slot] = { name, count: 1, stackSize: 64, type: 1 }
  const bot = {
    inventory,
    quickBarSlot: 0,
    async clickWindow(slot) {
      const held = inventory.selectedItem
      inventory.selectedItem = inventory.slots[slot] ?? null
      inventory.slots[slot] = held ?? undefined
    },
    async waitForTicks() {},
    setQuickBarSlot(slot) {
      bot.quickBarSlot = slot
    }
  }
  return bot
}

test('hold: ホットバーにあれば、その枠を選ぶ', async () => {
  const bot = createBot({ 38: 'wooden_axe' })
  assert.equal(await hold(bot, 'wooden_axe'), true)
  assert.equal(bot.quickBarSlot, 2)
})

test('hold: ホットバーに空きがなくても、選んでいる枠の物と入れ替えて持つ', async () => {
  const hotbar = Object.fromEntries(Array.from({ length: 9 }, (v, i) => [36 + i, 'oak_log']))
  const bot = createBot({ ...hotbar, 20: 'wooden_axe' })
  bot.quickBarSlot = 4
  assert.equal(await hold(bot, 'wooden_axe'), true)
  assert.equal(bot.inventory.slots[40].name, 'wooden_axe')
  assert.equal(bot.quickBarSlot, 4)
  // 入れ替えた原木は、斧があった荷物の枠へ移る
  assert.equal(bot.inventory.slots[20].name, 'oak_log')
})
