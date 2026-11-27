// 振り分けの計画を、チャット向けの要約と、ファイル向けの詳細な文にする

const { formatPosition, formatChest } = require('./chests')

// チャットに名前を並べる件数の上限（発言が多いと、サーバーに切断されるため要約する）
const CHAT_LIST_LIMIT = 3

function shorten(texts) {
  const rest = texts.length - CHAT_LIST_LIMIT
  return texts.slice(0, CHAT_LIST_LIMIT).join('、') + (rest > 0 ? ` ほか ${rest} 件` : '')
}

const target = (chest) => (chest ? formatChest(chest) : '新しいチェスト')

/**
 * チャットで知らせる要約を作る
 *
 * @param {object} plan buildPlan の結果
 * @param {Array<{ positions: Array<object>, reason: string }>} failed 調査できなかったチェスト
 * @returns {string[]} 発言する文
 */
function formatSummary(plan, failed) {
  const planksText = plan.planks > 0 ? `（板材 ${plan.planks} 枚。作業台がなければ追加で 4 枚）` : ''
  const lines = [
    `調査完了: チェスト ${plan.chestCount} 個、アイテム ${plan.itemKinds} 種類`,
    `専用 ${plan.dedicated.length} 種類 / 混合 ${plan.mixed.items.length} 種類（混合チェスト ${plan.mixed.chests.length} 個） / 保護対象チェスト ${plan.protected.chests.length} 個`,
    `必要な作業: 新しい大きなチェスト ${plan.newChests} 個、単体チェストの拡張 ${plan.expansions.length} 個${planksText}`,
    plan.discard.length > 0 ? `廃棄予定: ${shorten(plan.discard.map((d) => `${d.name} ${d.count} 個`))}` : '廃棄予定: なし'
  ]
  if (failed.length > 0) {
    lines.push(`調査できなかったチェスト（計画に含みません）: ${shorten(failed.map((f) => `${formatPosition(f.positions[0])} ${f.reason}`))}`)
  }
  lines.push('アイテムは動かしていません。詳しい計画は data/plan.txt を確認してください')
  return lines
}

/**
 * ファイルに残す詳しい計画を作る
 *
 * @param {object} plan buildPlan の結果
 * @param {Array<{ positions: Array<object>, reason: string }>} failed 調査できなかったチェスト
 * @returns {string} 計画の文
 */
function formatDetail(plan, failed) {
  const section = (title, lines) => [`[${title}]`, ...(lines.length > 0 ? lines : ['なし']), '']
  return [
    ...formatSummary(plan, failed),
    '',
    ...section(
      '専用チェスト',
      plan.dedicated.map((d) => {
        const overflow = d.protectedOverflow > 0 ? `、保護対象チェストへ ${d.protectedOverflow} 個` : ''
        const discard = d.discard > 0 ? `、廃棄 ${d.discard} 個` : ''
        return `${d.name}: 合計 ${d.total} 個 → ${target(d.chest)}${overflow}${discard}`
      })
    ),
    ...section('混合チェスト', plan.mixed.chests.map(target)),
    ...section(
      '混合チェストに入れるアイテム',
      plan.mixed.items.map((i) => `${i.name}: ${i.total} 個`)
    ),
    ...section('保護対象チェスト', plan.protected.chests.map(target)),
    ...section(
      '廃棄予定',
      plan.discard.map((d) => `${d.name}: ${d.count} 個`)
    ),
    ...section('大きなチェストに広げる単体チェスト', plan.expansions.map(formatChest)),
    ...section(
      '調査できなかったチェスト',
      failed.map((f) => `${formatChest(f.positions)}: ${f.reason}`)
    )
  ].join('\n')
}

/**
 * 整理の結果を、チャットで知らせる文にする
 *
 * @param {object} result sortOnce の結果
 * @returns {string[]} 発言する文
 */
function formatResult(result) {
  const lines = [result.delivered > 0 ? `整理しました: ${result.delivered} 個を移しました` : '移せるアイテムはありません']
  const {
    expanded = 0,
    created = 0,
    tablePlaced = false,
    trees = 0,
    logs = 0,
    pendingReplant = 0,
    notes = [],
    problems = []
  } = result.build ?? {}
  if (trees > 0) lines.push(`木を ${trees} 本伐採して原木 ${logs} 個を集めました`)
  if (pendingReplant > 0) lines.push(`植え直していない場所が ${pendingReplant} か所あります。植え直すには sort replant と発言してください`)
  lines.push(...notes)
  const done = [
    ...(created > 0 ? [`大きなチェストを ${created} 個置きました`] : []),
    ...(expanded > 0 ? [`単体チェストを ${expanded} 個広げました`] : []),
    ...(tablePlaced ? ['作業台を置きました'] : [])
  ]
  if (done.length > 0) lines.push(done.join('。'))
  lines.push(...problems)
  if (result.shortage.length > 0) lines.push(`専用にする大きなチェストが足りないため残しています: ${shorten(result.shortage)}`)
  if (result.missingChests > 0) lines.push(`混合または保護対象のチェストが ${result.missingChests} 個足りません`)
  if (result.sourceItems > 0) lines.push(`指定チェストに ${result.sourceItems} 個残っています`)
  if (result.misplaced > 0) lines.push(`整理先に、移しきれないアイテムが ${result.misplaced} 枠あります`)
  if (result.carried > 0) lines.push(`BOT が ${result.carried} 個持ったままです`)
  if (result.failed.length > 0) {
    lines.push(`使えなかったチェスト: ${shorten(result.failed.map((f) => `${formatPosition(f.positions[0])} ${f.reason}`))}`)
  }
  return lines
}

module.exports = { formatSummary, formatDetail, formatResult }
