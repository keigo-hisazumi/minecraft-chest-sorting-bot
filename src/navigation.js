// BOT の移動

const { Movements, goals } = require('mineflayer-pathfinder')
const { allowPlantReplacement, escape } = require('./escape')
const { message } = require('./messages')
const { MAX_ATTEMPTS, STALLED_MESSAGE, STALL_MS, recenter, watchStall } = require('./stall')

// プレイヤーから、この距離（ブロック）まで近づいたら到着とする
const NEAR_DISTANCE = 1
// 1 回の移動にかける時間の上限（ミリ秒）
const MOVE_TIMEOUT_MS = 60000

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
  // 草の上にも足場を置けるものとする（採掘 BOT と同じ）
  return allowPlantReplacement(movements, bot.registry)
}

class Navigator {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} [options]
   * @param {(bot: import('mineflayer').Bot) => object} [options.movementsFactory] 移動のルールを作る関数
   * @param {number} [options.timeout] 1 回の移動にかける時間の上限（ミリ秒）
   * @param {number} [options.stallMs] 経路に沿って動いているのに止まったとみなす時間（ミリ秒）
   * @param {number} [options.attempts] 止まったときに移動をやり直す最大の回数（最初の 1 回を含む）
   * @param {object} [options.escape] 動けなくなったときの脱出（escape.js）に渡すもの。なければ脱出しない
   * @param {() => Promise<boolean>} options.escape.holdBlock 足場に積むブロックを手に持つ。なければ false
   * @param {(text: string) => void} [options.escape.notify] チャットへの通知
   */
  constructor(
    bot,
    { movementsFactory = createMovements, timeout = MOVE_TIMEOUT_MS, stallMs = STALL_MS, attempts = MAX_ATTEMPTS, escape = null } = {}
  ) {
    this.bot = bot
    this.escape = escape
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
   * 体をブロックの中央に戻して、やり直す（stall.js）。通常の goto は、この状態で成功も失敗もせずに待ち続けるため。
   * それでも着けなければ、穴から登るなどして抜け出し（escape.js）、もう一度やり直す。
   *
   * @param {import('mineflayer-pathfinder').goals.Goal} goal 目標
   * @param {(bot: import('mineflayer').Bot) => object} [movementsFactory] この移動だけで使う移動のルール
   * @returns {Promise<{ status: 'arrived' | 'failed' | 'cancelled', reason?: string }>} 移動の結果。
   *   cancelled は、中止されたか、別の移動に切り替わったことを表す
   */
  async moveTo(goal, movementsFactory = this.movementsFactory) {
    const generation = ++this.generation
    const deadline = Date.now() + this.timeout
    const { stalled, ...result } = await this.#move(goal, movementsFactory, generation, deadline)
    if (result.status !== 'failed' || !this.escape) return result
    const cancelled = () => generation !== this.generation
    let escaped = false
    try {
      escaped = await escape(this.bot, { ...this.escape, stalled, isCancelled: cancelled })
    } catch (err) {
      console.error('動けない状態から抜け出せませんでした:', err.message)
    }
    if (cancelled()) return { status: 'cancelled' }
    if (!escaped) return result
    // 抜け出せたら、時間の上限を数え直して、もう一度だけ移動する
    const retried = await this.#move(goal, movementsFactory, generation, Date.now() + this.timeout)
    delete retried.stalled
    return retried
  }

  // 移動して、着いたかを確かめる。止まったら、体を中央に戻してやり直す。stalled は、経路の途中で止まったことがあるか
  async #move(goal, movementsFactory, generation, deadline) {
    let failure
    let stalledOnce = false
    try {
      this.bot.pathfinder.setMovements(movementsFactory(this.bot))
      for (let attempt = 1; ; attempt++) {
        const { stalled, error } = await this.#attempt(goal, deadline - Date.now())
        if (generation !== this.generation) return { status: 'cancelled' }
        if (!stalled) {
          failure = error
          break
        }
        stalledOnce = true
        if (attempt >= this.attempts || Date.now() >= deadline) {
          failure = new Error(STALLED_MESSAGE)
          break
        }
        await recenter(this.bot)
        if (generation !== this.generation) return { status: 'cancelled' }
      }
    } catch (err) {
      failure = err
    }
    if (generation !== this.generation) return { status: 'cancelled' }
    // 道がない場合でも goto が成功として終わることがあるため、着いた場所を確かめる
    if (!failure && goal.isEnd(this.bot.entity.position.floored())) return { status: 'arrived' }
    this.bot.pathfinder.setGoal(null)
    return { status: 'failed', reason: failure?.message, stalled: stalledOnce }
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
    const watch = watchStall(bot, goal, this.stallMs)
    let timer
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('時間内に着けませんでした')), Math.max(0, timeout))
        })
      ])
      return { stalled: watch.stalled, error: null }
    } catch (err) {
      return { stalled: watch.stalled, error: err }
    } finally {
      watch.stop()
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

module.exports = { Navigator, createMovements }
