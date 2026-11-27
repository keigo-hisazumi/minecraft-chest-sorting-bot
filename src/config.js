// 接続設定
// 環境変数（.env）から読み込み、未設定の項目はローカルのテスト用サーバー向けの既定値を使う

const path = require('node:path')

/**
 * 環境変数から接続設定を作る
 *
 * @param {Record<string, string | undefined>} [env] 環境変数（既定は process.env）
 * @returns {{ host: string, port: number, username: string, auth: string, version: string | undefined }} 接続設定
 */
function createConfig(env = process.env) {
  return {
    host: env.MC_HOST || 'localhost',
    port: Number(env.MC_PORT || 25565),
    username: env.MC_USERNAME || 'SortBot',
    // ローカルのテスト用サーバー（online-mode=false）では offline、正規サーバーでは microsoft
    auth: env.MC_AUTH || 'offline',
    // 未指定の場合はサーバーのバージョンを自動で判定する
    version: env.MC_VERSION || undefined
  }
}

// 登録情報を保存するファイル（リポジトリの data/ は .gitignore で除外している）
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json')

// 詳しい振り分けの計画を書き出すファイル
const PLAN_FILE = path.join(__dirname, '..', 'data', 'plan.txt')

module.exports = { createConfig, STATE_FILE, PLAN_FILE }
