const test = require('node:test')
const assert = require('node:assert/strict')
const { parseCommand } = require('./commands')

test('引数のないコマンドを解釈する', () => {
  for (const type of ['start', 'stop', 'status', 'plan', 'replant', 'come', 'pos']) {
    assert.deepEqual(parseCommand(`sort ${type}`), { type })
  }
})

test('座標のあるコマンドを解釈する', () => {
  assert.deepEqual(parseCommand('  sort chest 10 -60 -5 '), { type: 'chest', position: { x: 10, y: -60, z: -5 } })
  assert.deepEqual(parseCommand('sort exclude 1 2 3'), { type: 'exclude', position: { x: 1, y: 2, z: 3 } })
})

test('本数のあるコマンドを解釈する', () => {
  assert.deepEqual(parseCommand('sort fell 5'), { type: 'fell', count: 5 })
  assert.deepEqual(parseCommand('sort fell'), { type: 'fell', count: null })
})

test('sort で始まらない発言は無視する', () => {
  for (const message of ['stop', 'status', 'chest 1 2 3', 'sorting start', 'こんにちは', '']) {
    assert.equal(parseCommand(message), null)
  }
})

test('形が正しくない sort の発言には使い方を返す', () => {
  for (const message of ['sort', 'sort foo', 'sort start now', 'sort chest', 'sort chest 1 2', 'sort chest 1.5 2 3', 'sort exclude a b c', 'sort fell -1', 'sort fell 1.5', 'sort fell 3 4']) {
    assert.deepEqual(parseCommand(message), { type: 'help' }, message)
  }
})
