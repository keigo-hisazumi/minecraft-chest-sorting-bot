const test = require('node:test')
const assert = require('node:assert/strict')
const { buildPlan } = require('./plan')
const { formatSummary, formatDetail } = require('./planreport')

// 1 枠分のアイテム
const stack = (name, count, { stackSize = 64, variant = '', protected: isProtected = false } = {}) => ({
  name,
  count,
  stackSize,
  variant,
  protected: isProtected
})
const stacks = (name, slots, options = {}) => Array.from({ length: slots }, () => stack(name, options.stackSize ?? 64, options))
const large = (x, items = []) => ({
  positions: [
    { x, y: 64, z: 0 },
    { x: x + 1, y: 64, z: 0 }
  ],
  items
})
const single = (x, items = []) => ({ positions: [{ x, y: 64, z: 0 }], items })
const chestX = (positions) => positions?.[0].x ?? null

test('指定チェストと整理先の合計が 3 スタック以上なら専用、未満なら混合にする', () => {
  const plan = buildPlan({
    source: single(0, [stack('cobblestone', 64), stack('cobblestone', 64), stack('dirt', 64), stack('dirt', 64), stack('dirt', 63)]),
    chests: [large(10, [stack('cobblestone', 64)])]
  })
  assert.deepEqual(
    plan.dedicated.map((d) => [d.name, d.total]),
    [['cobblestone', 192]]
  )
  assert.deepEqual(plan.mixed.items, [{ name: 'dirt', total: 191 }])
})

test('3 スタックは最大スタック数の 3 倍。スタックできないアイテムは 3 個以上', () => {
  const unstackable = (n) => Array.from({ length: n }, () => stack('bucket_like', 1, { stackSize: 1 }))
  const base = { chests: [] }
  const dedicated = (items) => buildPlan({ ...base, source: single(0, items) }).dedicated.length
  assert.equal(dedicated([stack('ender_pearl', 16, { stackSize: 16 }), stack('ender_pearl', 16, { stackSize: 16 }), stack('ender_pearl', 16, { stackSize: 16 })]), 1)
  assert.equal(dedicated([stack('ender_pearl', 47, { stackSize: 16 })]), 0)
  assert.equal(dedicated(unstackable(3)), 1)
  assert.equal(dedicated(unstackable(2)), 0)
})

test('付加情報が違っても、同じ名前は同じアイテムとして数える', () => {
  const swords = ['a', 'b', 'c'].map((variant) => stack('iron_sword', 1, { stackSize: 1, variant }))
  const plan = buildPlan({ source: single(0, swords), chests: [] })
  assert.deepEqual(
    plan.dedicated.map((d) => [d.name, d.total]),
    [['iron_sword', 3]]
  )
})

test('専用チェストは 1 つだけで、入りきらない分は廃棄予定にする', () => {
  const plan = buildPlan({
    source: single(0, [stack('cobblestone', 10)]),
    chests: [large(10, stacks('cobblestone', 54)), large(20, stacks('cobblestone', 54))]
  })
  assert.equal(plan.dedicated.length, 1)
  assert.deepEqual(plan.discard, [{ name: 'cobblestone', count: 54 * 64 + 10 }])
  assert.equal(plan.protected.chests.length, 0)
})

test('保護対象は廃棄せず、入りきらない分を保護対象チェストへ回す', () => {
  const plan = buildPlan({
    source: single(0, [stack('iron_ingot', 10, { protected: true })]),
    chests: [large(10, stacks('iron_ingot', 54, { protected: true })), large(20, stacks('iron_ingot', 54, { protected: true }))]
  })
  assert.deepEqual(plan.discard, [])
  assert.equal(plan.dedicated[0].protectedOverflow, 54 * 64 + 10)
  // 55 枠分になるため、保護対象チェストは 2 つ
  assert.equal(plan.protected.chests.length, 2)
})

test('同じアイテムに保護対象が混ざる場合は、保護対象でないものを先に専用チェストへ入れる', () => {
  const swords = (n, variant, isProtected) =>
    Array.from({ length: n }, () => stack('iron_sword', 1, { stackSize: 1, variant, protected: isProtected }))
  const plan = buildPlan({ source: single(0, [...swords(10, 'enchanted', true), ...swords(50, 'plain', false)]), chests: [] })
  assert.equal(plan.dedicated[0].discard, 0)
  assert.equal(plan.dedicated[0].protectedOverflow, 6)
  assert.equal(plan.protected.chests.length, 1)
})

test('そのアイテムが多いチェストを専用にし、足りないチェストは新しく作る', () => {
  const plan = buildPlan({
    source: single(0, [...stacks('stone', 3), ...stacks('sand', 3), stack('stick', 1)]),
    chests: [large(10, stacks('sand', 1)), large(20, stacks('sand', 5))]
  })
  const byName = Object.fromEntries(plan.dedicated.map((d) => [d.name, chestX(d.chest)]))
  assert.equal(byName.sand, 20)
  assert.equal(byName.stone, 10)
  assert.deepEqual(plan.mixed.chests, [null])
  assert.equal(plan.newChests, 1)
  assert.equal(plan.planks, 16)
})

test('合計が多いアイテムより、そのチェストに多く入っているアイテムを優先する', () => {
  const plan = buildPlan({
    source: single(0, stacks('stone', 20)),
    chests: [large(10, [...stacks('sand', 10), ...stacks('stone', 1)]), large(20)]
  })
  const byName = Object.fromEntries(plan.dedicated.map((d) => [d.name, chestX(d.chest)]))
  assert.deepEqual(byName, { stone: 20, sand: 10 })
})

const positionsAt = (x) => large(x).positions

test('一度専用にしたアイテムは、少なくなっても同じチェストを専用にする', () => {
  const previous = { dedicated: { stone: positionsAt(20), sand: positionsAt(30) }, mixed: [], protected: [] }
  const plan = buildPlan({ source: single(0, [stack('stone', 1)]), chests: [large(10, stacks('stone', 2)), large(20), large(30)] }, { previous })
  assert.deepEqual(
    plan.dedicated.map((d) => [d.name, chestX(d.chest)]),
    [
      ['stone', 20],
      ['sand', 30]
    ]
  )
  assert.deepEqual(plan.mixed.items, [])
})

test('前回の混合チェストを引き継ぐ', () => {
  const previous = { dedicated: {}, mixed: [positionsAt(30)], protected: [] }
  const plan = buildPlan({ source: single(0, [stack('stick', 1)]), chests: [large(10, [stack('torch', 1)]), large(30)] }, { previous })
  assert.deepEqual(plan.mixed.chests.map(chestX), [30])
})

test('専用にできないチェストと、実際の枠の数を指定できる', () => {
  const options = { canDedicate: (c) => c.positions.length === 2, capacity: (c) => 27 * c.positions.length }
  const items = [...stacks('stone', 3), ...Array.from({ length: 40 }, (v, i) => stack(`item${i}`, 1))]
  const plan = buildPlan({ source: single(0, items), chests: [single(10, stacks('stone', 5)), single(20)] }, options)
  assert.equal(plan.dedicated[0].chest, null)
  // 40 枠は、単体チェスト 2 つ（54 枠）に入る
  assert.deepEqual(plan.mixed.chests.map(chestX).sort(), [10, 20])
})

test('整理先の単体チェストは大きなチェストに広げる。指定チェストは広げない', () => {
  const plan = buildPlan({ source: single(0, stacks('stone', 3)), chests: [single(10), large(20)] })
  assert.deepEqual(plan.expansions, [[{ x: 10, y: 64, z: 0 }]])
  // 大きなチェストを先に使う
  assert.equal(chestX(plan.dedicated[0].chest), 20)
  assert.equal(plan.newChests, 0)
  assert.equal(plan.planks, 8)
})

test('同じチェストを 2 つの用途に割り当てない', () => {
  const plan = buildPlan({
    source: single(0, [...stacks('stone', 3), ...stacks('sand', 3), stack('stick', 1), ...stacks('iron_ingot', 60, { protected: true })]),
    chests: [large(10), large(20), large(30), large(40)]
  })
  const used = [...plan.dedicated.map((d) => d.chest), ...plan.mixed.chests, ...plan.protected.chests].map(chestX)
  assert.equal(used.length, 5)
  assert.equal(new Set(used.filter((x) => x !== null)).size, 4)
  assert.equal(plan.newChests, 1)
})

test('アイテムがなければ、何も作らない', () => {
  const plan = buildPlan({ source: single(0), chests: [] })
  assert.equal(plan.newChests + plan.mixed.chests.length + plan.protected.chests.length + plan.planks, 0)
  assert.match(formatSummary(plan, []).join('\n'), /廃棄予定: なし/)
})

test('要約は短くまとめ、詳細にはすべて書く', () => {
  const names = ['a', 'b', 'c', 'd', 'e']
  const plan = buildPlan({ source: single(0, names.flatMap((n) => stacks(n, 60))), chests: [] })
  const failed = names.map((n, x) => ({ positions: [{ x, y: 1, z: 2 }], reason: '開けません' }))
  const summary = formatSummary(plan, failed)
  assert.equal(summary.length, 6)
  assert.ok(summary.every((line) => line.length <= 256))
  assert.match(summary[3], /廃棄予定: a 384 個、b 384 個、c 384 個 ほか 2 件/)
  assert.match(formatDetail(plan, failed), /e: 384 個/)
  assert.match(formatDetail(plan, failed), /\(4, 1, 2\): 開けません/)
})
