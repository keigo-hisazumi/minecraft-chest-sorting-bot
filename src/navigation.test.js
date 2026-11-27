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
  assert.deepEqual(messages, ['Tester のそばへ向かいます', '到着しました'])
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
  assert.equal(messages.at(-1), 'そばまで行けませんでした: No path to the goal!')
  assert.equal(bot.goals.at(-1), null)
})

test('goto が終わっても着いていなければ、到着としない', async () => {
  const { navigator, messages, report } = setup(async () => {})
  await navigator.come('Tester', report)
  assert.equal(messages.at(-1), 'そばまで行けませんでした')
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
  assert.deepEqual(messages, ['Tester のそばへ向かいます'])
})
