/**
 * 供应商分享 · 手机经被控电脑读取「别人分享给这台电脑的供应商」(同账号 channel)。
 * 手机读不到另一个账号的电脑，所以由被控电脑代读分享者电脑的 `maker:provider:list` 后转交；
 * 身份只有昵称与头像，目录里分享者的账号身份(登录邮箱等)在每一跳都去掉。
 */
import { providerShareIdentifier, sharedTaskDeviceId } from './protocol.js';

export const PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL = 'maker:provider-share:received-catalogs';

export interface ProviderShareReceivedCatalog {
  /** 任务记录里「Agent 在哪台电脑」的值：`share:<shareId>`。 */
  agentDeviceId: string;
  shareId: string;
  providerId: string;
  providerLabel: string;
  deviceName: string;
  owner: { displayName: string; avatarUrl: string | null };
  status: 'active' | 'paused';
  hostOnline: boolean;
  /** 分享者电脑上 `maker:provider:list` 的结果(只含分享的那个供应商)；读不到时为 null。 */
  catalog: unknown;
}

const MAX_SHARES = 64;

// 宽松匹配：名称里任何像邮箱的片段都去掉，宁可多删不可漏。
const EMAIL_LIKE = /[^\s@＠<>()[\]{},;:"'`·]+[@＠][^\s@＠<>()[\]{},;:"'`·]+/g;
const EDGE_SEPARATORS = /^[\s·•|:：\-–—/]+|[\s·•|:：\-–—/]+$/g;
// 登录后自动生成的名称「<供应商> · <登录名>」，截到 50 字符后可能只剩半个登录名(也可能不是邮箱)。
const GENERATED_ACCOUNT_NAME = /^(?:OpenAI|Anthropic|Claude|xAI|Grok)\s*·/;
// 同名时自动追加的序号「 (2)」：保留，同一台电脑分享的两个同类账号才分得清。
const COPY_SUFFIX = /\s\((?:[2-9]|[1-9]\d+)\)$/;
// 登录名去掉后留下的空括号。
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]|（\s*）|<\s*>/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一个登录身份在名称里可能的写法，不区分大小写：原文，以及邮箱的用户名部分(至少 3 个字符，
 * 按整词匹配，避免把「OpenAI」里的 open 也删掉)。
 */
function removeIdentity(label: string, identity: string): string {
  const value = identity.trim();
  const local = value.includes('@') ? value.slice(0, value.indexOf('@')) : '';
  let out = label.replace(new RegExp(escapeRegExp(value), 'gi'), ' ');
  // 不用后行断言与 Unicode 属性类：手机端(Hermes)也跑这段。
  if (local.length >= 3) out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(local)}(?![A-Za-z0-9])`, 'gi'), '$1 ');
  return out;
}

/** 名称之外的展示字段里，地址可能带着用户名密码或查询参数里的 key：只留协议、主机与路径。 */
function stripUrlSecrets(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function stripNestedUrlSecrets(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return stripUrlSecrets(value);
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => stripNestedUrlSecrets(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripNestedUrlSecrets(item, depth + 1)]));
}

/**
 * 分享给他人的供应商名称：去掉分享者的账号身份(订阅或 ChatGPT 登录名、任何邮箱)。
 * 例如自动命名的「OpenAI · alice@example.com」→「OpenAI」。带账号身份的供应商、或名称是
 * 自动生成的形状时，第一个「·」之后的部分整段去掉(登录名可能被截断，按原文匹配不到)。
 * 去空后用 fallback。
 */
export function scrubProviderShareLabel(label: string, identities: readonly (string | undefined)[] = [], fallback = 'Provider'): string {
  const suffix = COPY_SUFFIX.exec(label)?.[0] ?? '';
  let out = label.slice(0, label.length - suffix.length);
  let accountBound = false;
  for (const identity of identities) {
    if (typeof identity !== 'string' || !identity.trim()) continue;
    accountBound = true;
    out = removeIdentity(out, identity);
  }
  out = out.replace(EMAIL_LIKE, ' ').replace(EMPTY_BRACKETS, ' ').replace(/\s*[·•|]\s*(?=[·•|])/g, '').replace(EDGE_SEPARATORS, '');
  if (accountBound || GENERATED_ACCOUNT_NAME.test(out)) out = out.replace(/\s*·[\s\S]*$/, '');
  out = out.replace(EDGE_SEPARATORS, '').replace(/\s{2,}/g, ' ').trim();
  return out ? `${out}${suffix}` : fallback;
}

function accountIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const identity = (value as { identity?: unknown }).identity;
  return typeof identity === 'string' ? identity : undefined;
}

/**
 * 分享出去的一条供应商：去掉分享者的账号身份字段(`subscriptionAccount` / `openAiAccount`，
 * 含登录邮箱)并清理名称，地址里的用户名密码与查询参数也去掉；其余展示字段沿用同账号投影。
 * 供应商组摘要(`group`，列着组内电脑)只给同账号电脑，这里也去掉。
 * 分享者电脑、受邀者电脑与手机都各过一遍。
 */
export function scrubSharedProvider<T>(provider: T): T {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return provider;
  const { subscriptionAccount, openAiAccount, ...fields } = provider as Record<string, unknown>;
  delete fields.group;
  const rest = stripNestedUrlSecrets(fields, 0) as Record<string, unknown>;
  if (typeof rest.name === 'string') {
    rest.name = scrubProviderShareLabel(rest.name, [accountIdentity(subscriptionAccount), accountIdentity(openAiAccount)],
      typeof rest.id === 'string' ? rest.id : 'Provider');
  }
  return rest as T;
}

/** `maker:provider:list` 结果里的每条供应商都过 `scrubSharedProvider`。 */
export function scrubSharedProviderCatalog<T>(catalog: T): T {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return catalog;
  const value = catalog as Record<string, unknown>;
  if (!Array.isArray(value.providers)) return catalog;
  return { ...value, providers: value.providers.map(scrubSharedProvider) } as T;
}

function text(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex -- 控制字符是显式拒绝目标
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid provider share catalog text');
  }
  return value;
}

function avatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** 严格解析；单条不合法时丢弃这一条，不影响其他分享。 */
export function parseProviderShareReceivedCatalogs(value: unknown): ProviderShareReceivedCatalog[] {
  const shares = value && typeof value === 'object' && !Array.isArray(value) ? (value as { shares?: unknown }).shares : undefined;
  if (!Array.isArray(shares)) return [];
  const out: ProviderShareReceivedCatalog[] = [];
  for (const raw of shares.slice(0, MAX_SHARES)) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const shareId = providerShareIdentifier(item.shareId);
      if (item.agentDeviceId !== `share:${shareId}`) continue;
      const owner = item.owner && typeof item.owner === 'object' ? item.owner as Record<string, unknown> : {};
      out.push({
        agentDeviceId: `share:${shareId}`,
        shareId,
        providerId: text(item.providerId, 256),
        providerLabel: scrubProviderShareLabel(text(item.providerLabel, 256)),
        deviceName: text(sharedTaskDeviceId(item.deviceName), 256),
        owner: { displayName: text(owner.displayName, 128), avatarUrl: avatar(owner.avatarUrl) },
        status: item.status === 'paused' ? 'paused' : 'active',
        hostOnline: item.hostOnline === true,
        catalog: scrubSharedProviderCatalog(item.catalog ?? null),
      });
    } catch {
      // 跳过这一条。
    }
  }
  return out;
}
