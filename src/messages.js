// チャットへ出すメッセージ
// 採掘 BOT とチェスト整理 BOT で、メッセージの書き方と出し方をそろえる。書き方の決まりは docs/messages.md を参照する。
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

// 発言の間隔（ミリ秒）。続けて発言すると、サーバーに切断されることがあるため、間を空ける
const CHAT_INTERVAL_MS = 1000
// 発言を待たせる数の上限。超えた分は記録だけにする
const CHAT_QUEUE_LIMIT = 20

/**
 * 座標を書く（例: (10, 64, -3)）
 *
 * @param {{ x: number, y: number, z: number }} position
 * @returns {string}
 */
const formatPosition = ({ x, y, z }) => `(${x}, ${y}, ${z})`

// 見出しに、詳細（コロンの後）と補足（全角括弧）を付ける
function compose(head, detail, note) {
  return `${head}${detail ? `: ${detail}` : ''}${note ? `（${note}）` : ''}`
}

/**
 * 作業の各段階のメッセージを作る。作業名はサ変名詞（伐採、掘削、格納、整理など）にする
 * - start: 作業を始めるとき「伐採します: オーク (10, 64, -3)」
 * - done: 作業を終えたとき「伐採しました: 3 本（原木 12 個）」
 * - failed: できなかったとき「格納できませんでした: チェストが満杯です」
 * - stopped: 途中でやめたとき「掘削を中止しました: 持ち物が満杯です」
 * - busy: 別の作業中で受け付けないとき「伐採中です（中止するには mine stop と発言してください）」
 */
const message = {
  start: (action, detail, note) => compose(`${action}します`, detail, note),
  done: (action, detail, note) => compose(`${action}しました`, detail, note),
  failed: (action, reason, note) => compose(`${action}できませんでした`, reason, note),
  stopped: (action, reason, note) => compose(`${action}を中止しました`, reason, note),
  busy: (action, stopCommand) => compose(`${action}中です`, null, `中止するには ${stopCommand} と発言してください`),
  state: (detail, note) => compose('状態', detail, note)
}

/**
 * チャットへ順に発言する関数を作る。間隔を空けて発言し、接続していない間は記録だけにする
 *
 * @param {{ chat: (message: string) => void }} bot
 * @param {object} [options]
 * @param {() => boolean} [options.canChat] 発言できるか（接続して準備ができたか）
 * @param {number} [options.interval] 発言の間隔（ミリ秒）
 * @param {(message: string) => void} [options.log] 記録の出力先
 * @returns {{ say: (message: string) => void, clear: () => void }} say は発言を待ち行列に入れる。clear は待っている発言を捨てる
 */
function createChat(bot, { canChat = () => true, interval = CHAT_INTERVAL_MS, log = console.log } = {}) {
  const queue = []
  let timer = null
  let last = -Infinity
  const flush = () => {
    timer = null
    const next = queue.shift()
    if (next === undefined) return
    // 待っている間に切断した場合は、発言しない（記録は say のときに済んでいる）
    if (canChat()) bot.chat(next)
    last = Date.now()
    schedule()
  }
  const schedule = () => {
    if (timer || queue.length === 0) return
    const wait = last + interval - Date.now()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  }
  return {
    say(text) {
      log(text)
      if (!canChat() || queue.length >= CHAT_QUEUE_LIMIT) return
      queue.push(text)
      schedule()
    },
    clear() {
      queue.length = 0
      clearTimeout(timer)
      timer = null
    }
  }
}

module.exports = { CHAT_INTERVAL_MS, formatPosition, message, createChat }
