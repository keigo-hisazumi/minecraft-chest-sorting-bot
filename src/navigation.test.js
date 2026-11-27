const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Navigator } = require('./navigation')

// goto の終わり方を指定できる簡易な BOT
function setup(goto) {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    players: { Tester: { entity: { position: new Vec3(10.5, 64, 0.5) } } },
    goals: [],
    pathfinder: {
      setMovements() {},
      setGoal: (goal) => bot.goals.push(goal),
      goto: (goal) => goto(bot, goal)
    }
  }
  const messages = []
  const navigator = new Navigator(bot, { movementsFactory: () => ({}) })
  return { bot, navigator, messages, report: (m) => messages.push(m) }
}

const arrive = async (bot) => {
  bot.entity.position = new Vec3(9.5, 64, 0.5)
}

test('プレイヤーのそばに着いたら到着を知らせる', async () => {
  const { navigator, messages, report } = setup(arrive)
  await navigator.come('Tester', report)
  assert.deepEqual(messages, ['移動します: Tester のそば', '移動しました: Tester のそば'])
})

test('姿が見えないプレイヤーへは移動しない', async () => {
  const { navigator, messages, report } = setup(() => assert.fail('移動してはいけない'))
  await navigator.come('Unknown', report)
  assert.match(messages.join(), /姿が見えません/)
})

test('移動に失敗した場合は理由を知らせて止まる', async () => {
  const { bot, navigator, messages, report } = setup(async () => {
    throw new Error('No path to the goal!')
  })
  await navigator.come('Tester', report)
  assert.equal(messages.at(-1), '移動できませんでした: Tester のそば（No path to the goal!）')
  assert.equal(bot.goals.at(-1), null)
})

test('goto が終わっても着いていなければ、到着としない', async () => {
  const { navigator, messages, report } = setup(async () => {})
  await navigator.come('Tester', report)
  assert.equal(messages.at(-1), '移動できませんでした: Tester のそば')
})

test('中止した移動の結果は知らせない', async () => {
  let finish
  const { navigator, messages, report } = setup(
    () =>
      new Promise((resolve, reject) => {
        finish = reject
      })
  )
  const moving = navigator.come('Tester', report)
  navigator.cancel()
  finish(new Error('GoalChanged'))
  await moving
  assert.deepEqual(messages, ['移動します: Tester のそば'])
})

// 経路はあるのに動けなくなる BOT。goto は stop されるまで待ち続け、stop されると失敗する
// unstickAfter 回目より後の goto は、目標に着いて終わる
function setupStuck({ unstickAfter = Infinity, attempts } = {}) {
  let rejectGoto = null
  const bot = {
    gotoCount: 0,
    stopCount: 0,
    entity: { position: new Vec3(0.9, 64, 0.9), height: 1.8 },
    clearControlStates() {},
    setControlState() {},
    waitForTicks: () => new Promise((resolve) => setTimeout(resolve, 1)),
    lookAt: async () => {},
    pathfinder: {
      setMovements() {},
      setGoal() {},
      isMoving: () => true,
      stop() {
        bot.stopCount++
        rejectGoto?.(new Error('Path was stopped before it could be completed'))
      },
      goto() {
        bot.gotoCount++
        if (bot.gotoCount > unstickAfter) {
          bot.entity.position = new Vec3(5.5, 64, 0.5)
          return Promise.resolve()
        }
        return new Promise((resolve, reject) => {
          rejectGoto = reject
        })
      }
    }
  }
  const navigator = new Navigator(bot, { movementsFactory: () => ({}), stallMs: 30, attempts })
  const goal = { isEnd: (p) => p.x === 5 && p.z === 0 }
  return { bot, navigator, goal }
}

test('経路に沿って動けなくなったら、止めてやり直す', async () => {
  const { bot, navigator, goal } = setupStuck({ unstickAfter: 1 })
  assert.deepEqual(await navigator.moveTo(goal), { status: 'arrived' })
  assert.equal(bot.gotoCount, 2)
  assert.equal(bot.stopCount, 1)
})

test('何度やり直しても動けなければ、失敗にする', async () => {
  const { bot, navigator, goal } = setupStuck({ attempts: 2 })
  assert.deepEqual(await navigator.moveTo(goal), { status: 'failed', reason: '移動の途中で動けなくなりました' })
  assert.equal(bot.gotoCount, 2)
})

test('経路を探している間（動く経路がない）は、止まったとみなさない', async () => {
  const { bot, navigator, goal } = setupStuck()
  bot.pathfinder.isMoving = () => false
  bot.pathfinder.goto = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        bot.entity.position = new Vec3(5.5, 64, 0.5)
        resolve()
      }, 300)
    )
  assert.deepEqual(await navigator.moveTo(goal), { status: 'arrived' })
  assert.equal(bot.stopCount, 0)
})

test('動けなくなっている間に中止したら、やり直さない', async () => {
  const { bot, navigator, goal } = setupStuck()
  const moving = navigator.moveTo(goal)
  navigator.cancel()
  bot.pathfinder.stop()
  assert.deepEqual(await moving, { status: 'cancelled' })
  assert.equal(bot.gotoCount, 1)
})
