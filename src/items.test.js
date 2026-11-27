const test = require('node:test')
const assert = require('node:assert/strict')
const { isProtectedName, describeItem } = require('./items')

test('仕様書の保護対象は、種類だけで保護する', () => {
  const names = [
    'diamond',
    'diamond_sword',
    'diamond_block',
    'netherite_ingot',
    'netherite_scrap',
    'netherite_upgrade_smithing_template',
    'netherite_spear',
    'ancient_debris',
    'coal_ore',
    'deepslate_iron_ore',
    'nether_quartz_ore',
    'iron_ingot',
    'copper_ingot',
    'raw_gold',
    'raw_copper_block',
    'redstone',
    'redstone_block',
    'lapis_lazuli',
    'lapis_block',
    'emerald',
    'emerald_block',
    'quartz',
    'quartz_block',
    'iron_nugget',
    'gold_nugget',
    'copper_nugget',
    'iron_block',
    'gold_block',
    'copper_block',
    'waxed_oxidized_copper',
    'shulker_box',
    'light_blue_shulker_box'
  ]
  for (const name of names) assert.ok(isProtectedName(name), name)
})

test('保護対象でないアイテム', () => {
  const names = [
    'coal',
    'charcoal',
    'coal_block',
    'cobblestone',
    'oak_log',
    'iron_sword',
    'golden_apple',
    'redstone_torch',
    'quartz_stairs',
    'smooth_quartz',
    'cut_copper',
    'copper_door',
    'shulker_shell',
    'redstone_lamp'
  ]
  for (const name of names) assert.ok(!isProtectedName(name), name)
})

function item(name, components = [], extra = {}) {
  return {
    name,
    count: 1,
    stackSize: 64,
    components,
    removedComponents: [],
    componentMap: new Map(components.map((c) => [c.type, c])),
    ...extra
  }
}

test('エンチャントや名前が付いたアイテムは保護する', () => {
  const enchanted = { type: 'enchantments', data: { enchantments: [{ id: 1, level: 1 }] } }
  const stored = { type: 'stored_enchantments', data: { enchantments: [{ id: 1, level: 1 }] } }
  const name = { type: 'custom_name', data: { type: 'string', value: 'x' } }
  assert.ok(describeItem(item('iron_sword', [enchanted])).protected)
  assert.ok(describeItem(item('enchanted_book', [stored])).protected)
  assert.ok(describeItem(item('dirt', [name])).protected)
  // 形式が分からないエンチャントの情報は、捨てないように保護する
  assert.ok(describeItem(item('iron_sword', [{ type: 'enchantments', data: {} }])).protected)
  assert.ok(!describeItem(item('iron_sword', [{ type: 'enchantments', data: { enchantments: [] } }])).protected)
  assert.ok(!describeItem(item('iron_sword', [{ type: 'damage', data: 3 }])).protected)
})

test('同じ枠にまとめられるかは、付加情報で見分ける（並び順は無視する）', () => {
  const a = { type: 'damage', data: 3 }
  const b = { type: 'repair_cost', data: 1 }
  assert.equal(describeItem(item('iron_sword', [a, b])).variant, describeItem(item('iron_sword', [b, a])).variant)
  assert.notEqual(describeItem(item('iron_sword', [a])).variant, describeItem(item('iron_sword')).variant)
})

test('中身のある入れ物は保護する', () => {
  const bundle = { type: 'bundle_contents', data: { contents: [{ itemCount: 1 }] } }
  assert.ok(describeItem(item('bundle', [bundle])).protected)
  assert.ok(describeItem(item('barrel', [{ type: 'container', data: {} }])).protected)
  assert.ok(!describeItem(item('bundle', [{ type: 'bundle_contents', data: { contents: [] } }])).protected)
})

test('最大スタック数の付加情報があれば優先する', () => {
  assert.equal(describeItem(item('stick', [{ type: 'max_stack_size', data: 16 }])).stackSize, 16)
  assert.equal(describeItem(item('stick')).stackSize, 64)
})
