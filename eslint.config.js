// ESLint の設定
// 採掘 BOT（minecraft-mining-bot）とチェスト整理 BOT（minecraft-chest-sorting-bot）で同じ内容にする。

const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      // 分割代入で一部を取り除くための変数（const { a, ...rest } = obj の a）は、使わなくてよい
      'no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  }
]
