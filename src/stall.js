// 経路探索の移動が止まったときの立て直し
// 経路に沿って動いているのに、体が斜めになるなどして段差を登れず、同じ場所で止まったことを見つけて、体をブロックの中央に戻す。
// 通常の goto は、この状態で成功も失敗もせずに待ち続けるため、止まったら経路探索を止めて、呼び出す側でやり直す。
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

const { Vec3 } = require('vec3')

// 経路に沿って動いているのに、この時間（ミリ秒）ほとんど動かなければ、止まったとみなす
const STALL_MS = 3000
// 止まったとみなす移動量（ブロック）
const STALL_DISTANCE = 0.05
// 動いたかを確かめる間隔（ミリ秒）
const POLL_MS = 250
// 止まったときに移動をやり直す最大の回数（最初の 1 回を含む）
const MAX_ATTEMPTS = 3
// 止まったまま、やり直しても動けなかったときのエラーの文言
const STALLED_MESSAGE = '移動の途中で動けなくなりました'
// ブロックの中央へ寄る処理の制限時間（ミリ秒）
const CENTER_TIMEOUT_MS = 1500

/**
 * 今いるブロックの中央へ、経路探索を使わずに寄る
 * 体がブロックの角や縁にまたがっていると、段差のジャンプが壁に当たって登れなくなる。
 * 中央に戻してから、経路探索をやり直す。
 *
 * @param {import('mineflayer').Bot} bot
 */
async function recenter(bot) {
  const p = bot.entity.position
  const center = new Vec3(Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) + 0.5)
  const deadline = Date.now() + CENTER_TIMEOUT_MS
  bot.clearControlStates()
  await bot.waitForTicks(2)
  try {
    while (Date.now() < deadline) {
      const now = bot.entity.position
      if (Math.hypot(center.x - now.x, center.z - now.z) < 0.15) break
      await bot.lookAt(new Vec3(center.x, now.y + bot.entity.height, center.z), true)
      bot.setControlState('forward', true)
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
  }
  await bot.waitForTicks(2)
}

/**
 * 移動を見張り、動く経路があるのに止まったままなら、経路探索を止める
 * 見張りは、移動が終わったら stop で必ず止めること。
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} goal mineflayer-pathfinder の目標（着いていれば、止まっていても止まったとみなさない）
 * @param {number} [stallMs] 止まったとみなす時間（ミリ秒）
 * @returns {{ readonly stalled: boolean, stop: () => void }} stalled は、止まったために経路探索を止めたか
 */
function watchStall(bot, goal, stallMs = STALL_MS) {
  let stalled = false
  let last = bot.entity.position.clone()
  let since = Date.now()
  const timer = setInterval(() => {
    const p = bot.entity.position
    // 経路を探している間は止まっていて当然なので、動く経路があるときだけ数える
    if (!bot.pathfinder.isMoving?.() || p.distanceTo(last) > STALL_DISTANCE) {
      last = p.clone()
      since = Date.now()
      return
    }
    if (Date.now() - since >= stallMs && !goal.isEnd(p.floored())) {
      stalled = true
      bot.pathfinder.stop()
    }
  }, POLL_MS)
  return {
    get stalled() {
      return stalled
    },
    stop: () => clearInterval(timer)
  }
}

module.exports = { STALL_MS, MAX_ATTEMPTS, STALLED_MESSAGE, recenter, watchStall }
