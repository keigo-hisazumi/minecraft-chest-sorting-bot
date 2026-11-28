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
  // 調査は、テストから終わらせられるようにする
  const surveys = []
  const survey = (options) =>
    new Promise((resolve, reject) => {
      surveys.push({ options, resolve, reject })
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const reports = []
  const planFile = path.join(dir, 'data', 'plan.txt')
  // 整理は呼び出しを記録するだけにして、結果と指定チェストの中身はテストから変えられるようにする
  const sorting = { runs: [], signature: 'a', result: {}, error: null }
  const sorter = {
    sortOnce: async (options) => {
      sorting.runs.push(options)
      if (sorting.error) throw sorting.error
      return {
        delivered: 0,
        shortage: [],
        missingChests: 0,
        sourceItems: 0,
        carried: 0,
        misplaced: 0,
        failed: [],
        signature: sorting.signature,
        ...sorting.result
      }
    },
    readSourceSignature: async () => sorting.signature
  }
  const controllers = []
  // 伐採は呼び出しを記録し、指定した本数を切ったことにする
  const fells = []
  const feller = async (context, count) => {
    fells.push({ context, count })
    // 本数を指定しなければ、2 本切ったところで切れる木がなくなったことにする
    const trees = count === Infinity ? 2 : count
    return { trees, logs: trees * 4, exhausted: count === Infinity, barehanded: false }
  }
  const boot = () => {
    const created = new SortController(bot, new StateStore(file), 'localhost:25565', {
      navigator,
      report: (m) => reports.push(m),
      planFile,
      survey,
      sorter,
      feller,
      pollInterval: 5
    })
    controllers.push(created)
    return created
  }
  t.after(() => controllers.forEach((c) => c.dispose()))
  const controller = boot()
  const run = (text, target = controller) => target.execute(parseCommand(text), 'Tester').join('\n')
  const state = () => controller.store.get(controller.worldKey)
  // 停止して、実行中の作業が終わるまで待つ
  const stop = async () => {
    const done = controller.task?.done
    run('sort stop')
    await done
  }
  return { bot, boot, controller, moves, run, state, stop, surveys, reports, planFile, sorting, fells }
}

async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('待ち時間切れ')
}

const surveyResult = { source: { positions: [{ x: 2, y: 64, z: 0 }], items: [] }, chests: [], failed: [] }

test('指定チェストがなければ調査しない', (t) => {
  const { run, surveys } = setup(t)
  assert.match(run('sort plan'), /指定チェストがありません/)
  assert.equal(surveys.length, 0)
})

test('調査が終わると、要約を知らせて詳しい計画を保存する', async (t) => {
  const { bot, controller, run, surveys, reports, planFile } = setup(t)
  t.mock.method(console, 'log', () => {})
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  assert.match(run('sort plan'), /調査します: 周りのチェスト/)
  assert.deepEqual(surveys[0].options.source, [{ x: 2, y: 64, z: 0 }])
  const { done } = controller.task
  surveys[0].resolve(surveyResult)
  await done
  assert.match(reports[0], /調査しました: チェスト 1 個/)
  assert.match(fs.readFileSync(planFile, 'utf8'), /\[廃棄予定\]/)
  assert.equal(controller.task, null)
})

test('調査中は登録の変更や移動を受け付けず、停止で中止できる', async (t) => {
  const { bot, controller, run, surveys, reports, state } = setup(t)
  bot.putChest(2, 64, 0)
  bot.putChest(5, 64, 0)
  run('sort chest 2 64 0')
  run('sort plan')
  for (const text of ['sort start', 'sort plan', 'sort chest 5 64 0', 'sort exclude 5 64 0', 'sort come']) {
    assert.match(run(text), /調査中です/, text)
  }
  assert.match(run('sort status'), /指定チェスト: \(2, 64, 0\)/)
  const { done } = controller.task
  run('sort stop')
  assert.ok(surveys[0].options.signal.aborted)
  assert.match(run('sort plan'), /中止しています/)
  await done
  assert.deepEqual(reports, [])
  assert.equal(state().excluded.length, 0)
  assert.match(run('sort plan'), /調査します: 周りのチェスト/)
  controller.dispose()
})

test('調査に失敗したら理由を知らせる', async (t) => {
  const { bot, controller, run, surveys, reports } = setup(t)
  t.mock.method(console, 'error', () => {})
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  run('sort plan')
  const { done } = controller.task
  surveys[0].reject(new Error('指定チェストを調査できません'))
  await done
  assert.deepEqual(reports, ['調査できませんでした: 指定チェストを調査できません'])
})

test('呼び寄せは発言したプレイヤーへの移動を始め、停止で中止する', (t) => {
  const { moves, run } = setup(t)
  run('sort come')
  run('sort stop')
  assert.deepEqual(moves, ['come Tester', 'cancel'])
})

test('現在地を、ブロックの座標で答える', (t) => {
  const { bot, run } = setup(t)
  bot.entity.position = new Vec3(-3.5, 64.9, 10.2)
  assert.equal(run('sort pos'), '現在地: (-4, 64, 10)')
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
  assert.match(status, /整理を開始しています/)
  assert.match(status, /指定チェスト: \(2, 64, 0\)/)
  assert.match(status, /除外したチェスト: 1 個（\(5, 64, 0\)）/)
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
  assert.match(run('sort chest 500 64 0'), /読み込まれていません/)
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
  assert.match(run('sort start'), /登録しました: 指定チェスト \(5, 64, 0\)（一番近いチェストを自動で選びました/)
  assert.deepEqual(state().source, { positions: [{ x: 5, y: 64, z: 0 }], auto: true })
  assert.equal(state().running, false)
  run('sort start')
  assert.equal(state().running, true)
  run('sort stop')
  assert.equal(state().running, false)
})

test('付近にチェストがなければ通知して停止する', (t) => {
  const { run, state } = setup(t)
  assert.match(run('sort start'), /登録できませんでした: 指定チェスト（付近にチェストがありません）/)
  assert.equal(state().source, null)
  assert.equal(state().running, false)
})

test('指定チェストが壊されていれば開始しない', async (t) => {
  const { bot, run, state, stop } = setup(t)
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  run('sort start')
  await stop()
  bot.remove(2, 64, 0)
  assert.match(run('sort start'), /見つかりません/)
  assert.equal(state().running, false)
})

function started(t) {
  const env = setup(t)
  env.bot.putChest(2, 64, 0)
  env.bot.putChest(5, 64, 0)
  env.run('sort chest 2 64 0')
  env.run('sort start')
  return env
}

test('開始すると整理し、指定チェストの中身が変わるたびに整理し直す', async (t) => {
  const { sorting, reports } = started(t)
  await until(() => sorting.runs.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sorting.runs.length, 1)
  sorting.signature = 'b'
  await until(() => sorting.runs.length === 2)
  // 同じ内容の結果は、繰り返して知らせない
  assert.deepEqual(reports, ['整理しました: 移せるアイテムはありません'])
})

test('使えないチェストがあれば、中身が変わらなくても、しばらくしてやり直す', async (t) => {
  const env = setup(t)
  env.sorting.result = { failed: [{ positions: [{ x: 5, y: 64, z: 0 }], reason: '開けません' }] }
  env.bot.putChest(2, 64, 0)
  env.run('sort chest 2 64 0')
  env.run('sort start')
  await until(() => env.sorting.runs.length === 2)
  assert.equal(env.reports.filter((m) => m.startsWith('使えなかったチェスト')).length, 1)
})

test('整理に失敗しても続け、同じ失敗は 1 回だけ知らせる', async (t) => {
  t.mock.method(console, 'error', () => {})
  const env = setup(t)
  env.sorting.error = new Error('指定チェストを開けません')
  env.bot.putChest(2, 64, 0)
  env.run('sort chest 2 64 0')
  env.run('sort start')
  await until(() => env.sorting.runs.length >= 3)
  assert.equal(env.reports.length, 1)
  assert.match(env.reports[0], /整理できませんでした/)
})

test('決めた振り分け先を保存する', async (t) => {
  const { sorting, state } = started(t)
  await until(() => sorting.runs.length === 1)
  const assignments = { dedicated: { stone: [{ x: 5, y: 64, z: 0 }] }, mixed: [], protected: [] }
  sorting.runs[0].saveAssignments(assignments)
  assert.deepEqual(state().assignments, assignments)
  assert.equal(state().running, true)
})

test('整理中は開始と調査を受け付けず、停止すると整理を終える', async (t) => {
  const { sorting, run, stop, controller, state } = started(t)
  await until(() => sorting.runs.length === 1 && !controller.task.busy)
  assert.match(run('sort start'), /整理中です/)
  assert.match(run('sort plan'), /整理中です/)
  // 次の確認を待っている間は、除外や呼び寄せができる
  assert.match(run('sort exclude 5 64 0'), /除外しました/)
  await stop()
  assert.equal(controller.task, null)
  assert.equal(state().running, false)
  assert.ok(sorting.runs[0].signal.aborted)
})

test('再起動後は、開始の状態なら整理を再開する', async (t) => {
  const { sorting, controller, boot } = started(t)
  await until(() => sorting.runs.length === 1)
  controller.dispose()
  const restarted = boot()
  restarted.resume()
  await until(() => sorting.runs.length === 2)
})

test('伐採とクラフトの通知は、チャットへ知らせる', async (t) => {
  const { sorting, reports } = started(t)
  await until(() => sorting.runs.length === 1)
  sorting.runs[0].notify('クラフトします: 板材')
  assert.ok(reports.includes('クラフトします: 板材'))
})

test('死亡したら整理を停止して場所を知らせる', async (t) => {
  const { sorting, controller, state, reports } = started(t)
  await until(() => sorting.runs.length === 1)
  controller.onDeath()
  assert.equal(state().running, false)
  assert.match(reports.at(-1), /整理を中止しました: \(0, 64, 0\) で死亡しました/)
})

test('登録はディメンションごとに分ける', (t) => {
  const { bot, run, state } = setup(t)
  bot.putChest(2, 64, 0)
  run('sort chest 2 64 0')
  bot.game.dimension = 'the_nether'
  assert.equal(state().source, null)
})

test('指示した本数だけ伐採する', async (t) => {
  const { run, controller, reports, fells } = setup(t)
  assert.match(run('sort fell 3'), /伐採します: \(0, 64, 0\) の周りの木 3 本（近い木から切ります/)
  assert.match(run('sort start'), /伐採中です/)
  await controller.task.done
  assert.equal(fells[0].count, 3)
  assert.ok(reports.includes('伐採しました: 3 本（原木 12 個）'))
  assert.ok(reports.every((m) => !m.includes('植え直')))
})

test('本数を指定しなければ、切れる木がなくなるまで切る', async (t) => {
  const { run, controller, reports, fells } = setup(t)
  assert.match(run('sort fell'), /伐採します: \(0, 64, 0\) の周りの木（本数の指定なし）/)
  await controller.task.done
  assert.equal(fells[0].count, Infinity)
  assert.ok(reports.includes('伐採しました: 2 本（原木 8 個。周りに切れる木がなくなりました）'), reports.join('\n'))
})

test('伐採の本数は 1 から上限まで', (t) => {
  const { run, fells } = setup(t)
  assert.match(run('sort fell 0'), /本数は 1 から 40 で指定してください/)
  assert.match(run('sort fell 41'), /本数は 1 から 40 で指定してください/)
  assert.equal(fells.length, 0)
})

test('整理中は伐採を受け付けない', async (t) => {
  const { sorting, run, fells } = started(t)
  await until(() => sorting.runs.length === 1)
  assert.match(run('sort fell 2'), /整理中です/)
  assert.equal(fells.length, 0)
})
