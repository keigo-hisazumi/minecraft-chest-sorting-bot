// サボテンへの投てき
// サボテンに触れない場所に立ち、アイテムを投げて当て、消えたことを確かめる。BOT はサボテンを置かない。

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { isInRange } = require('./chests')

// 立つ場所の、サボテンからの距離（ブロック）。間に 1 マス空ける
const THROW_DISTANCE = 2
// 投げたアイテムの、足元からの高さと速さ（ゲームの値）
const THROW_HEIGHT = 1.32
const THROW_SPEED = 0.3
const THROW_LIFT = 0.1
const GRAVITY = 0.04
const DRAG = 0.98
// サボテンの中で狙う高さ（ブロック）
const AIM_HEIGHT = 0.6
// 投げたアイテムが消えるのを待つ時間（tick）
const RESULT_WAIT_TICKS = 60
// 消えずに残ったとみなして探す、サボテンからの距離（ブロック）
const LEFTOVER_DISTANCE = 6

const AIR = new Set(['air', 'cave_air', 'void_air'])
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const UP = new Vec3(0, 1, 0)
const DOWN = new Vec3(0, -1, 0)

const isAir = (block) => Boolean(block) && AIR.has(block.name)
const isFloor = (block) =>
  block?.name !== 'cactus' && block?.boundingBox === 'block' && block.shapes?.length === 1 && block.shapes[0].join() === '0,0,0,1,1,1'

// サボテンの隣（斜めを含む）は、触れることがあるため立たない
function touchesCactus(blockAt, position) {
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = 0; y <= 1; y++) {
        if (blockAt(position.offset(x, y, z))?.name === 'cactus') return true
      }
    }
  }
  return false
}

/**
 * 1 本のサボテンに向かって投げる場所を返す
 *
 * @param {(position: Vec3) => object | null} blockAt
 * @param {Vec3} cactus サボテンの一番下の座標
 * @returns {Array<{ cactus: Vec3, stand: Vec3 }>} 立つ場所の候補
 */
function throwSites(blockAt, cactus) {
  return DIRECTIONS.flatMap((direction) => {
    const between = cactus.plus(direction)
    const stand = cactus.plus(direction.scaled(THROW_DISTANCE))
    const clear = [between, between.plus(UP), stand, stand.plus(UP)].every((p) => isAir(blockAt(p)))
    return clear && isFloor(blockAt(stand.plus(DOWN))) && !touchesCactus(blockAt, stand) ? [{ cactus, stand }] : []
  })
}

/**
 * 範囲内のサボテンから、投げる場所を 1 つ選ぶ
 *
 * @returns {{ site: { cactus: Vec3, stand: Vec3 } | null, found: boolean }} found はサボテンがあったかどうか
 */
function findThrowSite(bot, center) {
  const id = bot.registry.blocksByName.cactus?.id
  if (id === undefined) return { site: null, found: false }
  const origin = new Vec3(center.x, center.y, center.z)
  const bases = bot
    .findBlocks({ matching: id, point: origin, maxDistance: 48, count: 256 })
    .filter((p) => bot.blockAt(p)?.name === 'cactus' && bot.blockAt(p.plus(DOWN))?.name !== 'cactus' && isInRange(center, p))
    .sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b))
  const sites = bases.flatMap((base) => throwSites((p) => bot.blockAt(p), base)).filter((s) => isInRange(center, s.stand))
  return { site: sites[0] ?? null, found: bases.length > 0 }
}

/**
 * 狙う高さを通るように、投げる角度を選ぶ
 *
 * @param {number} distance サボテンの中心までの水平の距離
 * @param {number} height 足元から見た、狙う高さ
 * @returns {number} 縦の角度（上が正）
 */
function aimPitch(distance, height) {
  let best = 0
  let error = Infinity
  for (let pitch = -0.7; pitch <= 0.5; pitch += 0.01) {
    let x = 0
    let y = THROW_HEIGHT
    let speedX = THROW_SPEED * Math.cos(pitch)
    let speedY = THROW_SPEED * Math.sin(pitch) + THROW_LIFT
    // サボテンの手前の面に届くまで進める
    for (let tick = 0; tick < 60 && x < distance - 0.5; tick++) {
      speedY -= GRAVITY
      x += speedX
      y += speedY
      speedX *= DRAG
      speedY *= DRAG
    }
    const difference = x < distance - 0.5 ? Infinity : Math.abs(y - height)
    if (difference < error) {
      best = pitch
      error = difference
    }
  }
  return best
}

// 落ちているアイテムのうち、指定した種類で、サボテンの近くにあるもの
function leftovers(bot, name, cactus) {
  return Object.values(bot.entities).filter(
    (e) => e.name === 'item' && e.position.distanceTo(cactus) <= LEFTOVER_DISTANCE && e.getDroppedItem()?.name === name
  )
}

/**
 * サボテンに向かって、BOT のインベントリの 1 枠分を投げる
 *
 * @param {object} context bot と navigator
 * @param {{ cactus: Vec3, stand: Vec3 }} site 投げる場所
 * @param {number} slot 投げる枠
 * @returns {Promise<'destroyed' | 'remains' | 'collected' | 'unconfirmed' | 'unreachable'>}
 *   destroyed は消えたことを確かめた場合。unreachable は投げていない
 */
async function tossIntoCactus({ bot, navigator, signal }, { cactus, stand }, slot) {
  const moved = await navigator.moveTo(new goals.GoalBlock(stand.x, stand.y, stand.z))
  signal.throwIfAborted()
  if (moved.status !== 'arrived') return 'unreachable'
  const dx = cactus.x + 0.5 - bot.entity.position.x
  const dz = cactus.z + 0.5 - bot.entity.position.z
  const pitch = aimPitch(Math.hypot(dx, dz), cactus.y + AIM_HEIGHT - bot.entity.position.y)
  await bot.look(Math.atan2(-dx, -dz), pitch, true)
  await bot.waitForTicks(5)
  signal.throwIfAborted()

  const item = bot.inventory.slots[slot]
  const spawned = []
  const collected = new Set()
  const gone = new Set()
  const onSpawn = (entity) => {
    if (entity.name === 'item' && entity.position.distanceTo(bot.entity.position) <= 3) spawned.push(entity)
  }
  const onCollect = (collector, entity) => collected.add(entity.id)
  const onGone = (entity) => gone.add(entity.id)
  bot.on('entitySpawn', onSpawn)
  bot.on('playerCollect', onCollect)
  bot.on('entityGone', onGone)
  try {
    await bot.tossStack(item)
    const thrown = () => spawned.find((e) => e.getDroppedItem()?.name === item.name)
    for (let ticks = 0; ticks < RESULT_WAIT_TICKS && !gone.has(thrown()?.id); ticks += 2) await bot.waitForTicks(2)
    await bot.waitForTicks(5)
    const entity = thrown()
    // 投げたアイテムを確認できなければ、消えたとはみなさない
    if (!entity) return 'unconfirmed'
    if (collected.has(entity.id)) return 'collected'
    // 近くの同じアイテムにまとまると、投げた分が消えたように見えるため、残っていないことも確かめる
    return gone.has(entity.id) && leftovers(bot, item.name, cactus).length === 0 ? 'destroyed' : 'remains'
  } finally {
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('playerCollect', onCollect)
    bot.removeListener('entityGone', onGone)
  }
}

module.exports = { findThrowSite, throwSites, aimPitch, leftovers, tossIntoCactus }
