const test = require('node:test')
const assert = require('node:assert/strict')
const { surveyChests } = require('./survey')
const { createFakeBot } = require('./fakebot')

// 中身を持つチェストを開ける BOT と、必ず到着する移動を用意する
function setup() {
  const bot = createFakeBot()
  const contents = new Map()
  const opened = []
  let closed = 0
  bot.openContainer = async (block) => {
    const { x } = block.position
    opened.push(x)
    return {
      containerItems: () => contents.get(x) ?? [],
      close: () => closed++
    }
  }
  const navigator = { moveTo: async () => ({ status: 'arrived' }) }
  const put = (x, items = []) => {
    bot.putChest(x, 64, 0)
    contents.set(
      x,
      items.map(([name, count]) => ({ name, count, stackSize: 64 }))
    )
  }
  const run = (options = {}) =>
    surveyChests({ bot, navigator, source: [{ x: 0, y: 64, z: 0 }], excluded: [], signal: new AbortController().signal, ...options })
  return { bot, navigator, opened, put, run, closed: () => closed }
}

test('指定チェストを最初に読み、近い順に整理先を読んで閉じる', async () => {
  const { opened, put, run, closed } = setup()
  put(0, [['stone', 5]])
  put(9)
  put(3, [['dirt', 2]])
  const result = await run()
  assert.deepEqual(opened, [0, 3, 9])
  assert.equal(closed(), 3)
  assert.deepEqual(
    result.source.items.map((i) => [i.name, i.count]),
    [['stone', 5]]
  )
  assert.equal(result.chests.length, 2)
  assert.deepEqual(result.failed, [])
})

test('除外したチェストと範囲外のチェストは開かない', async () => {
  const { opened, put, run } = setup()
  put(0)
  put(3)
  put(5)
  put(40)
  await run({ excluded: [[{ x: 3, y: 64, z: 0 }]] })
  assert.deepEqual(opened, [0, 5])
})

test('開けないチェストと行けないチェストは、理由を付けて残りを続ける', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { bot, navigator, put, run } = setup()
  put(0)
  put(3)
  put(5)
  put(7)
  const open = bot.openContainer
  bot.openContainer = async (block) => {
    if (block.position.x === 3) throw new Error('windowOpen の待ち時間切れ')
    return open(block)
  }
  navigator.moveTo = async (goal) => ({ status: goal.pos.x === 5 ? 'failed' : 'arrived' })
  const result = await run()
  assert.deepEqual(
    result.failed.map((f) => [f.positions[0].x, f.reason]),
    [
      [3, '開けません'],
      [5, '到達できません']
    ]
  )
  assert.equal(result.chests.length, 1)
})

test('指定チェストを読めなければ失敗する', async () => {
  const { navigator, put, run, opened } = setup()
  put(3)
  await assert.rejects(run(), /指定チェスト.*チェストがありません/)
  put(0)
  navigator.moveTo = async () => ({ status: 'failed' })
  await assert.rejects(run(), /指定チェスト.*到達できません/)
  assert.deepEqual(opened, [])
})

test('中止の合図があれば、開いたチェストを閉じて終える', async () => {
  const { bot, put, run, closed, opened } = setup()
  put(0)
  put(3)
  const abort = new AbortController()
  const open = bot.openContainer
  bot.openContainer = async (block) => {
    const window = await open(block)
    abort.abort()
    return window
  }
  await assert.rejects(run({ signal: abort.signal }), { name: 'AbortError' })
  assert.deepEqual(opened, [0])
  assert.equal(closed(), 1)
})
