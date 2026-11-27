// チャットコマンドの解釈
// 他の BOT と衝突しないように、すべて `sort` で始める。

const HELP =
  '使い方: sort start / sort stop / sort status / sort plan / sort replant / sort fell [本数] / sort come / sort pos / sort chest <x> <y> <z> / sort exclude <x> <y> <z>'

const SIMPLE_COMMANDS = new Set(['start', 'stop', 'status', 'plan', 'replant', 'come', 'pos'])
const POSITION_COMMANDS = new Set(['chest', 'exclude'])
// 本数を 1 つ取るコマンド（本数は省略できる）
const COUNT_COMMANDS = new Set(['fell'])

/**
 * チャットの発言をコマンドとして解釈する
 *
 * @param {string} message 発言
 * @returns {{ type: string, position?: { x: number, y: number, z: number }, count?: number | null } | null}
 *   count が null なら、本数を指定していない
 *   BOT 宛てでない発言は null。`sort` で始まるが形が正しくない発言は type が help
 */
function parseCommand(message) {
  const [prefix, type, ...args] = message.trim().split(/\s+/)
  if (prefix !== 'sort') return null
  if (SIMPLE_COMMANDS.has(type) && args.length === 0) return { type }
  if (POSITION_COMMANDS.has(type) && args.length === 3 && args.every((a) => /^-?\d+$/.test(a))) {
    const [x, y, z] = args.map(Number)
    return { type, position: { x, y, z } }
  }
  if (COUNT_COMMANDS.has(type) && args.length === 0) return { type, count: null }
  if (COUNT_COMMANDS.has(type) && args.length === 1 && /^\d+$/.test(args[0])) return { type, count: Number(args[0]) }
  return { type: 'help' }
}

module.exports = { HELP, parseCommand }
