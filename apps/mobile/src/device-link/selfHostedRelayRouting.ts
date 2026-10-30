/**
 * 自建中转的进程内路由(docs/self-hosted-relay-plan.md §5.2、§5.3)。
 *
 * 只放同步可读的内存状态:当前账号是否改走自建中转、中转地址、设备凭证与签名身份。持久化(AsyncStorage +
 * 安全存储)在 `selfHostedRelay.ts`;这里刻意不引 react-native / expo 原生模块,`api/client` 与
 * WebSocket 鉴权每次请求都要同步查它。
 *
 * 三条约束都在这里收口:
 * - 地址:切换时同步改写 env 的 DEVICE_LINK_API_BASE_URL 覆盖值,REST 与 WS 消费者调用时读到的
 *   就是中转地址;
 * - 凭证:发往当前中转的请求一律带 `CindyRelay <凭证>`,账号 token 不发往任何已知的自建中转地址
 *   (含切走之后迟到、仍拿着旧地址的请求);
 * - 凭证只在内存里,不进日志、诊断与路由状态。
 */
import { setDeviceLinkApiBaseOverride } from '@/config/env';

export interface SelfHostedRelayRoute {
  relayId: string;
  name: string;
  /** 规范化后的中转基础地址(不含 `/api/...`,无末尾斜杠)。 */
  baseUrl: string;
  /**
   * 加入时拿到的设备凭证。null = 配置还在但本机安全存储里读不到凭证(如换机恢复备份,
   * 钥匙串条目按 THIS_DEVICE_ONLY 不随迁移):此时不发任何请求,界面提示重新加入或切回官方。
   */
  credential: string | null;
  /**
   * 本机在这个中转上的签名身份(docs/self-hosted-relay-plan.md §16),与凭证同存同取:
   * 凭证缺失时它也是 null,此时不建连、不签名。种子同凭证一样只在内存,不进日志与诊断。
   */
  signing: SelfHostedRelaySigning | null;
}

export interface SelfHostedRelaySigning {
  /** 证书里的设备 ID(= 加入时上报的官方设备 ID)。 */
  deviceId: string;
  /** 加入链接里的主人公钥。 */
  ownerPublicKey: string;
  /** 本机签名私钥种子(base64url)。 */
  seed: string;
}

export type SelfHostedRelayAuthorization =
  | { kind: 'relay'; credential: string }
  /** 目标是自建中转,但当前没有可用凭证(凭证缺失,或该中转已不是当前中转):不发请求。 */
  | { kind: 'blocked' };

let active: SelfHostedRelayRoute | null = null;
let generation = 0;
let loading = false;
let loadWaiters: Array<() => void> = [];
/** 本进程里出现过的自建中转地址:切回官方后,迟到的请求也不能把账号 token 发过去。 */
const knownRelayBases = new Set<string>();
const listeners = new Set<() => void>();

/** scheme 与 host 不区分大小写;路径原样保留,去掉末尾斜杠。 */
export function normalizeSelfHostedRelayBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i.exec(trimmed);
  return match ? match[1].toLowerCase() + match[2] : trimmed;
}

function sameSigning(a: SelfHostedRelaySigning | null, b: SelfHostedRelaySigning | null): boolean {
  if (!a || !b) return a === b;
  return a.deviceId === b.deviceId && a.ownerPublicKey === b.ownerPublicKey && a.seed === b.seed;
}

function sameRoute(a: SelfHostedRelayRoute | null, b: SelfHostedRelayRoute | null): boolean {
  if (!a || !b) return a === b;
  return a.relayId === b.relayId && a.name === b.name && a.baseUrl === b.baseUrl && a.credential === b.credential
    && sameSigning(a.signing, b.signing);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 当前生效的自建中转;null = 官方中转。 */
export function getActiveSelfHostedRelay(): SelfHostedRelayRoute | null {
  return active;
}

/**
 * 路由代次:模式、地址或凭证真正变化时才 +1。DeviceLinkProvider 把它作为重建连接的依赖,
 * 保证 WebSocket 的地址、token 与鉴权方案总在同一代里取值。
 */
export function getSelfHostedRelayRouteGeneration(): number {
  return generation;
}

export function subscribeSelfHostedRelayRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 切换路由:同步改写 device-link 地址覆盖,随后通知订阅者重建连接。 */
export function setActiveSelfHostedRelay(next: SelfHostedRelayRoute | null): void {
  const normalized = next ? { ...next, baseUrl: normalizeSelfHostedRelayBase(next.baseUrl) } : null;
  if (normalized) knownRelayBases.add(normalized.baseUrl);
  const changed = !sameRoute(active, normalized);
  const baseChanged = (active?.baseUrl ?? null) !== (normalized?.baseUrl ?? null);
  active = normalized;
  // 地址覆盖与路由同步切换(env 初始无覆盖,与 active=null 一致)。
  if (baseChanged) setDeviceLinkApiBaseOverride(normalized?.baseUrl ?? null);
  if (!changed) return;
  generation += 1;
  notify();
}

/** 读当前账号的中转设置期间置 true;device-link 首次建连会等它结束,避免先连上官方再切走。 */
export function setSelfHostedRelayLoading(next: boolean): void {
  if (loading === next) return;
  loading = next;
  if (next) return;
  const waiters = loadWaiters;
  loadWaiters = [];
  for (const resolve of waiters) resolve();
}

export function waitForSelfHostedRelayRoute(): Promise<void> {
  if (!loading) return Promise.resolve();
  return new Promise((resolve) => {
    loadWaiters.push(resolve);
  });
}

/**
 * 这个地址是否属于自建中转(当前的,或本进程里用过的)。是的话:账号 token 不发、不为它刷新,
 * 它返回的 401 也不能让账号退出。
 */
export function isSelfHostedRelayBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  if (!active && knownRelayBases.size === 0) return false;
  return knownRelayBases.has(normalizeSelfHostedRelayBase(baseUrl));
}

/** 发往这个地址的请求该带什么鉴权;null = 不是自建中转,按原逻辑带账号 token。 */
export function selfHostedRelayAuthorizationFor(
  baseUrl: string | undefined | null,
): SelfHostedRelayAuthorization | null {
  if (!isSelfHostedRelayBaseUrl(baseUrl)) return null;
  if (active?.credential && active.baseUrl === normalizeSelfHostedRelayBase(baseUrl!)) {
    return { kind: 'relay', credential: active.credential };
  }
  return { kind: 'blocked' };
}

export const __testing = {
  reset(): void {
    setActiveSelfHostedRelay(null);
    knownRelayBases.clear();
    setSelfHostedRelayLoading(false);
  },
};
