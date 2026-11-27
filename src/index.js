// BOT のエントリーポイント
// サーバーへ接続してチャットコマンドを受け付け、切断されたら再接続する

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { createConfig, STATE_FILE, PLAN_FILE, DISCARD_LOG } = require('./config')
const { parseCommand } = require('./commands')
const { SortController } = require('./controller')
const { createChat, message } = require('./messages')
const { Navigator } = require('./navigation')
const { StateStore } = require('./state')

// 切断されてから再接続するまでの時間（ミリ秒）
const RECONNECT_DELAY_MS = 5000

const config = createConfig()
// 登録情報が壊れている場合は、ここで例外になり起動しない
const store = new StateStore(STATE_FILE)

function connect() {
  // mineflayer 自体のエラー出力は止めて、下の error の処理でまとめて表示する
  const bot = mineflayer.createBot({ ...config, hideErrors: true })
  bot.loadPlugin(pathfinder)
  // 周囲のチャンクが読み込まれるまでは、チェストを確認できない
  let ready = false
  // 発言は間を空けて順に出す。切断したあとは発言できないため、記録だけにする
  const chat = createChat(bot, { canChat: () => ready })
  const report = chat.say
  const controller = new SortController(bot, store, `${config.host}:${config.port}`, {
    navigator: new Navigator(bot),
    report,
    planFile: PLAN_FILE,
    discardLog: DISCARD_LOG
  })

  bot.once('spawn', async () => {
    try {
      await bot.waitForChunksToLoad()
    } catch (err) {
      console.error('チャンクの読み込みを待てませんでした:', err.message)
    }
    ready = true
    report(message.done('起動', 'SortBot', '使い方は sort help と発言してください'))
    console.log(`接続しました: ${config.host}:${config.port}（${bot.version}）`)
    try {
      controller.resume()
    } catch (err) {
      console.error('整理を再開できませんでした:', err)
    }
  })

  bot.on('death', () => {
    try {
      controller.onDeath()
    } catch (err) {
      console.error('死亡の処理に失敗しました:', err)
    }
  })

  // 命令は、BOT 自身を除くすべてのプレイヤーから受け付ける
  bot.on('chat', (username, text) => {
    if (username === bot.username) return
    const command = parseCommand(text)
    if (!command) return
    if (!ready) {
      bot.chat('準備中です。少し待ってから、もう一度発言してください')
      return
    }
    try {
      for (const line of controller.execute(command, username)) report(line)
    } catch (err) {
      console.error('コマンドの実行に失敗しました:', err)
      report(message.failed('コマンドの実行', null, err.message))
    }
  })

  bot.on('kicked', (reason) => console.log('キックされました:', JSON.stringify(reason)))
  // 接続の失敗は、メッセージが空でコードだけを持つことがある
  bot.on('error', (err) => console.error('エラー:', err.message || err.code || err))
  bot.once('end', (reason) => {
    ready = false
    chat.clear()
    controller.dispose()
    console.log(`切断されました: ${reason}。${RECONNECT_DELAY_MS / 1000} 秒後に再接続します`)
    setTimeout(connect, RECONNECT_DELAY_MS)
  })
}

connect()
