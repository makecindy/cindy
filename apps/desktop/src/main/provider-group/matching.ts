/**
 * 「是不是同一个供应商」(docs/product-rules/provider-groups.md §3)，不直接比较供应商 ID：
 *
 * - 官方供应商与订阅账号(Anthropic、OpenAI、xAI 及其登录预设)：同一品牌即可。设置里再添加的
 *   订阅账号 ID 是「品牌-随机 8 位」(AddProviderWizard)，两台电脑上一定不同。
 * - 自定义供应商：名称相同即可(忽略大小写与首尾空格)，ID 相同也算。ID 按名称生成，但改名后
 *   不变、本机同名时会带 `-2` 之类后缀，所以不只比 ID。
 *
 * 只用远端目录里已有的去敏字段(id / name / auth)，不新增协议字段。
 */
import type { ProviderView } from '@cindy/model-providers';

type ProviderIdentity = Pick<ProviderView, 'id' | 'name'> & {
  auth?: { method?: string; native?: string; oauth?: unknown } | null;
};

/** 官方连接的固定 ID。 */
const OFFICIAL_PROVIDER_IDS = new Set(['anthropic', 'openai', 'xai', 'gemini', 'xd']);
/** 订阅登录的原生账号家族 → 品牌。 */
const NATIVE_BRAND: Readonly<Record<string, string>> = { claude: 'anthropic', codex: 'openai', xai: 'xai' };
/** 登录添加的账号：`<品牌或预设 id>-<8 位随机>`。 */
const ACCOUNT_ID = /^([a-z0-9_]+(?:-[a-z0-9_]+)*?)-[0-9a-f]{8}$/;

/** 官方供应商 / 订阅账号的品牌；自定义供应商返回 null。 */
export function providerBrand(view: ProviderIdentity): string | null {
  const native = view.auth?.native;
  if (typeof native === 'string' && NATIVE_BRAND[native]) return NATIVE_BRAND[native];
  if (OFFICIAL_PROVIDER_IDS.has(view.id)) return view.id;
  const account = ACCOUNT_ID.exec(view.id);
  if (account && OFFICIAL_PROVIDER_IDS.has(account[1])) return account[1];
  if (view.auth?.method === 'oauth') return `oauth:${account ? account[1] : view.id}`;
  return null;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isSameProvider(a: ProviderIdentity, b: ProviderIdentity): boolean {
  const brandA = providerBrand(a);
  const brandB = providerBrand(b);
  if (brandA !== null || brandB !== null) return brandA !== null && brandA === brandB;
  if (a.id === b.id) return true;
  return typeof a.name === 'string' && typeof b.name === 'string'
    && normalizeName(a.name) !== '' && normalizeName(a.name) === normalizeName(b.name);
}
