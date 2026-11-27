// チャットへ出すメッセージのテスト（node --test で実行）

const test = require('node:test')
const assert = require('node:assert/strict')
const { formatPosition, message, createChat } = require('./messages')

test('formatPosition: 座標を (x, y, z) で書く', () => {
  assert.equal(formatPosition({ x: 10, y: -60, z: 3 }), '(10, -60, 3)')
})

test('message: 作業の段階ごとに、決まった形で書く', () => {
  assert.equal(message.start('伐採', 'オーク (1, 64, 2)'), '伐採します: オーク (1, 64, 2)')
  assert.equal(message.done('伐採', '3 本', '原木 12 個'), '伐採しました: 3 本（原木 12 個）')
  assert.equal(message.failed('格納', 'チェストが満杯です'), '格納できませんでした: チェストが満杯です')
  assert.equal(message.stopped('掘削', '持ち物が満杯です'), '掘削を中止しました: 持ち物が満杯です')
  assert.equal(message.busy('伐採', 'mine stop'), '伐採中です（中止するには mine stop と発言してください）')
  assert.equal(message.state('待機中'), '状態: 待機中')
  assert.equal(message.done('停止'), '停止しました')
})

test('createChat: 間隔を空けて、順に発言する', async () => {
  const said = []
  const chat = createChat({ chat: (m) => said.push(m) }, { interval: 20, log: () => {} })
  chat.say('1')
  chat.say('2')
  chat.say('3')
  assert.deepEqual(said, ['1'])
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.deepEqual(said, ['1', '2', '3'])
})

test('createChat: 発言できない間は、記録だけにする', () => {
  const said = []
  const logged = []
  const chat = createChat({ chat: (m) => said.push(m) }, { canChat: () => false, log: (m) => logged.push(m) })
  chat.say('準備中')
  assert.deepEqual(said, [])
  assert.deepEqual(logged, ['準備中'])
})

test('createChat: clear で、待っている発言を捨てる', async () => {
  const said = []
  const chat = createChat({ chat: (m) => said.push(m) }, { interval: 20, log: () => {} })
  chat.say('1')
  chat.say('2')
  chat.clear()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(said, ['1'])
})
