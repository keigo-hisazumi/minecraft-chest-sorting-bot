// 動けなくなったときの脱出（採掘 BOT とチェスト整理 BOT で共通）
// 1 ブロックの穴に落ちたときなど、経路探索だけでは登れない・進めない状態から抜け出す。
// - 周りを壁に囲まれた穴の中なら、足場を積んで登る。足元の草花は先に刈る（花などは、ブロックを置いても置き換わらないため）。
//   積むブロックがなければ、自然の地形のブロックを掘って段を作り、登る
// - 穴の中でなく、経路の途中で引っかかって止まったのなら、隣の空いているマスへ 1 歩よける
// 移動に失敗したら、これを行ってから移動をやり直す。
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

const { Vec3 } = require('vec3')
const { REPLACEABLE_PLANTS, centerOnBlock, clearPlant, isAir, isPlant, towerUp } = require('./climb')
const { formatPosition, message } = require('./messages')
const { LOG_NAMES } = require('./trees')

// 穴から登る高さの上限（ブロック）
const MAX_ESCAPE_HEIGHT = 16
// 1 マス歩くのにかける時間の上限（tick）
const STEP_TICKS = 30
// 着地するまで待つ時間（tick）
const LAND_TICKS = 20
// 穴から登るときに足場に積んでよいブロック（よい順）
const ESCAPE_BLOCK_NAMES = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', ...LOG_NAMES]
// 段を作るために掘ってよい、自然の地形のブロック
const NATURAL_GROUND = new Set([
  'dirt',
  'grass_block',
  'coarse_dirt',
  'podzol',
  'rooted_dirt',
  'mycelium',
  'mud',
  'clay',
  'sand',
  'red_sand',
  'gravel',
  'stone',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'calcite',
  'netherrack',
  'moss_block',
  'snow_block'
])
// 東西南北
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
]

const isLiquid = (block) => block?.name === 'water' || block?.name === 'lava'
// 体がぶつかるブロックか（空気、液体、草花、当たり判定のないブロックは通れる）
const isSolid = (block) => Boolean(block) && !isAir(block) && !isLiquid(block) && !isPlant(block) && block.boundingBox !== 'empty'

/**
 * 経路探索の移動ルールに、ブロックを置くと置き換わる草を加える
 * 経路探索は、足元に草があると、草を壊せないかぎり、足場を積んで登る経路を選ばない（1 ブロックの穴から出られなくなる）。
 *
 * @param {object} movements mineflayer-pathfinder の Movements
 * @param {object} registry minecraft-data のレジストリ
 * @returns {object} movements
 */
function allowPlantReplacement(movements, registry) {
  for (const name of REPLACEABLE_PLANTS) {
    const block = registry.blocksByName?.[name]
    if (block && block.boundingBox === 'empty') movements.replaceables?.add(block.id)
  }
  return movements
}

/**
 * 隣のマスへ、そのまま歩くか、1 段跳び上がって移れるかを返す
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} feet 足元のマス
 * @param {number[]} direction 向き [dx, dz]
 * @returns {'walk' | 'jump' | null} 移り方。移れなければ null
 */
function exitTo(blockAt, feet, [dx, dz]) {
  const side = (dy) => blockAt(feet.offset(dx, dy, dz))
  if (!isSolid(side(0)) && !isSolid(side(1))) return 'walk'
  if (isSolid(side(0)) && !isSolid(side(1)) && !isSolid(side(2)) && !isSolid(blockAt(feet.offset(0, 2, 0)))) return 'jump'
  return null
}

/**
 * 周りを壁に囲まれた穴の中にいるか（東西南北のどこへも、歩いても 1 段跳んでも移れない）
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} feet 足元のマス
 */
function isInPit(blockAt, feet) {
  return DIRECTIONS.every((direction) => exitTo(blockAt, feet, direction) === null)
}

/**
 * 穴の壁を掘って段を作る場所を探す
 * 隣のマスの、足の高さのブロックを段として残し、その上の 2 マスを掘れば、1 段跳び上がって移れる場所を返す。
 * 掘るのは自然の地形のブロックだけ（人が置いた物は掘らない）。
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} feet 足元のマス
 * @param {(position: Vec3) => boolean} [canDig] そのマスを掘ってよいか（BOT ごとの決まり）
 * @returns {{ step: Vec3, dig: Vec3[] } | null} 段の上に立つマスと、掘るマス
 */
function findStep(blockAt, feet, canDig = () => true) {
  if (isSolid(blockAt(feet.offset(0, 2, 0)))) return null
  for (const [dx, dz] of DIRECTIONS) {
    const side = (dy) => feet.offset(dx, dy, dz)
    if (!isSolid(blockAt(side(0)))) continue
    const cells = [side(1), side(2)]
    const ok = cells.every((p) => {
      const block = blockAt(p)
      return !isSolid(block) || (NATURAL_GROUND.has(block.name) && canDig(p))
    })
    // 掘った跡の上から、砂や砂利が落ちてこないこと
    const above = blockAt(side(3))
    if (!ok || above?.name === 'sand' || above?.name === 'red_sand' || above?.name === 'gravel') continue
    return { step: side(1), dig: cells.filter((p) => isSolid(blockAt(p))) }
  }
  return null
}

/**
 * 隣のマスへ、経路探索を使わずに移る（必要ならジャンプする）
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Vec3} target 移る先のマス（足元）
 * @param {boolean} jump ジャンプするか
 * @returns {Promise<boolean>} 移れたら true
 */
async function stepTo(bot, target, jump) {
  const center = new Vec3(target.x + 0.5, target.y, target.z + 0.5)
  const arrived = () => bot.entity.position.floored().equals(target)
  try {
    for (let i = 0; i < STEP_TICKS && !arrived(); i++) {
      await bot.lookAt(new Vec3(center.x, bot.entity.position.y + 1.6, center.z), true)
      bot.setControlState('forward', true)
      if (jump) bot.setControlState('jump', true)
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
  for (let i = 0; i < LAND_TICKS && !bot.entity.onGround; i++) await bot.waitForTicks(1)
  return arrived()
}

/**
 * 穴から登る。足場を積めるなら積んで、積めなければ自然の地形を掘って段を作って登る
 *
 * @returns {Promise<boolean>} 穴から出られたら true
 */
async function climbOutOfPit(bot, ops) {
  const blockAt = (p) => bot.blockAt(p)
  const start = bot.entity.position.floored()
  while (!ops.isCancelled()) {
    const feet = bot.entity.position.floored()
    if (!isInPit(blockAt, feet)) return true
    if (feet.y - start.y >= MAX_ESCAPE_HEIGHT) return false
    // 頭の上の草花（垂れ下がる根など）は刈る
    await clearPlant(bot, feet.offset(0, 2, 0))
    const head = bot.blockAt(feet.offset(0, 2, 0))
    if (!isSolid(head) && (await ops.holdBlock())) {
      if (await ops.tower(bot)) continue
    }
    const plan = findStep(blockAt, feet, ops.canDig)
    if (!plan) return false
    for (const position of plan.dig) {
      if (ops.isCancelled()) return false
      try {
        await ops.dig(bot.blockAt(position))
      } catch (err) {
        console.error(`段を作るために (${position.x}, ${position.y}, ${position.z}) を掘れませんでした:`, err.message)
        return false
      }
      if (isSolid(bot.blockAt(position))) return false
    }
    if (!(await stepTo(bot, plan.step, true))) return false
  }
  return false
}

/**
 * 隣の空いているマス（足元が固く、体が入る）へ 1 歩よける
 *
 * @returns {Promise<boolean>} よけられたら true
 */
async function stepAside(bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of DIRECTIONS) {
    const target = feet.offset(dx, 0, dz)
    const floor = bot.blockAt(target.offset(0, -1, 0))
    if (exitTo((p) => bot.blockAt(p), feet, [dx, dz]) !== 'walk' || !isSolid(floor)) continue
    if (await stepTo(bot, target, false)) return true
  }
  return false
}

/**
 * 動けなくなった状態から抜け出す。移動に失敗したときに呼び、抜け出せたら移動をやり直す
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} ops
 * @param {() => Promise<boolean>} ops.holdBlock 足場に積むブロックを手に持つ。なければ false
 * @param {(block: object) => Promise<void>} [ops.dig] ブロックを掘る（道具の持ち替えを含む）
 * @param {() => boolean} [ops.isCancelled] 中止されたかを返す
 * @param {(text: string) => void} [ops.notify] チャットへの通知
 * @param {(position: Vec3) => boolean} [ops.canDig] 段を作るために、そのマスを掘ってよいか（自然の地形のブロックに限ったうえで）
 * @param {boolean} [ops.stalled] 経路の途中で止まったために移動に失敗したか（穴の中でなければ、1 歩よける）
 * @param {(bot: object) => Promise<object | null>} [ops.tower] 1 段積んで登る（テスト用に差し替えられる）
 * @returns {Promise<boolean>} 抜け出せた（穴から出た、よけた）なら true
 */
async function escape(
  bot,
  {
    holdBlock,
    dig = (block) => bot.dig(block, true),
    canDig = () => true,
    isCancelled = () => false,
    notify = () => {},
    stalled = false,
    tower = towerUp
  }
) {
  const ops = { holdBlock, dig, canDig, isCancelled, tower }
  if (isCancelled() || bot.entity.isInWater || bot.entity.isInLava) return false
  for (let i = 0; i < LAND_TICKS && !bot.entity.onGround; i++) await bot.waitForTicks(1)
  const feet = bot.entity.position.floored()
  if (isInPit((p) => bot.blockAt(p), feet)) {
    const where = `穴の中 ${formatPosition(feet)}`
    notify(message.start('脱出', where, '動けなくなったため、登って抜け出します'))
    await centerOnBlock(bot)
    const out = await climbOutOfPit(bot, ops)
    if (out) notify(message.done('脱出', where))
    else if (!isCancelled()) notify(message.failed('脱出', where, '足場にするブロックがなく、掘って段を作れる壁もありません'))
    return out
  }
  return stalled && stepAside(bot)
}

module.exports = {
  ESCAPE_BLOCK_NAMES,
  MAX_ESCAPE_HEIGHT,
  NATURAL_GROUND,
  allowPlantReplacement,
  escape,
  exitTo,
  findStep,
  isInPit,
  isSolid
}
