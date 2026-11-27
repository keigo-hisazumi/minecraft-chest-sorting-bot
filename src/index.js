// BOT のエントリーポイント
// サーバーへ接続してチャットコマンドを受け付け、切断されたら再接続する

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { createConfig, STATE_FILE, PLAN_FILE } = require('./config')
const { parseCommand } = require('./commands')
const { SortController } = require('./controller')
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
  const controller = new SortController(bot, store, `${config.host}:${config.port}`, {
    navigator: new Navigator(bot),
    // 切断したあとは発言できないため、記録だけにする
    report: (message) => (ready ? bot.chat(message) : console.log(message)),
    planFile: PLAN_FILE
  })
  // 周囲のチャンクが読み込まれるまでは、チェストを確認できない
  let ready = false

  bot.once('spawn', async () => {
    try {
      await bot.waitForChunksToLoad()
    } catch (err) {
      console.error('チャンクの読み込みを待てませんでした:', err.message)
    }
    ready = true
    bot.chat('SortBot 起動')
    console.log(`接続しました: ${config.host}:${config.port}（${bot.version}）`)
  })

  // 命令は、BOT 自身を除くすべてのプレイヤーから受け付ける
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const command = parseCommand(message)
    if (!command) return
    if (!ready) {
      bot.chat('準備中です。少し待ってから、もう一度発言してください')
      return
    }
    try {
      for (const line of controller.execute(command, username)) bot.chat(line)
    } catch (err) {
      console.error('コマンドの実行に失敗しました:', err)
      bot.chat(`コマンドを実行できませんでした: ${err.message}`)
    }
  })

  bot.on('kicked', (reason) => console.log('キックされました:', JSON.stringify(reason)))
  // 接続の失敗は、メッセージが空でコードだけを持つことがある
  bot.on('error', (err) => console.error('エラー:', err.message || err.code || err))
  bot.once('end', (reason) => {
    ready = false
    controller.dispose()
    console.log(`切断されました: ${reason}。${RECONNECT_DELAY_MS / 1000} 秒後に再接続します`)
    setTimeout(connect, RECONNECT_DELAY_MS)
  })
}

connect()
