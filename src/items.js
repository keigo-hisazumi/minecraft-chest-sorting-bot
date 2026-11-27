// アイテムの判定
// 廃棄してはいけない保護対象と、同じ枠にまとめられるかを調べる。

// 名前の形で決まる保護対象
const PROTECTED_PATTERNS = [
  // ダイヤとネザライトの装備と素材
  /^(diamond|netherite)(_|$)/,
  // 鉱石、インゴット、鉄塊・金塊・銅塊
  /_(ore|ingot|nugget)$/,
  /(^|_)shulker_box$/,
  // 銅ブロック（酸化と錆止めの違いを含む）
  /^(waxed_)?(exposed_|weathered_|oxidized_)?copper(_block)?$/
]

// 名前そのもので決まる保護対象
const PROTECTED_NAMES = new Set([
  'ancient_debris',
  'raw_iron',
  'raw_gold',
  'raw_copper',
  'redstone',
  'lapis_lazuli',
  'emerald',
  'quartz',
  // 上の素材をまとめたブロック
  'raw_iron_block',
  'raw_gold_block',
  'raw_copper_block',
  'iron_block',
  'gold_block',
  'redstone_block',
  'lapis_block',
  'emerald_block',
  'quartz_block'
])

/**
 * 種類だけで保護対象になるアイテムかを判定する
 *
 * @param {string} name アイテム名
 * @returns {boolean} 保護対象なら true
 */
function isProtectedName(name) {
  return PROTECTED_NAMES.has(name) || PROTECTED_PATTERNS.some((pattern) => pattern.test(name))
}

// エンチャントの情報があるか。形式が分からない場合は、捨てないようにあるものとみなす
function hasEnchantments(component) {
  if (!component) return false
  const list = Array.isArray(component.data) ? component.data : component.data?.enchantments
  return Array.isArray(list) ? list.length > 0 : true
}

const toJson = (value) => JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? String(v) : v))

/**
 * チェストから読んだアイテム 1 枠分を、振り分けの計画に使う形にする
 *
 * @param {import('prismarine-item').Item} item
 * @returns {{ name: string, count: number, stackSize: number, variant: string, protected: boolean }}
 *   variant が同じアイテムは、同じ枠にまとめられる
 */
function describeItem(item) {
  const components = item.componentMap ?? new Map()
  const isProtected =
    isProtectedName(item.name) ||
    components.has('custom_name') ||
    Boolean(item.customName) ||
    hasEnchantments(components.get('enchantments')) ||
    hasEnchantments(components.get('stored_enchantments'))
  const sorted = [...(item.components ?? [])].sort((a, b) => String(a.type).localeCompare(String(b.type)))
  const removed = (item.removedComponents ?? []).map(toJson).sort()
  return {
    name: item.name,
    count: item.count,
    stackSize: components.get('max_stack_size')?.data ?? item.stackSize,
    variant: toJson([sorted, removed, item.nbt ?? null]),
    protected: isProtected
  }
}

module.exports = { isProtectedName, describeItem }
