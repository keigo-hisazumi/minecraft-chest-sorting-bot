// 登録情報の保存
// ワールド（接続先とディメンション）ごとに、指定チェスト、除外したチェスト、開始の状態をファイルへ残し、
// BOT を再起動しても引き継げるようにする。

const fs = require('node:fs')
const path = require('node:path')

const FORMAT_VERSION = 1

/**
 * 何も登録していないワールドの状態を作る
 *
 * @returns {{ source: null, excluded: Array<Array<{ x: number, y: number, z: number }>>, running: boolean }}
 */
function emptyWorld() {
  return { source: null, excluded: [], running: false }
}

const isPosition = (p) => Number.isInteger(p?.x) && Number.isInteger(p?.y) && Number.isInteger(p?.z)
const isPositions = (list) => Array.isArray(list) && list.length > 0 && list.every(isPosition)
const isWorld = (w) =>
  (w?.source === null || (isPositions(w?.source?.positions) && typeof w.source.auto === 'boolean')) &&
  Array.isArray(w.excluded) &&
  w.excluded.every(isPositions) &&
  typeof w.running === 'boolean'

/**
 * 登録情報を扱うクラス
 */
class StateStore {
  /**
   * 保存ファイルがなければ、登録なしから始める。
   * 読み込めない、または内容が壊れている場合は例外を投げる。
   * 登録なしとして続けると、除外したチェストの中身を後で動かしてしまうため。
   *
   * @param {string} file 保存ファイルのパス
   */
  constructor(file) {
    this.file = file
    this.worlds = load(file)
  }

  /**
   * ワールドの状態の複製を返す
   *
   * @param {string} key ワールドの識別子（接続先とディメンション）
   * @returns {ReturnType<typeof emptyWorld> | { source: { positions: Array<object>, auto: boolean }, excluded: Array<Array<object>>, running: boolean }}
   */
  get(key) {
    return structuredClone(this.worlds[key] ?? emptyWorld())
  }

  /**
   * ワールドの状態を保存する。保存に失敗した場合は例外を投げ、状態は変えない
   *
   * @param {string} key ワールドの識別子
   * @param {object} world 保存する状態
   */
  set(key, world) {
    const worlds = { ...this.worlds, [key]: structuredClone(world) }
    // 書き込みの途中で終了してもファイルが壊れないように、別のファイルへ書いてから置き換える
    const temporary = `${this.file}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ version: FORMAT_VERSION, worlds }, null, 2))
    fs.renameSync(temporary, this.file)
    this.worlds = worlds
  }
}

function load(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`登録情報を読み込めません（${file}）: ${err.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`登録情報が壊れています（${file}）: ${err.message}`)
  }
  if (data?.version !== FORMAT_VERSION || typeof data.worlds !== 'object' || data.worlds === null || !Object.values(data.worlds).every(isWorld)) {
    throw new Error(`登録情報の形式が正しくありません（${file}）`)
  }
  return data.worlds
}

module.exports = { StateStore, emptyWorld }
