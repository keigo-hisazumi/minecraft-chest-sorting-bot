// チャットコマンドの解釈
// 他の BOT と衝突しないように、すべて `sort` で始める。

const HELP = '使い方: sort start / sort stop / sort status / sort plan / sort come / sort pos / sort chest <x> <y> <z> / sort exclude <x> <y> <z>'

const SIMPLE_COMMANDS = new Set(['start', 'stop', 'status', 'plan', 'come', 'pos'])
const POSITION_COMMANDS = new Set(['chest', 'exclude'])

/**
 * チャットの発言をコマンドとして解釈する
 *
 * @param {string} message 発言
 * @returns {{ type: string, position?: { x: number, y: number, z: number } } | null}
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
  return { type: 'help' }
}

module.exports = { HELP, parseCommand }
