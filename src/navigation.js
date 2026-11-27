// プレイヤーのそばへの移動

const { Movements, goals } = require('mineflayer-pathfinder')

// プレイヤーから、この距離（ブロック）まで近づいたら到着とする
const NEAR_DISTANCE = 1

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
   */
  constructor(bot, { movementsFactory = createMovements } = {}) {
    this.bot = bot
    this.movementsFactory = movementsFactory
    // 移動を始めるか中止するたびに増やす。古い移動の結果は報告しない
    this.generation = 0
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
    const generation = ++this.generation
    const { x, y, z } = target.position
    const goal = new goals.GoalNear(x, y, z, NEAR_DISTANCE)
    report(`${username} のそばへ向かいます`)
    let failure = null
    try {
      this.bot.pathfinder.setMovements(this.movementsFactory(this.bot))
      await this.bot.pathfinder.goto(goal)
    } catch (err) {
      failure = err
    }
    if (generation !== this.generation) return
    // 道がない場合でも goto が成功として終わることがあるため、着いた場所を確かめる
    if (!failure && goal.isEnd(this.bot.entity.position.floored())) {
      report('到着しました')
      return
    }
    this.bot.pathfinder.setGoal(null)
    report(`そばまで行けませんでした${failure ? `: ${failure.message}` : ''}`)
  }

  // 移動を中止する
  cancel() {
    this.generation++
    this.bot.pathfinder.setGoal(null)
  }
}

module.exports = { Navigator, createMovements }
