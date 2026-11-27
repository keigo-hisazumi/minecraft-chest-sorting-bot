// BOT の移動

const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { message } = require('./messages')

// プレイヤーから、この距離（ブロック）まで近づいたら到着とする
const NEAR_DISTANCE = 1
// 1 回の移動にかける時間の上限（ミリ秒）
const MOVE_TIMEOUT_MS = 60000
// 経路に沿って動いているのに、この時間（ミリ秒）ほとんど動かなければ、止まったとみなす
const STALL_MS = 3000
// 止まったとみなす移動量（ブロック）
const STALL_DISTANCE = 0.05
// 動いたかを確かめる間隔（ミリ秒）
const POLL_MS = 250
// 止まったときに移動をやり直す最大の回数（最初の 1 回を含む）
const MAX_ATTEMPTS = 3
// ブロックの中央へ寄る処理の制限時間（ミリ秒）
const CENTER_TIMEOUT_MS = 1500

/**
 * 移動のルールを作る。移動中は、ブロックの破壊と足場の設置をしない
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Movements}
 */
function createMovements(bot) {
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  // mineflayer-pathfinder のプロパティ名は綴りが誤っている（scafoldingBlocks）。
  // これを空にしないと、ブロックを置いて橋渡しする経路が選ばれる
  movements.scafoldingBlocks = []
  // 将来の版で綴りが直った場合にも備えて、正しい綴りのプロパティも空にする
  movements.scaffoldingBlocks = []
  // サボテンに触れる経路は通らない
  const cactus = bot.registry.blocksByName.cactus
  if (cactus) movements.blocksToAvoid.add(cactus.id)
  return movements
}

/**
 * 今いるブロックの中央へ、経路探索を使わずに寄る
 * 体がブロックの角や縁にまたがっていると、段差のジャンプが壁に当たって登れなくなる。
 * 中央に戻してから、経路探索をやり直す。
 *
 * @param {import('mineflayer').Bot} bot
 */
async function centerOnBlock(bot) {
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

class Navigator {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} [options]
   * @param {(bot: import('mineflayer').Bot) => object} [options.movementsFactory] 移動のルールを作る関数
   * @param {number} [options.timeout] 1 回の移動にかける時間の上限（ミリ秒）
   * @param {number} [options.stallMs] 経路に沿って動いているのに止まったとみなす時間（ミリ秒）
   * @param {number} [options.attempts] 止まったときに移動をやり直す最大の回数（最初の 1 回を含む）
   */
  constructor(bot, { movementsFactory = createMovements, timeout = MOVE_TIMEOUT_MS, stallMs = STALL_MS, attempts = MAX_ATTEMPTS } = {}) {
    this.bot = bot
    this.movementsFactory = movementsFactory
    this.timeout = timeout
    this.stallMs = stallMs
    this.attempts = attempts
    // 移動を始めるか中止するたびに増やす。古い移動の結果は使わない
    this.generation = 0
  }

  /**
   * 目標の場所へ移動する
   * 経路に沿って動いているのに止まってしまった（体が斜めになって段差を登れないなど）ときは、
   * 体をブロックの中央に戻して、やり直す。通常の goto は、この状態で成功も失敗もせずに待ち続けるため。
   *
   * @param {import('mineflayer-pathfinder').goals.Goal} goal 目標
   * @param {(bot: import('mineflayer').Bot) => object} [movementsFactory] この移動だけで使う移動のルール
   * @returns {Promise<{ status: 'arrived' | 'failed' | 'cancelled', reason?: string }>} 移動の結果。
   *   cancelled は、中止されたか、別の移動に切り替わったことを表す
   */
  async moveTo(goal, movementsFactory = this.movementsFactory) {
    const generation = ++this.generation
    const deadline = Date.now() + this.timeout
    let failure = null
    try {
      this.bot.pathfinder.setMovements(movementsFactory(this.bot))
      for (let attempt = 1; ; attempt++) {
        const { stalled, error } = await this.#attempt(goal, deadline - Date.now())
        if (generation !== this.generation) return { status: 'cancelled' }
        if (!stalled) {
          failure = error
          break
        }
        if (attempt >= this.attempts || Date.now() >= deadline) {
          failure = new Error('移動の途中で動けなくなりました')
          break
        }
        await centerOnBlock(this.bot)
        if (generation !== this.generation) return { status: 'cancelled' }
      }
    } catch (err) {
      failure = err
    }
    if (generation !== this.generation) return { status: 'cancelled' }
    // 道がない場合でも goto が成功として終わることがあるため、着いた場所を確かめる
    if (!failure && goal.isEnd(this.bot.entity.position.floored())) return { status: 'arrived' }
    this.bot.pathfinder.setGoal(null)
    return { status: 'failed', reason: failure?.message }
  }

  /**
   * goto を 1 回行う。動く経路があるのに止まったままなら、経路探索を止める
   *
   * @param {object} goal 目標
   * @param {number} timeout この移動にかけられる残り時間（ミリ秒）
   * @returns {Promise<{ stalled: boolean, error: Error | null }>} 止まったために中断したかと、失敗の理由
   */
  async #attempt(goal, timeout) {
    const { bot } = this
    let stalled = false
    let last = bot.entity.position.clone()
    let since = Date.now()
    const watch = setInterval(() => {
      const p = bot.entity.position
      // 経路を探している間は止まっていて当然なので、動く経路があるときだけ数える
      if (!bot.pathfinder.isMoving?.() || p.distanceTo(last) > STALL_DISTANCE) {
        last = p.clone()
        since = Date.now()
        return
      }
      if (Date.now() - since >= this.stallMs && !goal.isEnd(p.floored())) {
        stalled = true
        bot.pathfinder.stop()
      }
    }, POLL_MS)
    let timer
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('時間内に着けませんでした')), Math.max(0, timeout))
        })
      ])
      return { stalled, error: null }
    } catch (err) {
      return { stalled, error: err }
    } finally {
      clearInterval(watch)
      clearTimeout(timer)
    }
  }

  /**
   * 発言したプレイヤーが今いる場所のそばまで移動する
   *
   * @param {string} username プレイヤー名
   * @param {(message: string) => void} report 経過の通知先（チャットなど）
   */
  async come(username, report) {
    const target = this.bot.players[username]?.entity
    if (!target) {
      report(message.failed('移動', `${username} のそば`, '姿が見えません。BOT の近くで発言してください'))
      return
    }
    const { x, y, z } = target.position
    report(message.start('移動', `${username} のそば`))
    const { status, reason } = await this.moveTo(new goals.GoalNear(x, y, z, NEAR_DISTANCE))
    if (status === 'arrived') report(message.done('移動', `${username} のそば`))
    if (status === 'failed') report(message.failed('移動', `${username} のそば`, reason))
  }

  // 移動を中止する
  cancel() {
    this.generation++
    this.bot.pathfinder.setGoal(null)
  }
}

module.exports = { Navigator, createMovements, centerOnBlock }
