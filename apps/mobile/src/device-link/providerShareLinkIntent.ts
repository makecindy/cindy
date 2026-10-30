/**
 * 手机收到的供应商分享链接(`cindy://provider-share/join?invitation=…&server=…`,
 * 以及 cindycn / cindydev / xdt-maker 等 scheme 与 Router 去掉 scheme 后的路径形式)。
 *
 * 供应商分享只能在电脑上申请和使用(产品规则 provider-sharing.md §3、§4.1):手机只提示到电脑上
 * 打开,并可以把链接复制出来发到电脑。手机**不**申请、不访问服务端。
 *
 * 口令是一次性凭据:不进路由状态、日志或诊断。这里只在内存里留一份重建好的分享网页链接,
 * 供提示页取走(取走即清空);不合法的链接什么都不留;5 分钟(链接有效期)或换账号后丢弃。
 */
import {
  buildProviderShareLink,
  parseProviderShareInvitationIntent,
  PROVIDER_SHARE_LINK_TTL_MS,
} from '@cindy/device-link';

import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

/** 提示页路由;不带任何参数。 */
export const PROVIDER_SHARE_LINK_ROUTE = '/provider-share';

type Pending = { id: number; link: string | null };

let pending: Pending | null = null;
let sequence = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
let stopWatching: (() => void) | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function release(): void {
  pending = null;
  clearTimeout(expiry);
  expiry = undefined;
  stopWatching?.();
  stopWatching = undefined;
}

/** 去掉 scheme / host 前缀后的 pathname 与 query;不是供应商分享路径时返回 null。 */
function providerSharePath(path: string): { pathname: string; query: string; hash: boolean } | null {
  const noScheme = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '/');
  const withSlash = noScheme.startsWith('/') ? noScheme : `/${noScheme}`;
  const hashIndex = withSlash.indexOf('#');
  const beforeHash = hashIndex >= 0 ? withSlash.slice(0, hashIndex) : withSlash;
  const queryIndex = beforeHash.indexOf('?');
  const pathname = (queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash).replace(/\/+$/, '') || '/';
  if (pathname !== PROVIDER_SHARE_LINK_ROUTE && !pathname.startsWith(`${PROVIDER_SHARE_LINK_ROUTE}/`)) return null;
  return { pathname, query: queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '', hash: hashIndex >= 0 };
}

/** 这个系统路径是否落在供应商分享下(任意 scheme、相对路径都算)。 */
export function isProviderShareLinkPath(path: string): boolean {
  return providerSharePath(path) !== null;
}

function appHint(path: string): 'cindy' | 'cindycn' | 'cindydev' {
  const scheme = /^([a-zA-Z][\w+.-]*):/.exec(path)?.[1]?.toLowerCase();
  return scheme === 'cindycn' || scheme === 'cindydev' ? scheme : 'cindy';
}

/** 合法链接 → 重建成可以发到电脑上打开的分享网页链接;其余一律 null。 */
function shareableLink(path: string): string | null {
  const parts = providerSharePath(path);
  if (!parts || parts.pathname !== `${PROVIDER_SHARE_LINK_ROUTE}/join` || parts.hash) return null;
  const intent = parseProviderShareInvitationIntent(`cindy://provider-share/join?${parts.query}`);
  if (!intent) return null;
  try {
    return buildProviderShareLink(intent.invitation, intent.server, appHint(path));
  } catch {
    return null;
  }
}

/**
 * 收下一条系统链接。是供应商分享路径就返回 true(调用方改路由到提示页,不带参数);
 * 先丢掉之前留着的链接,再只为合法链接留一份可复制的网页链接。
 */
export function receiveProviderShareLinkIntent(path: string): boolean {
  if (!isProviderShareLinkPath(path)) return false;
  release();
  const owner = getMobileAuthOwner();
  const link = owner.switching ? null : shareableLink(path);
  pending = { id: ++sequence, link };
  if (link) {
    expiry = setTimeout(clearProviderShareLinkIntent, PROVIDER_SHARE_LINK_TTL_MS);
    stopWatching = subscribeMobileAuthOwner(() => {
      const next = getMobileAuthOwner();
      if (next.switching || (owner.accountKey && next.accountKey !== owner.accountKey)) {
        clearProviderShareLinkIntent();
      }
    });
  }
  notify();
  return true;
}

/**
 * 提示页取走最近一次收到的链接(取走即清空)。null = 没有新链接;
 * `{ link: null }` = 收到了链接但不合法 / 已失效,页面应清掉之前显示的链接。
 */
export function takeProviderShareLinkIntent(): { link: string | null } | null {
  if (!pending) return null;
  const { link } = pending;
  release();
  return { link };
}

export function clearProviderShareLinkIntent(): void {
  if (!pending) return;
  release();
  notify();
}

/** 每收到一条链接加一;提示页据此在打开期间接住新链接。 */
export const getProviderShareLinkIntentSequence = (): number => sequence;

export function subscribeProviderShareLinkIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只给测试用:看看内存里留着什么(不取走)。 */
export const peekProviderShareLinkIntentForTest = (): { link: string | null } | null =>
  pending ? { link: pending.link } : null;
