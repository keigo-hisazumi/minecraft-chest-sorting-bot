// 振り分けの計画を、チャット向けの要約と、ファイル向けの詳細な文にする

const { formatChest } = require('./chests')
const { formatPosition, message } = require('./messages')

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
    message.done('調査', `チェスト ${plan.chestCount} 個、アイテム ${plan.itemKinds} 種類`),
    `専用 ${plan.dedicated.length} 種類 / 混合 ${plan.mixed.items.length} 種類（混合チェスト ${plan.mixed.chests.length} 個） / 保護対象チェスト ${plan.protected.chests.length} 個`,
    `必要な作業: 新しい大きなチェスト ${plan.newChests} 個、単体チェストの拡張 ${plan.expansions.length} 個${planksText}`,
    plan.discard.length > 0 ? `廃棄予定: ${shorten(plan.discard.map((d) => `${d.name} ${d.count} 個`))}` : '廃棄予定: なし'
  ]
  if (failed.length > 0) {
    lines.push(`調査できなかったチェスト（計画に含みません）: ${shorten(failed.map((f) => `${formatPosition(f.positions[0])} ${f.reason}`))}`)
  }
  lines.push('アイテムは動かしていません（詳しい計画は data/plan.txt を確認してください）')
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
  const lines = [message.done('整理', result.delivered > 0 ? `合計 ${result.delivered} 個` : '移せるアイテムはありません')]
  const {
    expanded = 0,
    created = 0,
    tablePlaced = false,
    trees = 0,
    logs = 0,
    notes = [],
    problems = []
  } = result.build ?? {}
  if (trees > 0) lines.push(message.done('伐採', `${trees} 本`, `原木 ${logs} 個`))
  lines.push(...notes)
  const placed = [
    ...(created > 0 ? [`大きなチェスト ${created} 個`] : []),
    ...(expanded > 0 ? [`単体チェストを広げる分 ${expanded} 個`] : []),
    ...(tablePlaced ? ['作業台'] : [])
  ]
  if (placed.length > 0) lines.push(message.done('設置', placed.join('、')))
  lines.push(...problems)
  const { discarded = {}, remaining = 0, problem = null } = result.discard ?? {}
  const thrown = Object.entries(discarded).map(([name, count]) => `${name} ${count} 個`)
  if (thrown.length > 0) lines.push(message.done('廃棄', shorten(thrown)))
  if (problem) lines.push(problem)
  if (remaining > 0) lines.push(`廃棄する予定の ${remaining} 個が残っています`)
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
