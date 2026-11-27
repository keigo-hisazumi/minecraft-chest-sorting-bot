const test = require('node:test')
const assert = require('node:assert/strict')
const { sortOnce, readSourceSignature } = require('./sorter')
const { emptyAssignments } = require('./state')
const { createFakeWorld } = require('./fakeworld')

const at = (x, count = 1) => Array.from({ length: count }, (v, i) => ({ x: x + i, y: 64, z: 0 }))
const stacks = (name, n, extra = {}) => Array.from({ length: n }, () => ({ name, count: extra.stackSize ?? 64, ...extra }))
const names = (slots) => [...new Set(slots.filter(Boolean).map((i) => i.name))].sort()
const countOf = (slots, name) => slots.filter((i) => i?.name === name).reduce((total, i) => total + i.count, 0)

function setup(sourceItems) {
  const world = createFakeWorld()
  const source = world.single(0, sourceItems)
  let assignments = emptyAssignments()
  const sort = async (options = {}) => {
    const before = world.totals()
    const result = await sortOnce({
      bot: world.bot,
      navigator: world.navigator,
      world: { source: { positions: at(0) }, excluded: [], assignments },
      saveAssignments: (saved) => {
        assignments = saved
      },
      signal: new AbortController().signal,
      ...options
    })
    // どの場合も、移動の前後でアイテムの総数は変わらない
    assert.deepEqual(world.totals(), before)
    return result
  }
  return { world, source, sort, assignments: () => assignments }
}

test('指定チェストのアイテムを、専用チェストと混合チェストに分けて移す', async () => {
  const { world, source, sort, assignments } = setup([...stacks('stone', 4), { name: 'stick', count: 5 }, { name: 'torch', count: 7 }])
  const a = world.large(5)
  const b = world.large(10)
  const result = await sort()
  assert.deepEqual(names(source), [])
  assert.deepEqual(names(a), ['stone'])
  assert.deepEqual(names(b), ['stick', 'torch'])
  assert.equal(result.delivered, 4 * 64 + 12)
  assert.equal(result.carried, 0)
  assert.deepEqual(assignments(), { dedicated: { stone: at(5, 2) }, mixed: [at(10, 2)], protected: [] })
})

test('整理先どうしの中身が入れ違っていても、BOT のインベントリだけで入れ替える', async () => {
  const { world, sort } = setup([])
  // どちらも空き枠がない
  const a = world.large(5, [...stacks('stone', 40), ...stacks('sand', 14)])
  const b = world.large(10, [...stacks('sand', 40), ...stacks('stone', 14)])
  const result = await sort()
  assert.deepEqual(names(a), ['stone'])
  assert.deepEqual(names(b), ['sand'])
  assert.equal(result.misplaced, 0)
  assert.equal(result.carried, 0)
})

test('中途半端なスタックは、同じアイテムの枠にまとめる', async () => {
  const { world, source, sort } = setup([{ name: 'stone', count: 30 }])
  const dedicated = world.large(5, [...stacks('stone', 3), { name: 'stone', count: 50 }])
  await sort()
  assert.deepEqual(names(source), [])
  assert.equal(countOf(dedicated, 'stone'), 3 * 64 + 80)
  assert.equal(dedicated.filter(Boolean).length, 5)
})

test('専用チェストに入りきらない分は、捨てずに指定チェストに残す', async () => {
  const { world, source, sort } = setup(stacks('stone', 5))
  const dedicated = world.large(5, stacks('stone', 52))
  const result = await sort()
  assert.equal(countOf(dedicated, 'stone'), 54 * 64)
  assert.equal(countOf(source, 'stone'), 3 * 64)
  assert.equal(result.sourceItems, 3 * 64)
  assert.equal(result.carried, 0)
})

test('保護対象は、専用チェストからあふれる分を保護対象チェストへ移す', async () => {
  const { world, source, sort } = setup(stacks('iron_ingot', 5))
  const dedicated = world.large(5, stacks('iron_ingot', 52))
  const overflow = world.large(10)
  await sort()
  assert.equal(countOf(dedicated, 'iron_ingot'), 54 * 64)
  assert.equal(countOf(overflow, 'iron_ingot'), 3 * 64)
  assert.deepEqual(names(source), [])
})

test('付加情報が違うアイテムは、別の枠に入れる', async () => {
  const { world, sort } = setup([{ name: 'stone', count: 10, tag: 'custom_name' }, ...stacks('stone', 3)])
  const dedicated = world.large(5, [{ name: 'stone', count: 20 }])
  await sort()
  assert.equal(dedicated.filter((i) => i?.tag === 'custom_name').length, 1)
  assert.equal(countOf(dedicated, 'stone'), 3 * 64 + 30)
})

test('専用にする大きなチェストがなければ、混合チェストに入れずに残して知らせる', async () => {
  const { world, source, sort, assignments } = setup([...stacks('stone', 3), { name: 'stick', count: 1 }])
  const small = world.single(5)
  const result = await sort()
  assert.deepEqual(result.shortage, ['stone'])
  assert.equal(countOf(source, 'stone'), 192)
  assert.deepEqual(names(small), ['stick'])
  // チェストがないアイテムは、専用にするアイテムとして保存しない
  assert.deepEqual(assignments().dedicated, {})
})

test('混合チェストのアイテムが 3 スタック以上になれば、専用チェストへ移す', async () => {
  const { world, source, sort } = setup([
    { name: 'stick', count: 10 },
    { name: 'torch', count: 1 }
  ])
  const a = world.large(5)
  const b = world.large(10)
  await sort()
  const mixed = a.some(Boolean) ? a : b
  stacks('stick', 3).forEach((item, i) => {
    source[i] = item
  })
  await sort()
  assert.deepEqual(names(mixed), ['torch'])
  assert.equal(countOf(mixed === a ? b : a, 'stick'), 202)
})

test('開けないチェストは使わずに、残りを整理する', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { world, source, sort } = setup([...stacks('stone', 3), ...stacks('sand', 3)])
  const stone = world.large(5, stacks('stone', 1))
  const sand = world.large(10, stacks('sand', 1))
  const open = world.bot.openContainer
  let sandOpened = 0
  // 調査のときは開けて、移すときに開けなくなる
  world.bot.openContainer = async (block) => {
    if (block.position.x >= 10 && ++sandOpened > 1) throw new Error('開けません')
    return open(block)
  }
  const result = await sort()
  assert.equal(countOf(stone, 'stone'), 256)
  assert.equal(countOf(sand, 'sand'), 64)
  assert.equal(countOf(source, 'sand'), 192)
  assert.equal(result.failed.length, 1)
})

test('指定チェストに入らない荷物は、BOT が持ち続けて知らせる', async () => {
  const { world, sort } = setup(Array.from({ length: 27 }, (v, i) => ({ name: `filler${i}`, count: 1 })))
  world.inventory[0] = { name: 'stick', count: 3 }
  const result = await sort()
  assert.equal(result.carried, 3)
})

test('ホットバーのアイテムは動かさない', async () => {
  const { world, sort } = setup([{ name: 'stick', count: 1 }])
  world.large(5)
  world.inventory[27] = { name: 'bread', count: 8 }
  await sort()
  assert.deepEqual(world.inventory[27], { name: 'bread', count: 8 })
})

test('途中で中止しても、アイテムの総数は変わらない', async () => {
  const { world, sort } = setup(stacks('stone', 20))
  world.large(5)
  const abort = new AbortController()
  let clicks = 0
  const click = world.bot.clickWindow
  world.bot.clickWindow = async (slot) => {
    if (++clicks === 9) abort.abort()
    return click(slot)
  }
  const before = world.totals()
  await assert.rejects(sort({ signal: abort.signal }), { name: 'AbortError' })
  assert.deepEqual(world.totals(), before)
})

test('指定チェストの中身が変わると、比べる値も変わる', async () => {
  const { world, source } = setup([{ name: 'stick', count: 1 }])
  const read = () =>
    readSourceSignature({
      bot: world.bot,
      navigator: world.navigator,
      world: { source: { positions: at(0) } },
      signal: new AbortController().signal
    })
  const before = await read()
  assert.equal(await read(), before)
  source[3] = { name: 'torch', count: 1 }
  assert.notEqual(await read(), before)
})

// 乱数で作った多くの状況で、総数が変わらず、整理が終わることを確かめる
test('さまざまな中身でも、総数を保って整理を終える', async () => {
  let seed = 1
  const random = (n) => {
    seed = (seed * 48271) % 2147483647
    return seed % n
  }
  const kinds = [
    { name: 'stone' },
    { name: 'sand' },
    { name: 'dirt' },
    { name: 'iron_ingot' },
    { name: 'ender_pearl', stackSize: 16 },
    { name: 'stick' },
    { name: 'iron_sword', stackSize: 1 },
    { name: 'iron_sword', stackSize: 1, tag: 'custom_name' }
  ]
  const contents = (slots) =>
    Array.from({ length: random(slots + 1) }, () => {
      const kind = kinds[random(kinds.length)]
      return { ...kind, count: 1 + random(kind.stackSize ?? 64) }
    })
  for (let round = 0; round < 60; round++) {
    const { world, sort } = setup(contents(27))
    const chests = 1 + random(6)
    for (let i = 0; i < chests; i++) {
      if (random(3) === 0) world.single(3 + i * 3, contents(27))
      else world.large(3 + i * 3, contents(54))
    }
    await sort()
    // 2 回目で移すものが残っていても、繰り返せば落ち着く
    await sort()
    const settled = await sort()
    assert.equal((await sort()).signature, settled.signature, `round ${round}`)
    assert.equal((await sort()).delivered, 0, `round ${round}`)
  }
})
