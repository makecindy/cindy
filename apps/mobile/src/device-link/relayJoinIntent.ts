/**
 * 手机收到的「加入中转」链接(`cindy://relay/join?u=<中转地址>&c=<加入码>&o=<主人公钥>&s=<配对秘密>`,
 * 也接受 cindycn / cindydev 与 Router 去掉 scheme 后的 `/relay/join?...`;见 docs/self-hosted-relay-plan.md
 * §5.1、§16)。
 *
 * 加入码与配对秘密是一次性秘密:不进路由状态、日志或诊断。这里只在内存里留一份解析结果供加入页读取;
 * 不合法的链接什么都不留。10 分钟(加入码有效期)后丢弃;登录前收到的链接由第一次登录的账号
 * 接手,换账号即丢弃。
 */
import { useSyncExternalStore } from 'react';
import { parseRelayJoinLink, type RelayJoinLink } from '@cindy/device-link';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

/** 加入页路由;不带任何参数。 */
export const RELAY_JOIN_ROUTE = '/relay-join';
const RELAY_JOIN_INTENT_TTL_MS = 10 * 60_000;

export interface RelayJoinIntent {
  /** 每收到一条链接加一;加入页据此在打开期间换成新链接。 */
  id: number;
  /** null = 收到了链接但不合法或已丢弃(加入页显示「链接无效」)。 */
  link: RelayJoinLink | null;
}

let pending: RelayJoinIntent | null = null;
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

const SCHEME_PREFIX = /^[a-zA-Z][\w+.-]*:\/\//;

/** 去掉 scheme 后统一成以 `/` 开头的路径(Router 给的可能是完整链接,也可能没有前导斜杠)。 */
function routerPath(path: string): string {
  const noScheme = path.trim().replace(SCHEME_PREFIX, '/');
  return noScheme.startsWith('/') ? noScheme : `/${noScheme}`;
}

/** 这个系统路径是不是加入中转(任意 scheme、相对路径都算,合法与否另说)。 */
export function isRelayJoinPath(path: string): boolean {
  const pathname = routerPath(path).split(/[?#]/)[0].replace(/\/+$/, '');
  return pathname === '/relay' || pathname === '/relay/join';
}

/**
 * 收下一条系统链接。是加入中转的路径就返回 true(调用方改路由到加入页,不带参数);
 * 先丢掉之前留着的链接,再只为合法链接留一份解析结果。
 */
export function receiveRelayJoinIntent(path: string): boolean {
  if (!isRelayJoinPath(path)) return false;
  release();
  let owner = getMobileAuthOwner();
  // 带 scheme 的完整链接交给共享解析器校验 scheme;Router 去掉 scheme 的形态按路径解析。
  const candidate = SCHEME_PREFIX.test(path.trim()) ? path : routerPath(path);
  const link = owner.switching ? null : parseRelayJoinLink(candidate);
  pending = { id: ++sequence, link };
  if (link) {
    expiry = setTimeout(clearRelayJoinIntent, RELAY_JOIN_INTENT_TTL_MS);
    stopWatching = subscribeMobileAuthOwner(() => {
      const next = getMobileAuthOwner();
      // 首次登录也会先发布 switching 来清理缓存;尚未归属账号的扫码意图要保留到登录完成。
      if (owner.accountKey && !isMobileAuthOwnerCurrent(owner)) clearRelayJoinIntent();
      else if (next.accountKey) owner = next; // 登录前收到的链接由第一次登录的账号接手。
    });
  }
  notify();
  return true;
}

/** 加入码已提交(中转已作废它)、用户放弃或页面换了链接时调用。 */
export function clearRelayJoinIntent(): void {
  if (!pending) return;
  release();
  notify();
}

export const getPendingRelayJoinIntent = (): RelayJoinIntent | null => pending;

export function subscribeRelayJoinIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const usePendingRelayJoinIntent = (): RelayJoinIntent | null =>
  useSyncExternalStore(subscribeRelayJoinIntent, getPendingRelayJoinIntent, getPendingRelayJoinIntent);
