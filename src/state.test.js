const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StateStore, emptyWorld } = require('./state')

function temporaryFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sortbot-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'data', 'state.json')
}

const world = { source: { positions: [{ x: 1, y: 2, z: 3 }], auto: false }, excluded: [[{ x: 4, y: 5, z: 6 }]], running: true }

test('保存ファイルがなければ、登録なしから始める', (t) => {
  assert.deepEqual(new StateStore(temporaryFile(t)).get('a'), emptyWorld())
})

test('保存した内容は、読み込み直しても残る', (t) => {
  const file = temporaryFile(t)
  const store = new StateStore(file)
  store.set('a', world)
  // 2 回目の保存（既存のファイルの置き換え）も確かめる
  store.set('b', emptyWorld())
  const reloaded = new StateStore(file)
  assert.deepEqual(reloaded.get('a'), world)
  assert.deepEqual(reloaded.get('b'), emptyWorld())
})

test('取得した状態を書き換えても、保存するまで反映されない', (t) => {
  const store = new StateStore(temporaryFile(t))
  store.set('a', world)
  store.get('a').excluded.length = 0
  assert.equal(store.get('a').excluded.length, 1)
})

test('壊れたファイルや形式が違うファイルは、読み込まずに失敗する', (t) => {
  const file = temporaryFile(t)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (const text of ['{', 'null', '{}', '{"version":1,"worlds":{"a":{"source":null}}}']) {
    fs.writeFileSync(file, text)
    assert.throws(() => new StateStore(file), /登録情報/, text)
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  }
})
