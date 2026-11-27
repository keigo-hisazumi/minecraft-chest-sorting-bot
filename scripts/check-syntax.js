// src/ と scripts/ 配下の JavaScript ファイルの構文を検査する（CI の build で実行）
// BOT はビルド成果物を持たないため、構文エラーの検出を build の代わりにする

const { readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const roots = ['src', 'scripts']

const collect = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return collect(path)
    return path.endsWith('.js') ? [path] : []
  })

const files = roots.flatMap(collect)
let failed = 0

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    failed++
    console.error(`構文エラー: ${file}\n${err.stderr}`)
  }
}

console.log(`${files.length} ファイルを検査しました（エラー ${failed} 件）`)
process.exit(failed > 0 ? 1 : 0)
