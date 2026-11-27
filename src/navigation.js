// BOT の移動

const { Movements, goals } = require('mineflayer-pathfinder')

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
  return movements
}

class Navigator {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} [options]
   * @param {(bot: import('mineflayer').Bot) => object} [options.movementsFactory] 移動のルールを作る関数
   * @param {number} [options.timeout] 1 回の移動にかける時間の上限（ミリ秒）
   */
  constructor(bot, { movementsFactory = createMovements, timeout = MOVE_TIMEOUT_MS } = {}) {
    this.bot = bot
    this.movementsFactory = movementsFactory
    this.timeout = timeout
    // 移動を始めるか中止するたびに増やす。古い移動の結果は使わない
    this.generation = 0
  }

  /**
   * 目標の場所へ移動する
   *
   * @param {import('mineflayer-pathfinder').goals.Goal} goal 目標
   * @param {(bot: import('mineflayer').Bot) => object} [movementsFactory] この移動だけで使う移動のルール
   * @returns {Promise<{ status: 'arrived' | 'failed' | 'cancelled', reason?: string }>} 移動の結果。
   *   cancelled は、中止されたか、別の移動に切り替わったことを表す
   */
  async moveTo(goal, movementsFactory = this.movementsFactory) {
    const generation = ++this.generation
    let timer
    let failure = null
    try {
      this.bot.pathfinder.setMovements(movementsFactory(this.bot))
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('時間内に着けませんでした')), this.timeout)
        })
      ])
    } catch (err) {
      failure = err
    } finally {
      clearTimeout(timer)
    }
    if (generation !== this.generation) return { status: 'cancelled' }
    // 道がない場合でも goto が成功として終わることがあるため、着いた場所を確かめる
    if (!failure && goal.isEnd(this.bot.entity.position.floored())) return { status: 'arrived' }
    this.bot.pathfinder.setGoal(null)
    return { status: 'failed', reason: failure?.message }
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
      report('姿が見えません。BOT の近くで発言してください')
      return
    }
    const { x, y, z } = target.position
    report(`${username} のそばへ向かいます`)
    const { status, reason } = await this.moveTo(new goals.GoalNear(x, y, z, NEAR_DISTANCE))
    if (status === 'arrived') report('到着しました')
    if (status === 'failed') report(`そばまで行けませんでした${reason ? `: ${reason}` : ''}`)
  }

  // 移動を中止する
  cancel() {
    this.generation++
    this.bot.pathfinder.setGoal(null)
  }
}

module.exports = { Navigator, createMovements }
