/**
 * 手机的自建中转设备签名(docs/self-hosted-relay-plan.md §16):给 DeviceLinkClient 的 `frameAuth`。
 * 发出和收到的对端消息都核对设备身份。未经认证的审批文案不能分发给 UI，
 * 否则用户可能在被替换的文案上批准真实的危险请求。
 */
import { fetchRelayCertificates, RelayFrameAuthenticator, type DeviceLinkFrameAuth } from '@cindy/device-link';

import { mobileDebugLog } from '@/debug/mobileDebugLog';

import { mobileRelayAuthCrypto } from './relayAuthCrypto';
import { getActiveSelfHostedRelay, subscribeSelfHostedRelayRoute, type SelfHostedRelayRoute } from './selfHostedRelayRouting';

/** 本机密钥缺失或损坏:不能签名就不能安全通信。发出的消息不带签名(电脑会丢弃),收到的全部丢弃。 */
const UNUSABLE: DeviceLinkFrameAuth = { sign: () => undefined, verify: () => false };

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const SIGNER_REFRESH_MIN_MS = 5_000;

interface Current {
  key: string;
  baseUrl: string;
  credential: string;
  authenticator: RelayFrameAuthenticator;
  frameAuth: DeviceLinkFrameAuth;
  refreshing: Promise<void> | null;
  controller: AbortController | null;
  lastRefreshAt: number;
}
let cached: Current | null = null;

function keyOf(relay: SelfHostedRelayRoute | null): string | null {
  if (!relay?.signing || !relay.credential) return null;
  return [relay.relayId, relay.baseUrl, relay.credential, relay.signing.deviceId,
    relay.signing.ownerPublicKey, relay.signing.seed].join('\n');
}

function dispose(): void {
  cached?.controller?.abort();
  cached = null;
}

// 账号、中转或凭证切换时立即使旧请求失效；不等下一条消息到来。
subscribeSelfHostedRelayRoute(() => {
  if (cached && cached.key !== keyOf(getActiveSelfHostedRelay())) dispose();
});

async function refresh(target: Current): Promise<void> {
  const controller = new AbortController();
  target.controller = controller;
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const certs = await fetchRelayCertificates(
      (url, init) => fetch(url, init), target.baseUrl, target.credential, controller.signal,
    );
    if (cached !== target) return;
    const { rejected } = target.authenticator.setCertificates(certs);
    if (rejected) mobileDebugLog('warn', 'device-link', 'ignored relay certificates not issued by the owner');
  } catch {
    if (cached === target) mobileDebugLog('warn', 'device-link', 'relay certificate refresh failed; unverified frames remain blocked');
  } finally {
    clearTimeout(deadline);
    target.controller = null;
  }
}

function scheduleRefresh(target: Current, minIntervalMs: number): void {
  if (cached !== target || target.refreshing || Date.now() - target.lastRefreshAt < minIntervalMs) return;
  target.lastRefreshAt = Date.now();
  target.refreshing = refresh(target).finally(() => { target.refreshing = null; });
}

/** DeviceLinkClient 每帧调用:官方中转返回 null(不签名、不核对,wire 与旧版相同)。 */
export function currentSelfHostedRelayFrameAuth(): DeviceLinkFrameAuth | null {
  const relay = getActiveSelfHostedRelay();
  const signing = relay?.signing;
  if (!relay || !signing || !relay.credential) {
    dispose();
    return relay ? UNUSABLE : null;
  }
  // 中转或本机签名身份一变就重建;种子只在内存里比较,不进日志。
  const key = keyOf(relay)!;
  if (cached?.key === key) {
    // 只在通信活跃时刷新，不为闲置手机保留后台轮询。
    scheduleRefresh(cached, REFRESH_INTERVAL_MS);
    return cached.frameAuth;
  }
  dispose();
  try {
    let target: Current;
    const authenticator = new RelayFrameAuthenticator({
      crypto: mobileRelayAuthCrypto,
      relayId: relay.relayId,
      deviceId: signing.deviceId,
      seed: signing.seed,
      ownerPublicKey: signing.ownerPublicKey,
      onUnknownSigner: () => scheduleRefresh(target, SIGNER_REFRESH_MIN_MS),
    });
    target = {
      key, baseUrl: relay.baseUrl, credential: relay.credential, authenticator,
      refreshing: null, controller: null, lastRefreshAt: -Infinity,
      frameAuth: {
        peerChallenge: { session: authenticator, state: deviceId => authenticator.peerChallenge(deviceId) },
        sign: frame => cached === target ? authenticator.sign(frame) : undefined,
        verify: frame => {
          if (cached !== target) return false;
          const verdict = authenticator.verify(frame);
          if (verdict === 'bad-signature') scheduleRefresh(target, SIGNER_REFRESH_MIN_MS);
          return verdict === 'ok';
        },
      },
    };
    cached = target;
    scheduleRefresh(target, 0);
  } catch {
    mobileDebugLog('warn', 'device-link', 'self-hosted relay signing key is unusable');
    return UNUSABLE;
  }
  return cached.frameAuth;
}
