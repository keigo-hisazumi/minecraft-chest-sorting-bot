// 登録情報の保存
// ワールド（接続先とディメンション）ごとに、指定チェスト、除外したチェスト、開始の状態、振り分け先をファイルへ残し、
// BOT を再起動しても引き継げるようにする。

const fs = require('node:fs')
const path = require('node:path')

// 2: 振り分け先を追加。開始の状態でアイテムを動かすようになった
// 3: 開始の状態でアイテムを廃棄するようになった
const FORMAT_VERSION = 3

/**
 * 何も割り当てていない振り分け先を作る
 *
 * @returns {{ dedicated: Record<string, Array<object> | null>, mixed: Array<Array<object>>, protected: Array<Array<object>> }}
 *   dedicated は、専用にするアイテム名と、そのチェストの座標（まだないものは null）
 */
function emptyAssignments() {
  return { dedicated: {}, mixed: [], protected: [] }
}

/**
 * 何も登録していないワールドの状態を作る
 *
 * @returns {{ source: null, excluded: Array<Array<{ x: number, y: number, z: number }>>, running: boolean, assignments: object }}
 */
function emptyWorld() {
  return { source: null, excluded: [], running: false, assignments: emptyAssignments() }
}

const isPosition = (p) => Number.isInteger(p?.x) && Number.isInteger(p?.y) && Number.isInteger(p?.z)
const isPositions = (list) => Array.isArray(list) && list.length > 0 && list.every(isPosition)
const isPositionsList = (list) => Array.isArray(list) && list.every(isPositions)
const isAssignments = (a) =>
  typeof a?.dedicated === 'object' &&
  a.dedicated !== null &&
  Object.values(a.dedicated).every((positions) => positions === null || isPositions(positions)) &&
  isPositionsList(a.mixed) &&
  isPositionsList(a.protected)
// 苗木を植え直す場所。伐採を始める前の版で保存した内容にはない
const isReplant = (list) => list === undefined || (Array.isArray(list) && list.every((s) => isPosition(s) && typeof s.name === 'string'))
const isWorld = (w) =>
  (w?.source === null || (isPositions(w?.source?.positions) && typeof w.source.auto === 'boolean')) &&
  isPositionsList(w.excluded) &&
  typeof w.running === 'boolean' &&
  isAssignments(w.assignments) &&
  isReplant(w.replant)

// 以前の版の開始の状態は、今の版の動作（廃棄を含む）を指示したものではないため、引き継がずに停止にする
const upgrade = (version, world) => ({ ...world, running: false, ...(version === 1 && { assignments: emptyAssignments() }) })

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
   * @returns {ReturnType<typeof emptyWorld>} source は、登録していれば { positions, auto }
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
  const invalid = new Error(`登録情報の形式が正しくありません（${file}）`)
  if (![1, 2, FORMAT_VERSION].includes(data?.version) || typeof data.worlds !== 'object' || data.worlds === null) throw invalid
  const entries = Object.entries(data.worlds)
  const old = data.version !== FORMAT_VERSION
  const worlds = Object.fromEntries(old ? entries.map(([key, world]) => [key, upgrade(data.version, world)]) : entries)
  if (!Object.values(worlds).every(isWorld)) throw invalid
  return worlds
}

module.exports = { StateStore, emptyWorld, emptyAssignments }
