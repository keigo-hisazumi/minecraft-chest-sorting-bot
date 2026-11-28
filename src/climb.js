// 大きな木の伐採（幹の柱を登って切る）
// 地上から手が届かない高い原木は、切り終えた幹の跡にブロックを積んで登り、手の届く原木から切る。
// 積んだブロックは、切り終えたら上から順に掘って降り、跡に残さない。
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

const { Vec3 } = require('vec3')
const { isNaturalLeaves } = require('./trees')

// 根元から登ってよい高さ（ブロック）。ワールドの高さ（-64〜320）いっぱいまで登れるようにする
const MAX_CLIMB = 384
// ジャンプして、足元にブロックを置ける高さに届くまで待つ時間（tick）
const JUMP_TICKS = 20
// 着地するまで待つ時間（tick）
const LAND_TICKS = 20
// ブロックの中央へ寄るまで待つ時間（tick）
const CENTER_TICKS = 40
// ブロックの中央とみなす、水平のずれ（体の幅 0.6 が、隣の列にかからない大きさ）
const CENTER_TOLERANCE = 0.15

const UP = new Vec3(0, 1, 0)
// ブロックを置くと、置いたブロックに置き換わる草（マインクラフトの replaceable）
const REPLACEABLE_PLANTS = [
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'short_dry_grass',
  'tall_dry_grass',
  'bush',
  'vine',
  'glow_lichen',
  'hanging_roots',
  'crimson_roots',
  'warped_roots',
  'nether_sprouts'
]
// 当たり判定がなく、素手ですぐ刈れる草花。足場を置く場所にあれば、先に刈る（花は置き換わらないため）
// 苗木は、植え直した物かもしれないため含めない
const PLANTS = new Set([
  ...REPLACEABLE_PLANTS,
  'dandelion',
  'poppy',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'torchflower',
  'closed_eyeblossom',
  'open_eyeblossom',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony',
  'pink_petals',
  'wildflowers',
  'leaf_litter',
  'firefly_bush',
  'brown_mushroom',
  'red_mushroom'
])
const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
// 当たり判定のない草花か
const isPlant = (block) => Boolean(block) && PLANTS.has(block.name)

// 条件が満たされるまで、1 tick ずつ待つ
async function waitUntil(bot, condition, ticks) {
  for (let i = 0; i < ticks; i++) {
    if (condition()) return true
    await bot.waitForTicks(1)
  }
  return condition()
}

/**
 * 立っているブロックの中央へ寄る
 * 体が隣の列にかかったままジャンプすると、幹の周りの葉や原木に頭がぶつかり、足元にブロックを置ける高さまで跳べない。
 * 経路探索は、ブロックの端に体がかかった位置で到着とするため、登る前に中央へ寄せる。
 * しゃがんだまま歩くため、柱の上でも落ちない。
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<boolean>} 中央に寄れたか
 */
async function centerOnBlock(bot) {
  const offset = () => {
    const p = bot.entity.position
    return Math.hypot(Math.floor(p.x) + 0.5 - p.x, Math.floor(p.z) + 0.5 - p.z)
  }
  if (offset() < CENTER_TOLERANCE) return true
  const cell = bot.entity.position.floored()
  bot.setControlState('sneak', true)
  try {
    for (let i = 0; i < CENTER_TICKS && offset() >= CENTER_TOLERANCE; i++) {
      const p = bot.entity.position
      await bot.lookAt(new Vec3(cell.x + 0.5, p.y + 1.6, cell.z + 0.5), true)
      bot.setControlState('forward', true)
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('sneak', false)
  }
  await bot.waitForTicks(2)
  return offset() < CENTER_TOLERANCE
}

/**
 * その場でジャンプして、足元にブロックを置き、1 段高くなる
 * 手に置くブロックを持っておくこと。
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<import('vec3').Vec3 | null>} 置いた座標。置けなかったら null
 */
async function towerUp(bot) {
  const start = bot.entity.position.floored()
  const below = bot.blockAt(start.offset(0, -1, 0))
  if (!below || isAir(below) || isPlant(below)) return null
  // 足元の草花は、先に刈る。花などは、ブロックを置いても置き換わらず、足場を置けないため
  if (!(await clearPlant(bot, start))) return null
  if (!(await centerOnBlock(bot))) return null
  bot.setControlState('jump', true)
  try {
    if (!(await waitUntil(bot, () => bot.entity.position.y >= start.y + 1, JUMP_TICKS))) return null
    await bot.placeBlock(below, UP)
  } catch (err) {
    console.error(`足場を ${start} に置けませんでした:`, err.message)
    return null
  } finally {
    bot.setControlState('jump', false)
  }
  await waitUntil(bot, () => bot.entity.onGround, LAND_TICKS)
  const placed = bot.blockAt(start)
  return isAir(placed) || isPlant(placed) ? null : start
}

/**
 * 指定したマスに草花があれば刈る
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} position マス
 * @returns {Promise<boolean>} 草花がなくなっていれば true
 */
async function clearPlant(bot, position) {
  const block = bot.blockAt(position)
  if (!isPlant(block)) return true
  try {
    await bot.dig(block, true)
  } catch (err) {
    console.error(`(${position.x}, ${position.y}, ${position.z}) の ${block.name} を刈れませんでした:`, err.message)
  }
  return !isPlant(bot.blockAt(position))
}

/**
 * 積んだブロックを、上から順に掘って降りる
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Array<import('vec3').Vec3>} placed 積んだ座標（下から順）
 * @param {(block: object) => Promise<void>} dig ブロックを掘る関数
 */
async function descend(bot, placed, dig) {
  for (const position of [...placed].reverse()) {
    const block = bot.blockAt(position)
    if (isAir(block)) continue
    try {
      await dig(block)
    } catch (err) {
      // 掘れなければ、ブロックは残る（素手でも掘れるため、通常は起きない）
      console.error(`積んだブロック (${position.x}, ${position.y}, ${position.z}) を掘れませんでした:`, err.message)
      return
    }
    await waitUntil(bot, () => bot.entity.onGround && bot.entity.position.y < position.y + 0.5, LAND_TICKS)
  }
}

/**
 * 幹の跡（根元の原木を切った場所）に立った状態から、柱を積んで登り、残った原木を切る
 * 切り終えるか、登れなくなるか、中止されたら、積んだブロックを掘って根元へ降りる。
 *
 * @param {import('mineflayer').Bot} bot 根元の原木の跡に立っている BOT
 * @param {{ type: string, logs: Array<import('vec3').Vec3>, base: Array<import('vec3').Vec3> }} tree 木（analyzeTree の結果）
 * @param {object} ops
 * @param {(block: object) => Promise<void>} ops.dig ブロックを掘る関数（道具の持ち替えを含む）
 * @param {() => Promise<boolean>} ops.holdBlock 積むブロックを手に持つ関数。持てなければ false
 * @param {() => boolean} [ops.isCancelled] 中止されたかを返す
 * @param {(reason: string) => void} [ops.onStop] 原木を残したまま登るのをやめたときに、理由を渡して呼ぶ
 * @returns {Promise<number>} 切った原木の数
 */
async function cutFromTrunk(bot, tree, { dig, holdBlock, isCancelled = () => false, onStop = () => {} }) {
  const name = `${tree.type}_log`
  const placed = []
  // 積んだブロックは、同じ原木でも切る対象にしない
  const isPlaced = (p) => placed.some((q) => q.equals(p))
  const remaining = () => tree.logs.filter((p) => !isPlaced(p) && bot.blockAt(p)?.name === name)
  const [column] = tree.base
  let cut = 0
  try {
    while (!isCancelled()) {
      // 手が届く原木を切る
      let progress = false
      for (const position of remaining()) {
        if (isCancelled()) break
        const block = bot.blockAt(position)
        if (!bot.canDigBlock(block)) continue
        await dig(block)
        if (bot.blockAt(position)?.name !== name) {
          cut++
          progress = true
        }
      }
      const left = remaining()
      if (left.length === 0 || progress) {
        if (left.length === 0) break
        continue
      }
      // 手が届かないので、1 段登る。頭の上をふさぐ原木と自然の葉は掘る
      const feet = bot.entity.position.floored()
      const top = Math.max(...left.map((p) => p.y))
      const stop = (reason) => onStop(reason)
      if (feet.y >= top) {
        stop('幹から手が届かない位置にあります')
        break
      }
      if (feet.y - column.y >= MAX_CLIMB) {
        stop(`登れる高さ（${MAX_CLIMB} ブロック）を超えます`)
        break
      }
      const head = bot.blockAt(feet.offset(0, 2, 0))
      if (!isAir(head)) {
        if (head.name !== name && !isNaturalLeaves(head)) {
          stop(`頭の上に ${head.name} があります`)
          break
        }
        await dig(head)
        if (!isAir(bot.blockAt(feet.offset(0, 2, 0)))) {
          stop('頭の上のブロックを掘れません')
          break
        }
        if (head.name === name) cut++
      }
      if (!(await holdBlock())) {
        stop('足場にするブロックを持っていません')
        break
      }
      const position = await towerUp(bot)
      if (!position) {
        stop('足場を置けません')
        break
      }
      placed.push(position)
    }
  } finally {
    await descend(bot, placed, dig)
  }
  return cut
}

/**
 * 原木の真下の地面で、柱を積み始める場所を探す
 * 幹から手が届かない原木（横に張り出した枝など）は、真下から柱を積んで切る。
 * 原木から下へたどり、空気と自然の葉と草を抜けた先の最初のブロックの上を返す。
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} position 切りたい原木の座標
 * @returns {import('vec3').Vec3 | null} 柱を積み始める場所（立つ場所）。地面が遠すぎるか、見つからなければ null
 */
function findPillarSpot(bot, position) {
  for (let y = position.y - 1; y >= position.y - MAX_CLIMB; y--) {
    const block = bot.blockAt(new Vec3(position.x, y, position.z))
    if (!block) return null
    if (isAir(block) || isNaturalLeaves(block) || isPlant(block)) continue
    // 液体の上には立てない
    if (block.name === 'water' || block.name === 'lava') return null
    return new Vec3(position.x, y + 1, position.z)
  }
  return null
}

module.exports = { MAX_CLIMB, REPLACEABLE_PLANTS, isAir, isPlant, clearPlant, centerOnBlock, towerUp, descend, cutFromTrunk, findPillarSpot }
