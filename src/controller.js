// コマンドの実行（チェストの登録・除外、整理の開始と停止、調査と計画の表示、呼び寄せと現在位置の報告）
// この段階では、BOT はアイテムを動かさない。移動するのは、調査するときと呼び寄せられたときだけ。

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { CHEST_NAME, chestPositions, findNearestChest, sortPositions, formatPosition, formatChest, samePosition, overlaps } = require('./chests')
const { HELP } = require('./commands')
const { buildPlan } = require('./plan')
const { formatSummary, formatDetail } = require('./planreport')
const { surveyChests } = require('./survey')

// 調査中は受け付けないコマンド（移動や登録内容が、調査と食い違うため）
const BLOCKED_WHILE_SURVEYING = new Set(['start', 'plan', 'chest', 'exclude', 'come'])

class SortController {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./state').StateStore} store 登録情報の保存先
   * @param {string} server 接続先（ホストとポート）
   * @param {object} options
   * @param {import('./navigation').Navigator} options.navigator 移動を行うもの
   * @param {(message: string) => void} options.report 時間がかかるコマンドの経過の通知先
   * @param {string} options.planFile 詳しい計画を書き出すファイル
   * @param {typeof surveyChests} [options.survey] チェストを調査する関数
   */
  constructor(bot, store, server, { navigator, report, planFile, survey = surveyChests }) {
    this.bot = bot
    this.store = store
    this.server = server
    this.navigator = navigator
    this.report = report
    this.planFile = planFile
    this.survey = survey
    // 実行中の調査。中止の合図と、終了を待つ Promise を持つ
    this.task = null
  }

  // ワールドの識別子。ディメンションが違えば、同じ座標でも別の登録として扱う
  get worldKey() {
    return `${this.server}|${this.bot.game.dimension}`
  }

  /**
   * コマンドを実行し、チャットで返す文を返す
   *
   * @param {{ type: string, position?: { x: number, y: number, z: number } }} command
   * @param {string} username 発言したプレイヤー名
   * @returns {string[]} すぐに返す文
   */
  execute(command, username) {
    if (this.task && BLOCKED_WHILE_SURVEYING.has(command.type)) {
      return [this.task.abort.signal.aborted ? '調査を中止しています。少し待ってください' : '調査中です。中止するには sort stop と発言してください']
    }
    switch (command.type) {
      case 'plan':
        return this.plan()
      case 'come':
        return this.come(username)
      case 'pos':
        return this.position()
      case 'start':
        return this.start()
      case 'stop':
        return this.stop()
      case 'status':
        return this.status()
      case 'chest':
        return this.registerSource(command.position)
      case 'exclude':
        return this.exclude(command.position)
      default:
        return [HELP]
    }
  }

  /**
   * 指定した座標のチェストを調べる
   *
   * @param {{ x: number, y: number, z: number }} position
   * @returns {{ positions: Array<object> } | { error: string }}
   */
  inspect({ x, y, z }) {
    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block) return { error: `(${x}, ${y}, ${z}) は読み込まれていないため確認できません。BOT の近くのチェストを指定してください` }
    if (block.name !== CHEST_NAME) return { error: `(${x}, ${y}, ${z}) に通常のチェストがありません` }
    return { positions: chestPositions(block) }
  }

  registerSource(position) {
    const { positions, error } = this.inspect(position)
    if (error) return [error]
    const world = this.store.get(this.worldKey)
    if (world.excluded.some((chest) => overlaps(chest, positions))) return ['除外したチェストは指定チェストにできません']
    world.source = { positions, auto: false }
    this.store.set(this.worldKey, world)
    return [`指定チェストを登録しました: ${formatChest(positions)}`]
  }

  exclude(position) {
    const { positions, error } = this.inspect(position)
    if (error) return [error]
    const world = this.store.get(this.worldKey)
    if (world.source && overlaps(world.source.positions, positions)) {
      return ['指定チェストは除外できません。先に sort chest で別のチェストを指定してください']
    }
    const matched = world.excluded.filter((chest) => overlaps(chest, positions))
    // 登録済みの座標と合わせて 1 つにまとめる
    const merged = [...positions]
    for (const p of matched.flat()) {
      if (!merged.some((q) => samePosition(p, q))) merged.push(p)
    }
    world.excluded = [...world.excluded.filter((chest) => !matched.includes(chest)), sortPositions(merged)]
    this.store.set(this.worldKey, world)
    return [`チェストを除外しました: ${formatChest(positions)}`]
  }

  start() {
    const world = this.store.get(this.worldKey)
    if (!world.source) return this.registerNearest(world)

    // 読み込まれていて、どの座標にもチェストがない場合は、開始しない
    const missing = world.source.positions.every(({ x, y, z }) => {
      const block = this.bot.blockAt(new Vec3(x, y, z))
      return block && block.name !== CHEST_NAME
    })
    if (missing) {
      world.running = false
      this.store.set(this.worldKey, world)
      return [`指定チェスト (${formatPosition(world.source.positions[0])}) が見つかりません。sort chest で指定し直してください`]
    }
    world.running = true
    this.store.set(this.worldKey, world)
    return ['整理の開始を受け付けました（アイテムを移す動作は、まだありません）']
  }

  // 指定がない場合は一番近いチェストを登録し、改めて開始の指示を待つ
  registerNearest(world) {
    const positions = findNearestChest(this.bot, (chest) => world.excluded.some((excluded) => overlaps(excluded, chest)))
    world.running = false
    if (positions) world.source = { positions, auto: true }
    this.store.set(this.worldKey, world)
    if (!positions) return ['付近にチェストがないため、停止します']
    return [`一番近いチェストを指定チェストに自動で登録しました: ${formatChest(positions)}`, 'このチェストでよければ、もう一度 sort start と発言してください']
  }

  stop() {
    // 保存に失敗しても調査と移動は止まるように、先に中止する
    this.dispose()
    const world = this.store.get(this.worldKey)
    world.running = false
    this.store.set(this.worldKey, world)
    return ['整理と移動を停止しました']
  }

  // 調査と移動を中止する（停止の指示と、切断したときに使う）
  dispose() {
    this.task?.abort.abort()
    this.navigator.cancel()
  }

  // 調査して計画を表示する。結果は、終わり次第 report で知らせる
  plan() {
    const world = this.store.get(this.worldKey)
    if (!world.source) return ['指定チェストがありません。sort chest か sort start で登録してください']
    this.navigator.cancel()
    const task = { abort: new AbortController() }
    this.task = task
    task.done = this.runPlan(world, task.abort.signal).finally(() => {
      this.task = null
    })
    return ['チェストの調査を始めます。アイテムは動かしません']
  }

  async runPlan(world, signal) {
    try {
      const { failed, ...survey } = await this.survey({
        bot: this.bot,
        navigator: this.navigator,
        source: world.source.positions,
        excluded: world.excluded,
        signal
      })
      const plan = buildPlan(survey)
      const summary = formatSummary(plan, failed)
      try {
        fs.mkdirSync(path.dirname(this.planFile), { recursive: true })
        fs.writeFileSync(this.planFile, formatDetail(plan, failed))
      } catch (err) {
        console.error('計画を保存できませんでした:', err.message)
        summary[summary.length - 1] = `アイテムは動かしていません。詳しい計画は保存できませんでした: ${err.message}`
      }
      console.log(formatDetail(plan, failed))
      for (const line of summary) this.report(line)
    } catch (err) {
      // 中止した調査の結果は知らせない
      if (signal.aborted) return
      console.error('調査に失敗しました:', err)
      this.report(`調査に失敗しました: ${err.message}`)
    }
  }

  // 移動の経過と結果は、終わり次第 report で知らせる
  come(username) {
    this.navigator.come(username, this.report).catch((err) => {
      console.error('移動に失敗しました:', err)
      this.report(`移動できませんでした: ${err.message}`)
    })
    return []
  }

  position() {
    return [`現在地: ${formatPosition(this.bot.entity.position.floored())}`]
  }

  status() {
    const { source, excluded, running } = this.store.get(this.worldKey)
    const sourceText = source ? `${formatChest(source.positions)}${source.auto ? '（自動）' : ''}` : '未登録'
    const lines = [`状態: ${running ? '開始' : '停止'} / 指定チェスト: ${sourceText} / 除外: ${excluded.length} 個`]
    if (excluded.length > 0) lines.push(`除外したチェスト: ${excluded.map(formatChest).join('、')}`)
    return lines
  }
}

module.exports = { SortController }
