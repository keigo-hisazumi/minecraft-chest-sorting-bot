// 廃棄
// 専用チェストが満杯になったアイテムのうち、保護対象でないものをサボテンに投げて消し、記録する。
// 廃棄したアイテムは元に戻せないため、確かめられないことがあれば捨てない。

const fs = require('node:fs')
const path = require('node:path')
const { goals } = require('mineflayer-pathfinder')
const { findThrowSite, leftovers, tossIntoCactus } = require('./cactus')
const { formatPosition, message } = require('./messages')
const { describeItem } = require('./items')
const { hasRoom, evictableStacks } = require('./moves')
const { storeStack } = require('./store')
const { cargoStacks, emptyCargoSlots, hotbarSlots, refresh, moveStack, release, withChest } = require('./window')

// 続けて失敗したら、その回の廃棄をやめる回数
const MAX_FAILURES = 3
// 取り出すときに、空けておく荷物の枠の数
const RESERVED_SLOTS = 3
// 記録に書く、投げた結果
const RESULT_LABELS = {
  destroyed: '廃棄',
  remains: '未確認',
  collected: '拾い直し',
  unconfirmed: '未確認',
  unreachable: '投てきせず'
}

const total = (stacks) => stacks.reduce((sum, s) => sum + s.count, 0)

/**
 * 捨てる対象かを判定する
 * 専用チェストがあるアイテムで、保護対象でなく、専用チェストに入れる空きがない場合だけ対象にする。
 *
 * @param {object} layout 割り当て
 * @param {object | null} chest アイテムがあるチェスト。BOT が持っている場合は null
 * @param {object} stack アイテム
 */
function isDiscardable(layout, chest, stack) {
  const dedicated = layout.dedicated.get(stack.name)
  if (!dedicated || dedicated.unavailable || dedicated === chest || stack.protected) return false
  // 空き枠か足せるスタックがある場合と、よそへ移すアイテムを出せば空く場合は、捨てない
  return !hasRoom(dedicated, stack) && evictableStacks(layout, dedicated).length === 0
}

const candidatesIn = (layout, chest) => [...chest.slots.values()].filter((s) => isDiscardable(layout, chest, s))
const heldCandidates = ({ bot, layout }) => cargoStacks(bot.inventory).filter((s) => isDiscardable(layout, null, s))

/**
 * 専用チェストを開き直して、入るものは入れ、捨てる枠を決める
 *
 * @returns {Promise<Array<{ slot: number, name: string, count: number }> | null>} 捨てる枠。チェストを開けなければ null
 */
async function confirmFull(context, dedicated, name) {
  const { bot, layout } = context
  return withChest(context, dedicated, async (window) => {
    // 荷物の枠の番号は画面ごとに違うため、BOT のインベントリの番号に直して返す
    const offset = bot.inventory.inventoryStart - window.inventoryStart
    let blocked = false
    for (const held of cargoStacks(window).filter((s) => s.name === name && !s.protected)) {
      await storeStack(context, window, dedicated, held.slot)
      while (window.slots[held.slot]) {
        // 専用チェストにある保護対象は、保護対象チェストへ移して、捨てずに済む分を増やす
        const guarded = [...dedicated.slots.values()].find((s) => s.name === name && s.protected)
        if (!guarded) break
        const room = layout.protected.some((c) => !c.unavailable && hasRoom(c, guarded))
        const empty = emptyCargoSlots(window)[0]
        if (!room || empty === undefined || (await moveStack(bot, window, guarded.slot, empty)) === 0) {
          blocked = true
          break
        }
        refresh(dedicated, window)
        await storeStack(context, window, dedicated, held.slot)
      }
    }
    if (blocked) return []
    return cargoStacks(window)
      .filter((s) => s.name === name && isDiscardable(layout, null, s))
      .map((s) => ({ slot: s.slot + offset, name: s.name, count: s.count }))
  })
}

const record = (logFile, result, name, count) => fs.appendFileSync(logFile, `${new Date().toISOString()}\t${result}\t${name}\t${count}\n`)

// 消えずに残ったアイテムを拾い直す
async function pickUp(context, name, cactus) {
  const { bot, navigator, signal } = context
  const empty = new Set(hotbarSlots(bot.inventory).filter((slot) => !bot.inventory.slots[slot]))
  for (const entity of leftovers(bot, name, cactus)) {
    const { x, y, z } = entity.position.floored()
    await navigator.moveTo(new goals.GoalNear(x, y, z, 1))
    signal.throwIfAborted()
    await bot.waitForTicks(40)
  }
  // ホットバーに入った分は、荷物へ戻す
  await release(bot, (item, slot) => empty.has(slot) && item.name === name)
  return leftovers(bot, name, cactus)
}

// 持っている捨てる対象を、専用チェストごとに確かめてから投げる。投げた回数を返す
async function discardHeld(context, state) {
  const { bot, layout, signal, notify } = context
  const { site, logFile, result, toss } = state
  let attempts = 0
  for (const name of new Set(heldCandidates(context).map((s) => s.name))) {
    signal.throwIfAborted()
    const targets = await confirmFull(context, layout.dedicated.get(name), name)
    if (!targets || targets.length === 0) continue
    notify(message.start('廃棄', `${name} ${total(targets)} 個`))
    for (const target of targets) {
      signal.throwIfAborted()
      // 投げる直前にも、同じアイテムで保護対象でないことを確かめる
      const item = bot.inventory.slots[target.slot]
      const current = item && describeItem(item)
      if (!current || current.name !== target.name || current.count !== target.count || current.protected) continue
      // 記録せずに捨てることがないように、投げる前にも書く。書けなければ例外になり、投げない
      record(logFile, '投てき開始', name, target.count)
      let outcome = 'unconfirmed'
      try {
        outcome = await toss(context, site, target.slot)
      } finally {
        // 投げたあとに中断しても、結果は残す
        record(logFile, RESULT_LABELS[outcome], name, target.count)
      }
      if (outcome === 'unreachable') {
        result.problem = message.failed('廃棄', 'サボテンの近くへ行けません')
        return attempts
      }
      attempts++
      result.changed = true
      if (outcome === 'destroyed') {
        result.discarded[name] = (result.discarded[name] ?? 0) + target.count
        state.failures = 0
        continue
      }
      state.failures++
      const left = await pickUp(context, name, site.cactus)
      if (left.length > 0) {
        result.problem = message.stopped('廃棄', `投げた ${name} が ${formatPosition(left[0].position.floored())} に残っています`)
        return attempts
      }
      if (state.failures >= MAX_FAILURES) {
        result.problem = message.stopped('廃棄', `${MAX_FAILURES} 回続けて消えたことを確認できません`)
        return attempts
      }
      // 拾い直した分は、次の回でもう一度確かめてから投げる
      return attempts
    }
  }
  return attempts
}

/**
 * 専用チェストに入りきらないアイテムを廃棄する
 *
 * @param {object} context bot、navigator、signal、layout、source、failed、notify
 * @param {object} options
 * @param {Array<object>} options.chests 整理先のチェスト
 * @param {{ x: number, y: number, z: number }} options.center 範囲の中心（指定チェスト）
 * @param {string} [options.logFile] 記録するファイル。なければ廃棄しない
 * @param {typeof tossIntoCactus} [options.toss] 投げる関数
 * @returns {Promise<{ discarded: Record<string, number>, remaining: number, problem: string | null, changed: boolean }>}
 *   remaining は、捨てる対象のまま残った個数。changed が true の場合は、荷物を片付ける必要がある
 */
async function discardOverflow(context, { chests, center, logFile, toss = tossIntoCactus }) {
  const { bot, layout, source, signal } = context
  const result = { discarded: {}, remaining: 0, problem: null, changed: false }
  const all = [source, ...chests]
  const waiting = () =>
    total(all.filter((c) => !c.unavailable).flatMap((c) => candidatesIn(layout, c))) + total(heldCandidates(context))
  const finish = (problem = result.problem) => ({ ...result, problem, remaining: waiting() })

  if (!logFile || waiting() === 0) return finish()
  const { site, found } = findThrowSite(bot, center)
  if (!site) return finish(found ? 'サボテンに向かって投げる場所がないため、廃棄しません' : '範囲内にサボテンがないため、廃棄しません')
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, '')
    // フォルダーなどは、空の追記が成功しても書けない
    if (!fs.statSync(logFile).isFile()) throw new Error('記録先がファイルではありません')
  } catch (err) {
    console.error('廃棄の記録を書けません:', err.message)
    return finish('廃棄の記録を書けないため、廃棄しません')
  }

  const state = { site, logFile, result, toss, failures: 0 }
  // 先に持っている分を、次に指定チェスト、整理先の順に処理する
  for (const chest of [null, ...all]) {
    for (;;) {
      signal.throwIfAborted()
      if (chest && !chest.unavailable && candidatesIn(layout, chest).length > 0) {
        result.changed = true
        await withChest(context, chest, async (window) => {
          for (const stack of candidatesIn(layout, chest)) {
            signal.throwIfAborted()
            const empty = emptyCargoSlots(window)
            if (empty.length <= RESERVED_SLOTS) break
            await moveStack(bot, window, stack.slot, empty[0])
            refresh(chest, window)
          }
          return true
        })
      }
      if (heldCandidates(context).length === 0) break
      // 投げられなくなった場合は、このチェストを終える。続けて失敗した回数は上限で止まる
      if ((await discardHeld(context, state)) === 0 || result.problem) break
    }
    if (result.problem) break
  }
  return finish()
}

module.exports = { discardOverflow, isDiscardable }
