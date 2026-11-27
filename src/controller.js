// コマンドの実行（チェストの登録・除外、整理の開始と停止、調査と計画の表示、伐採、植え直し、呼び寄せと現在位置の報告）
// 整理を開始している間は、指定チェストを定期的に確認して、中身が変わったら整理する。

const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { Vec3 } = require('vec3')
const { CHEST_NAME, chestPositions, findNearestChest, sortPositions, formatPosition, formatChest, samePosition, overlaps } = require('./chests')
const { HELP } = require('./commands')
const { message } = require('./messages')
const { findTable } = require('./builder')
const { TREE_LIMIT, gatherWood, replant } = require('./forester')
const { buildPlan } = require('./plan')
const { formatSummary, formatDetail, formatResult } = require('./planreport')
const { sortOnce, readSourceSignature } = require('./sorter')
const { surveyChests } = require('./survey')

// 調査やアイテムの移動をしている間は受け付けないコマンド（移動や登録内容が食い違うため）
const BLOCKED_WHILE_BUSY = new Set(['start', 'plan', 'replant', 'fell', 'chest', 'exclude', 'come'])
// 整理を開始している間は、次の確認を待っているときも受け付けないコマンド
const BLOCKED_WHILE_SORTING = new Set(['start', 'plan', 'replant', 'fell'])
// 実行中の作業の呼び方
const TASK_NAMES = { sort: '整理', plan: '調査', replant: '植え直し', fell: '伐採' }
// 指定チェストを確認する間隔（ミリ秒）
const POLL_INTERVAL_MS = 30000
// 使えないチェストがあった場合に、中身が変わらなくても整理をやり直すまでの確認の回数
const RETRY_POLLS = 10

/**
 * BOT の周りの木を、指定した本数だけ切る（sort fell の既定の処理）
 * 原木の量の目標は設けず、本数に達するか、切れる木がなくなるか、持ち物の空きがなくなるまで切る。
 * 斧は持ち物の物を使う。なければ、範囲内に作業台があれば作り、作れなければ素手で切る。
 */
function fellTrees(context, count, { pending, savePending }) {
  return gatherWood(context, { wanted: Infinity, maxTrees: count, records: [], pending, savePending })
}

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
   * @param {{ sortOnce: typeof sortOnce, readSourceSignature: typeof readSourceSignature }} [options.sorter] 整理を行うもの
   * @param {number} [options.pollInterval] 指定チェストを確認する間隔（ミリ秒）
   * @param {typeof replant} [options.replanter] 苗木を植え直す関数
   * @param {typeof fellTrees} [options.feller] 周りの木を指定した本数だけ切る関数
   * @param {string} [options.discardLog] 廃棄を記録するファイル。なければ廃棄しない
   */
  constructor(
    bot,
    store,
    server,
    {
      navigator,
      report,
      planFile,
      survey = surveyChests,
      sorter = { sortOnce, readSourceSignature },
      pollInterval = POLL_INTERVAL_MS,
      replanter = replant,
      feller = fellTrees,
      discardLog
    }
  ) {
    this.replanter = replanter
    this.feller = feller
    this.discardLog = discardLog
    this.bot = bot
    this.store = store
    this.server = server
    this.navigator = navigator
    this.report = report
    this.planFile = planFile
    this.survey = survey
    this.sorter = sorter
    this.pollInterval = pollInterval
    // 実行中の調査か整理。中止の合図、作業中かどうか、終了を待つ Promise を持つ
    this.task = null
  }

  // ワールドの識別子。ディメンションが違えば、同じ座標でも別の登録として扱う
  get worldKey() {
    return `${this.server}|${this.bot.game.dimension}`
  }

  /**
   * コマンドを実行し、チャットで返す文を返す
   *
   * @param {{ type: string, position?: { x: number, y: number, z: number }, count?: number }} command
   * @param {string} username 発言したプレイヤー名
   * @returns {string[]} すぐに返す文
   */
  execute(command, username) {
    const refusal = this.refusal(command.type)
    if (refusal) return [refusal]
    switch (command.type) {
      case 'plan':
        return this.plan()
      case 'replant':
        return this.replant()
      case 'fell':
        return this.fell(command.count)
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

  // 実行中の作業があるため受け付けない場合は、その理由を返す
  refusal(type) {
    if (!this.task) return null
    const name = TASK_NAMES[this.task.type]
    if (this.task.abort.signal.aborted) {
      return BLOCKED_WHILE_BUSY.has(type) ? `${name}を中止しています（少し待ってから発言してください）` : null
    }
    const blocked = (this.task.busy && BLOCKED_WHILE_BUSY.has(type)) || (this.task.type === 'sort' && BLOCKED_WHILE_SORTING.has(type))
    return blocked ? message.busy(name, 'sort stop') : null
  }

  /**
   * 指定した座標のチェストを調べる
   *
   * @param {{ x: number, y: number, z: number }} position
   * @param {string} action 失敗したときに知らせる作業名
   * @returns {{ positions: Array<object> } | { error: string }}
   */
  inspect({ x, y, z }, action) {
    const block = this.bot.blockAt(new Vec3(x, y, z))
    const target = `チェスト ${formatPosition({ x, y, z })}`
    if (!block) return { error: message.failed(action, target, '読み込まれていません。BOT の近くのチェストを指定してください') }
    if (block.name !== CHEST_NAME) return { error: message.failed(action, target, '通常のチェストがありません') }
    return { positions: chestPositions(block) }
  }

  registerSource(position) {
    const { positions, error } = this.inspect(position, '登録')
    if (error) return [error]
    const world = this.store.get(this.worldKey)
    if (world.excluded.some((chest) => overlaps(chest, positions))) return [message.failed('登録', `指定チェスト ${formatChest(positions)}`, '除外したチェストは指定チェストにできません')]
    world.source = { positions, auto: false }
    this.store.set(this.worldKey, world)
    return [message.done('登録', `指定チェスト ${formatChest(positions)}`)]
  }

  exclude(position) {
    const { positions, error } = this.inspect(position, '除外')
    if (error) return [error]
    const world = this.store.get(this.worldKey)
    if (world.source && overlaps(world.source.positions, positions)) {
      return [message.failed('除外', `チェスト ${formatChest(positions)}`, '指定チェストは除外できません。先に sort chest で別のチェストを指定してください')]
    }
    const matched = world.excluded.filter((chest) => overlaps(chest, positions))
    // 登録済みの座標と合わせて 1 つにまとめる
    const merged = [...positions]
    for (const p of matched.flat()) {
      if (!merged.some((q) => samePosition(p, q))) merged.push(p)
    }
    world.excluded = [...world.excluded.filter((chest) => !matched.includes(chest)), sortPositions(merged)]
    this.store.set(this.worldKey, world)
    return [message.done('除外', `チェスト ${formatChest(positions)}`)]
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
      return [message.failed('整理', `指定チェスト ${formatPosition(world.source.positions[0])} が見つかりません`, 'sort chest で指定し直してください')]
    }
    world.running = true
    this.store.set(this.worldKey, world)
    this.startSorting()
    return [
      message.start('整理', `指定チェスト ${formatChest(world.source.positions)}`, '中止するには sort stop と発言してください'),
      '専用チェストに入りきらないアイテムは、範囲内にサボテンがあれば投げて廃棄します（元に戻せません）'
    ]
  }

  // 再接続や再起動のあと、開始の状態なら整理を再開する
  resume() {
    const { running, source } = this.store.get(this.worldKey)
    if (!running || !source || this.task) return
    this.report(message.start('整理', `指定チェスト ${formatChest(source.positions)}`, '前回の続きです'))
    this.startSorting()
  }

  // BOT が死亡したら整理を止める（落としたアイテムの回収は、まだできない）
  onDeath() {
    const { running } = this.store.get(this.worldKey)
    if (!running && !this.task) return
    const position = formatPosition(this.bot.entity.position.floored())
    this.stop()
    this.report(message.stopped('整理', `${position} で死亡しました`, '落としたアイテムは消える前に回収してください'))
  }

  startSorting() {
    this.navigator.cancel()
    const task = { type: 'sort', abort: new AbortController(), busy: true }
    this.task = task
    task.done = this.runSorting(task).finally(() => {
      this.task = null
    })
  }

  async runSorting(task) {
    const { signal } = task.abort
    // 整理したあとの指定チェストの中身。null なら、次の確認で整理する
    let signature = null
    let polls = 0
    let reported = ''
    const tell = (lines) => {
      for (const line of lines) this.report(line)
    }
    while (!signal.aborted) {
      try {
        task.busy = true
        const key = this.worldKey
        const world = this.store.get(key)
        if (!world.running || !world.source) return
        const context = { bot: this.bot, navigator: this.navigator, world, signal }
        const unchanged = signature !== null && (await this.sorter.readSourceSignature(context)) === signature.value
        if (!unchanged || (signature.retry && ++polls >= RETRY_POLLS)) {
          const result = await this.sorter.sortOnce({
            ...context,
            saveAssignments: (assignments) => this.store.set(key, { ...this.store.get(key), assignments }),
            saveReplant: (spots) => this.saveReplant(key, spots),
            notify: this.report,
            discardLog: this.discardLog
          })
          const { problems = [], expanded = 0, created = 0, trees = 0 } = result.build ?? {}
          const unfinished = result.failed.length > 0 || problems.length > 0 || Boolean(result.discard?.problem)
          signature = { value: result.signature, retry: unfinished }
          polls = 0
          const lines = formatResult(result)
          // 何も移さず作業もせず、前回と同じ内容なら、繰り返して知らせない
          const discarded = Object.keys(result.discard?.discarded ?? {}).length
          const worked = result.delivered + expanded + created + trees + discarded > 0
          if (worked || lines.join('\n') !== reported) tell(lines)
          reported = lines.join('\n')
        }
      } catch (err) {
        if (signal.aborted) return
        signature = null
        const text = message.failed('整理', err.message, 'あとでもう一度試します')
        if (text !== reported) {
          console.error('整理に失敗しました:', err)
          this.report(text)
        }
        reported = text
      } finally {
        task.busy = false
      }
      // 中止された場合は、待たずに終える
      await sleep(this.pollInterval, undefined, { signal }).catch(() => {})
    }
  }

  // 指定がない場合は一番近いチェストを登録し、改めて開始の指示を待つ
  registerNearest(world) {
    const positions = findNearestChest(this.bot, (chest) => world.excluded.some((excluded) => overlaps(excluded, chest)))
    world.running = false
    if (positions) world.source = { positions, auto: true }
    this.store.set(this.worldKey, world)
    if (!positions) return [message.failed('登録', '指定チェスト', '付近にチェストがありません')]
    return [message.done('登録', `指定チェスト ${formatChest(positions)}`, '一番近いチェストを自動で選びました。このチェストでよければ、もう一度 sort start と発言してください')]
  }

  stop() {
    const sorting = this.task?.type === 'sort'
    // 保存に失敗しても作業と移動は止まるように、先に中止する
    this.dispose()
    const world = this.store.get(this.worldKey)
    world.running = false
    this.store.set(this.worldKey, world)
    return [
      message.done('停止', '整理と移動'),
      ...(sorting ? ['運んでいる途中のアイテムがあれば BOT が持っています（続きは sort start と発言してください）'] : [])
    ]
  }

  // 調査、整理、移動を中止する（停止の指示と、切断したときに使う）
  dispose() {
    this.task?.abort.abort()
    this.navigator.cancel()
  }

  // 調査して計画を表示する。結果は、終わり次第 report で知らせる
  plan() {
    const world = this.store.get(this.worldKey)
    if (!world.source) return [message.failed('調査', '指定チェストがありません', 'sort chest か sort start で登録してください')]
    this.navigator.cancel()
    const task = { type: 'plan', abort: new AbortController(), busy: true }
    this.task = task
    task.done = this.runPlan(world, task.abort.signal).finally(() => {
      this.task = null
    })
    return [message.start('調査', '周りのチェスト', 'アイテムは動かしません')]
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
      const plan = buildPlan(survey, { previous: world.assignments })
      const summary = formatSummary(plan, failed)
      try {
        fs.mkdirSync(path.dirname(this.planFile), { recursive: true })
        fs.writeFileSync(this.planFile, formatDetail(plan, failed))
      } catch (err) {
        console.error('計画を保存できませんでした:', err.message)
        summary[summary.length - 1] = `アイテムは動かしていません（詳しい計画は保存できませんでした: ${err.message}）`
      }
      console.log(formatDetail(plan, failed))
      for (const line of summary) this.report(line)
    } catch (err) {
      // 中止した調査の結果は知らせない
      if (signal.aborted) return
      console.error('調査に失敗しました:', err)
      this.report(message.failed('調査', err.message))
    }
  }

  saveReplant(key, spots) {
    this.store.set(key, { ...this.store.get(key), replant: spots })
  }

  // 伐採した場所に苗木を植え直す。結果は、終わり次第 report で知らせる
  replant() {
    const key = this.worldKey
    const world = this.store.get(key)
    const pending = world.replant ?? []
    if (pending.length === 0) return [message.failed('植え直し', '植え直す場所がありません')]
    this.navigator.cancel()
    const task = { type: 'replant', abort: new AbortController(), busy: true }
    this.task = task
    task.done = this.runReplant(key, world, pending, task.abort.signal).finally(() => {
      this.task = null
    })
    return [message.start('植え直し', `${pending.length} か所`, '中止するには sort stop と発言してください')]
  }

  async runReplant(key, world, pending, signal) {
    const context = { bot: this.bot, navigator: this.navigator, signal, failed: [] }
    try {
      // 苗木をチェストから取り出せるように、指定チェストがあれば中身を調べる
      let records = []
      if (world.source) {
        const found = await this.survey({ ...context, source: world.source.positions, excluded: world.excluded })
        records = [found.source, ...found.chests]
      }
      const result = await this.replanter(context, pending, records)
      this.saveReplant(key, result.pending)
      const rest = result.pending.length > 0 ? `苗木がないなどで ${result.pending.length} か所は植えていません` : null
      this.report(message.done('植え直し', `苗木 ${result.planted} 個`, rest))
    } catch (err) {
      // 中止した場合は知らせない。植えた場所は、次の指示で対象から外れる
      if (signal.aborted) return
      console.error('植え直しに失敗しました:', err)
      this.report(message.failed('植え直し', err.message))
    }
  }

  // BOT の周りの木を、指定した本数だけ切る。結果は、終わり次第 report で知らせる
  fell(count) {
    if (!Number.isInteger(count) || count < 1 || count > TREE_LIMIT) return [`本数は 1 から ${TREE_LIMIT} で指定してください`]
    const key = this.worldKey
    const world = this.store.get(key)
    this.navigator.cancel()
    const task = { type: 'fell', abort: new AbortController(), busy: true }
    this.task = task
    task.done = this.runFell(key, world, count, task.abort.signal).finally(() => {
      this.task = null
    })
    return [message.start('伐採', `周りの木 ${count} 本`, '中止するには sort stop と発言してください')]
  }

  async runFell(key, world, count, signal) {
    // 木を探す範囲は、今いる場所を中心にする（指定チェストの範囲ではない）
    const center = this.bot.entity.position.floored()
    const context = { bot: this.bot, navigator: this.navigator, signal, center, failed: [], notify: this.report }
    // 斧を作るときは、範囲内にある作業台を使う。新しくは置かない
    let table
    context.getTable = async () => (table ??= await findTable(context))
    try {
      const result = await this.feller(context, count, {
        pending: world.replant ?? [],
        savePending: (spots) => this.saveReplant(key, spots)
      })
      const lines = [
        result.trees < count
          ? message.stopped(
              '伐採',
              result.exhausted ? '周りに切れる木が残っていません' : '持ち物の空きがなくなりました',
              `切ったのは ${result.trees} 本、原木 ${result.logs} 個`
            )
          : message.done('伐採', `${result.trees} 本`, `原木 ${result.logs} 個`)
      ]
      if (result.tall > 0) lines.push(`大きすぎて切らなかった木: ${result.tall} 本`)
      if (result.barehanded) lines.push('斧を用意できなかったため、素手で切りました')
      if (result.pending.length > 0) {
        lines.push(`植え直していない場所が ${result.pending.length} か所あります（植え直すには sort replant と発言してください）`)
      }
      for (const line of lines) this.report(line)
    } catch (err) {
      // 中止した場合は知らせない。切った場所は記録してある
      if (signal.aborted) return
      console.error('伐採に失敗しました:', err)
      this.report(message.failed('伐採', err.message))
    }
  }

  // 移動の経過と結果は、終わり次第 report で知らせる
  come(username) {
    this.navigator.come(username, this.report).catch((err) => {
      console.error('移動に失敗しました:', err)
      this.report(message.failed('移動', err.message))
    })
    return []
  }

  position() {
    return [`現在地: ${formatPosition(this.bot.entity.position.floored())}`]
  }

  status() {
    const { source, excluded, running, replant: pending = [] } = this.store.get(this.worldKey)
    const sourceText = source ? `${formatChest(source.positions)}${source.auto ? '（自動）' : ''}` : '未登録'
    const activity = this.task ? `${TASK_NAMES[this.task.type]}中` : '待機中'
    const lines = [message.state(activity), `指定チェスト: ${sourceText}${running ? '（整理を開始しています）' : ''}`, `除外したチェスト: ${excluded.length} 個`]
    if (excluded.length > 0) lines[2] += `（${excluded.map(formatChest).join('、')}）`
    if (pending.length > 0) lines.push(`植え直していない場所: ${pending.length} か所`)
    return lines
  }
}

module.exports = { SortController }
