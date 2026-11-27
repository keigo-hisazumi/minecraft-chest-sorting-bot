const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { discardOverflow } = require('./discard')
const { sortOnce } = require('./sorter')
const { emptyAssignments } = require('./state')
const { createFakeWorld } = require('./fakeworld')

const CUBE = [[0, 0, 0, 1, 1, 1]]
const CACTUS = new Vec3(0, 64, 10)
const at = (x, count = 1) => Array.from({ length: count }, (v, i) => ({ x: x + i, y: 64, z: 0 }))
const stacks = (name, n, extra = {}) => Array.from({ length: n }, () => ({ name, count: extra.stackSize ?? 64, ...extra }))
const countOf = (slots, name, tag) =>
  slots.filter((i) => i?.name === name && i.tag === tag).reduce((total, i) => total + i.count, 0)

// 床とサボテンのある世界。投げたアイテムは、outcome で決めた結果になる
function setup(t, sourceItems, { cactus = true, outcome = () => 'destroyed' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortbot-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const logFile = path.join(dir, 'data', 'discard.log')
  const world = createFakeWorld()
  const { bot } = world
  bot.entities = {}
  if (cactus) {
    bot.registry.blocksByName.cactus = { id: 2 }
    const findChests = bot.findBlocks
    bot.findBlocks = (options) => (options.matching === 2 ? [CACTUS] : findChests(options))
    const blockAt = bot.blockAt
    bot.blockAt = (position) => {
      if (position.x === CACTUS.x && position.z === CACTUS.z && position.y === 64) return { name: 'cactus', position }
      if (position.y === 63) return { name: 'stone', boundingBox: 'block', shapes: CUBE, position }
      return blockAt(position)
    }
  }
  const tossed = []
  const toss = async (context, site, slot) => {
    const item = world.inventory[slot - 9]
    const result = outcome(item, tossed.length)
    tossed.push({ ...item, result })
    // 残る場合も、テストでは持ち物からなくなる（地面に落ちた扱い）
    if (result !== 'unreachable') world.inventory[slot - 9] = null
    return result
  }
  const source = world.single(0, sourceItems)
  let assignments = emptyAssignments()
  const notices = []
  const sort = (options = {}) =>
    sortOnce({
      bot,
      navigator: world.navigator,
      world: { source: { positions: at(0) }, excluded: [], assignments },
      saveAssignments: (saved) => {
        assignments = saved
      },
      notify: (message) => notices.push(message),
      signal: new AbortController().signal,
      build: async () => ({ changed: false, expanded: 0, created: 0, tablePlaced: false, problems: [] }),
      discardLog: logFile,
      discard: (context, options) => discardOverflow(context, { ...options, toss }),
      ...options
    })
  const lines = () =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [time, result, name, count] = line.split('\t')
            assert.ok(!Number.isNaN(Date.parse(time)), time)
            return { result, name, count: Number(count) }
          })
      : []
  // 投げた結果の記録。投げる前の記録と同じ数だけある
  const log = () => {
    const all = lines()
    const results = all.filter((entry) => entry.result !== '投てき開始')
    assert.equal(all.length, results.length * 2)
    return results
  }
  return { world, source, sort, tossed, log, notices }
}

test('専用チェストに入りきらない分を廃棄し、アイテム名と個数を記録する', async (t) => {
  const { world, source, sort, log, notices } = setup(t, stacks('stone', 3))
  const dedicated = world.large(5, stacks('stone', 54))
  const result = await sort()
  assert.deepEqual(result.discard.discarded, { stone: 192 })
  assert.equal(result.discard.problem, null)
  assert.equal(countOf(dedicated, 'stone'), 54 * 64)
  assert.equal(countOf(source, 'stone'), 0)
  assert.equal(countOf(world.inventory, 'stone'), 0)
  assert.deepEqual(
    log(),
    Array.from({ length: 3 }, () => ({ result: '廃棄', name: 'stone', count: 64 }))
  )
  assert.deepEqual(notices.filter((n) => n.startsWith('廃棄')), ['廃棄します: stone 192 個'])
})

test('整理先にもともとある分も、専用チェストに入りきらなければ廃棄する', async (t) => {
  const { world, sort } = setup(t, [])
  world.large(5, stacks('stone', 54))
  const other = world.large(10, stacks('stone', 4))
  const result = await sort()
  assert.deepEqual(result.discard.discarded, { stone: 256 })
  assert.equal(countOf(other, 'stone'), 0)
})

test('専用チェストに空きや足せるスタックがあれば、捨てずに入れる', async (t) => {
  const { world, sort, tossed } = setup(t, [
    { name: 'stone', count: 40 },
    { name: 'stone', count: 50 }
  ])
  const dedicated = world.large(5, [...stacks('stone', 52), { name: 'stone', count: 30 }])
  await sort()
  assert.equal(tossed.length, 0)
  assert.equal(countOf(dedicated, 'stone'), 52 * 64 + 30 + 90)
})

test('保護対象は廃棄しない', async (t) => {
  const { world, source, sort, tossed } = setup(t, [
    ...stacks('iron_ingot', 3),
    { name: 'stone', count: 5, tag: 'custom_name' },
    { name: 'stone', count: 7, tag: 'enchantments' }
  ])
  world.large(5, stacks('iron_ingot', 54))
  world.large(10, stacks('stone', 54))
  // 保護対象チェストにする場所がないため、指定チェストに残る
  const result = await sort()
  assert.equal(tossed.length, 0)
  assert.equal(countOf(source, 'iron_ingot'), 192)
  assert.equal(countOf(source, 'stone', 'custom_name'), 5)
  assert.equal(countOf(source, 'stone', 'enchantments'), 7)
  assert.deepEqual(result.discard.discarded, {})
})

test('専用チェストの保護対象は保護対象チェストへ移し、空いた分に入れて捨てる量を減らす', async (t) => {
  const sword = (tag) => ({ name: 'iron_sword', count: 1, stackSize: 1, ...(tag && { tag }) })
  const { world, sort, tossed } = setup(t, Array.from({ length: 5 }, () => sword()))
  const dedicated = world.large(5, [
    ...Array.from({ length: 10 }, () => sword('custom_name')),
    ...Array.from({ length: 44 }, () => sword())
  ])
  const guarded = world.large(10)
  await sort()
  assert.equal(tossed.length, 0)
  assert.equal(countOf(dedicated, 'iron_sword') , 49)
  assert.equal(countOf(guarded, 'iron_sword', 'custom_name') + countOf(dedicated, 'iron_sword', 'custom_name'), 10)
})

test('専用チェストがないアイテムと、混合チェストのアイテムは廃棄しない', async (t) => {
  const { world, source, sort, tossed } = setup(t, [...stacks('stone', 3), { name: 'stick', count: 1 }])
  world.single(5, Array.from({ length: 27 }, (v, i) => ({ name: `filler${i}`, count: 1 })))
  await sort()
  assert.equal(tossed.length, 0)
  assert.equal(countOf(source, 'stone'), 192)
})

test('サボテンがなければ廃棄せず、指定チェストに残して知らせる', async (t) => {
  const { world, source, sort, tossed, log } = setup(t, stacks('stone', 3), { cactus: false })
  world.large(5, stacks('stone', 54))
  const result = await sort()
  assert.equal(tossed.length, 0)
  assert.match(result.discard.problem, /サボテンがない/)
  assert.equal(result.discard.remaining, 192)
  assert.equal(countOf(source, 'stone'), 192)
  assert.deepEqual(log(), [])
})

test('記録先がないか、記録を書けなければ廃棄しない', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { world, sort, tossed } = setup(t, stacks('stone', 3))
  world.large(5, stacks('stone', 54))
  await sort({ discardLog: undefined })
  // フォルダーを記録先にすると書けない
  const result = await sort({ discardLog: os.tmpdir() })
  assert.equal(tossed.length, 0)
  assert.match(result.discard.problem, /記録を書けない/)
})

test('消えたことを確認できなければ、廃棄と記録せず、3 回でやめる', async (t) => {
  const { world, source, sort, tossed, log } = setup(t, stacks('stone', 8), { outcome: () => 'unconfirmed' })
  world.large(5, stacks('stone', 54))
  const result = await sort()
  assert.equal(tossed.length, 3)
  assert.match(result.discard.problem, /3 回続けて/)
  assert.deepEqual(result.discard.discarded, {})
  assert.ok(log().every((entry) => entry.result === '未確認'))
  assert.equal(countOf(source, 'stone'), 5 * 64)
})

test('サボテンへ行けなければ、投げずに残す', async (t) => {
  const { world, source, sort, log } = setup(t, stacks('stone', 3), { outcome: () => 'unreachable' })
  world.large(5, stacks('stone', 54))
  const result = await sort()
  assert.match(result.discard.problem, /近くへ行けません/)
  assert.equal(countOf(source, 'stone'), 192)
  assert.deepEqual(log(), [{ result: '投てきせず', name: 'stone', count: 64 }])
})

test('投げる途中で中止しても、投げた分は記録に残る', async (t) => {
  const abort = new AbortController()
  const { world, sort, log } = setup(t, stacks('stone', 3), {
    outcome: () => {
      abort.abort()
      return 'destroyed'
    }
  })
  world.large(5, stacks('stone', 54))
  await assert.rejects(sort({ signal: abort.signal }), { name: 'AbortError' })
  assert.deepEqual(log(), [{ result: '廃棄', name: 'stone', count: 64 }])
})

// 乱数で作った多くの状況で、保護対象が減らないことと、記録が減った数に一致することを確かめる
test('さまざまな中身でも、保護対象は減らず、記録と廃棄した数が一致する', async (t) => {
  let seed = 7
  const random = (n) => {
    seed = (seed * 48271) % 2147483647
    return seed % n
  }
  const kinds = [
    { name: 'stone' },
    { name: 'sand' },
    { name: 'iron_ingot' },
    { name: 'ender_pearl', stackSize: 16 },
    { name: 'stick' },
    { name: 'iron_sword', stackSize: 1 },
    { name: 'iron_sword', stackSize: 1, tag: 'custom_name' },
    { name: 'stone', tag: 'enchantments' }
  ]
  const isProtected = (key) => key.startsWith('iron_ingot:') || !key.endsWith(':')
  const contents = (slots, bias) =>
    Array.from({ length: random(slots + 1) }, () => {
      const kind = random(2) === 0 ? kinds[bias] : kinds[random(kinds.length)]
      return { ...kind, count: kind.stackSize ?? 64 }
    })
  let discardedTotal = 0
  for (let round = 0; round < 40; round++) {
    const bias = random(kinds.length)
    const { world, sort, log } = setup(t, contents(27, bias))
    const chests = 2 + random(5)
    for (let i = 0; i < chests; i++) world.large(3 + i * 3, contents(54, bias))
    const before = world.totals()
    await sort()
    await sort()
    await sort()
    const after = world.totals()
    const lost = {}
    for (const [key, count] of Object.entries(before)) {
      const difference = count - (after[key] ?? 0)
      assert.ok(difference >= 0, `round ${round} ${key} が増えています`)
      if (difference > 0) {
        assert.ok(!isProtected(key), `round ${round} 保護対象 ${key} が ${difference} 個減っています`)
        lost[key.slice(0, -1)] = difference
      }
    }
    const logged = {}
    for (const entry of log().filter((e) => e.result === '廃棄')) logged[entry.name] = (logged[entry.name] ?? 0) + entry.count
    assert.deepEqual(logged, lost, `round ${round}`)
    discardedTotal += Object.values(lost).reduce((a, b) => a + b, 0)
  }
  // 廃棄が起きる状況を含んでいること
  assert.ok(discardedTotal > 0)
})
