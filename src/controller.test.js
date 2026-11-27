const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { SortController } = require('./controller')
const { parseCommand } = require('./commands')
const { StateStore } = require('./state')
const { createFakeBot } = require('./fakebot')

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortbot-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const bot = createFakeBot()
  // 再起動に相当する操作（ファイルを読み込み直して作り直す）
  // 移動は呼び出しの記録だけにする
  const moves = []
  const navigator = {
    come: async (username) => moves.push(`come ${username}`),
    cancel: () => moves.push('cancel')
  }
  const boot = () => new SortController(bot, new StateStore(file), 'localhost:25565', { navigator, report: () => {} })
  const controller = boot()
  const run = (text, target = controller) => target.execute(parseCommand(text), 'Tester').join('\n')
  const state = () => controller.store.get(controller.worldKey)
  return { bot, boot, controller, moves, run, state }
}

test('呼び寄せは発言したプレイヤーへの移動を始め、停止で中止する', (t) => {
  const { moves, run } = setup(t)
  run('sort come')
  run('sort stop')
  assert.deepEqual(moves, ['come Tester', 'cancel'])
})

test('現在地を、ブロックの座標で答える', (t) => {
  const { bot, run } = setup(t)
  bot.entity.position = new Vec3(-3.5, 64.9, 10.2)
  assert.equal(run('sort pos'), '現在地: -4 64 10')
})

test('再起動後も、指定チェスト・除外・開始の状態が残る', (t) => {
  const { bot, boot, run, controller } = setup(t)
  bot.putChest(2, 64, 0)
  bot.putChest(5, 64, 0)
  run('sort chest 2 64 0')
  run('sort exclude 5 64 0')
  run('sort start')

  const restarted = boot()
  assert.deepEqual(restarted.store.get(restarted.worldKey), controller.store.get(controller.worldKey))
  const status = run('sort status', restarted)
  assert.match(status, /状態: 開始/)
  assert.match(status, /指定チェスト: 2 64 0/)
  assert.match(status, /除外したチェスト: 5 64 0/)
})

test('指定チェストは 1 つだけで、指定し直すと上書きする', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  bot.putChest(5, 64, 0)
  run('sort chest 2 64 0')
  run('sort chest 5 64 0')
  assert.deepEqual(state().source, { positions: [{ x: 5, y: 64, z: 0 }], auto: false })
})

test('大きなチェストは、どちらの座標でも 1 つのチェストとして登録する', (t) => {
  const { bot, run, state } = setup(t)
  bot.putLargeChest(2, 64, 0)
  run('sort chest 3 64 0')
  assert.deepEqual(state().source.positions, [
    { x: 2, y: 64, z: 0 },
    { x: 3, y: 64, z: 0 }
  ])
  assert.match(run('sort exclude 2 64 0'), /指定チェストは除外できません/)
  assert.equal(state().excluded.length, 0)
})

test('通常のチェストがない座標と、読み込まれていない座標は登録しない', (t) => {
  const { bot, run, state } = setup(t)
  bot.put('trapped_chest', 2, 64, 0)
  bot.unload(500, 64, 0)
  assert.match(run('sort chest 2 64 0'), /通常のチェストがありません/)
  assert.match(run('sort exclude 3 64 0'), /通常のチェストがありません/)
  assert.match(run('sort chest 500 64 0'), /読み込まれていない/)
  assert.equal(state().source, null)
  assert.equal(state().excluded.length, 0)
})

test('除外したチェストは指定できない。大きなチェストへ広げても除外は続く', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  run('sort exclude 2 64 0')
  bot.putLargeChest(2, 64, 0)
  assert.match(run('sort chest 3 64 0'), /除外したチェストは指定チェストにできません/)
  run('sort exclude 3 64 0')
  assert.deepEqual(state().excluded, [
    [
      { x: 2, y: 64, z: 0 },
      { x: 3, y: 64, z: 0 }
    ]
  ])
})

test('指定がなければ一番近いチェストを登録し、次の開始の指示を待つ', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  bot.putChest(5, 64, 0)
  run('sort exclude 2 64 0')
  assert.match(run('sort start'), /自動で登録しました: 5 64 0/)
  assert.deepEqual(state().source, { positions: [{ x: 5, y: 64, z: 0 }], auto: true })
  assert.equal(state().running, false)
  run('sort start')
  assert.equal(state().running, true)
  run('sort stop')
  assert.equal(state().running, false)
})

test('付近にチェストがなければ通知して停止する', (t) => {
  const { run, state } = setup(t)
  assert.match(run('sort start'), /付近にチェストがないため、停止します/)
  assert.equal(state().source, null)
  assert.equal(state().running, false)
})

test('指定チェストが壊されていれば開始しない', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  run('sort start')
  bot.remove(2, 64, 0)
  assert.match(run('sort start'), /見つかりません/)
  assert.equal(state().running, false)
})

test('登録はディメンションごとに分ける', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  bot.game.dimension = 'the_nether'
  assert.equal(state().source, null)
})
