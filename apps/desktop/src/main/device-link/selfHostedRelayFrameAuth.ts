/**
 * 自建中转的设备签名(docs/self-hosted-relay-plan.md §16):给 DeviceLinkClient 的 `frameAuth`。
 *
 * - 发出:经中转转发的每条对端消息用本机签名密钥签名。
 * - 收到:对端消息必须带发送设备的有效签名,证书由主人公钥核对;中转(哪怕被人控制)伪造、篡改、
 *   重放的消息在分发前丢弃。电脑会执行远程请求,所以电脑端核对所有对端消息。
 * - 证书列表从中转取,用主人公钥逐个核对(中转无法伪造);遇到未知或更换密钥的设备时节流刷新。
 *
 * 只依赖路由模块与共享协议包,不碰 electron / 账号文件,device-link 主模块可直接引用。
 */
import {
  fetchRelayCertificates,
  RelayFrameAuthenticator,
  type DeviceLinkFrameAuth,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { createLogger } from '../logger.js';
import { activeSelfHostedRelay, type ActiveSelfHostedRelay } from './selfHostedRelayRouting.js';

const log = createLogger('self-hosted-relay:signatures');

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const UNKNOWN_SIGNER_REFRESH_MIN_MS = 5_000;

interface Current {
  key: string;
  relay: ActiveSelfHostedRelay;
  authenticator: RelayFrameAuthenticator;
  frameAuth: DeviceLinkFrameAuth;
  timer: ReturnType<typeof setInterval>;
  refreshing: Promise<void> | null;
  lastRefreshAt: number;
}

let current: Current | null = null;

function keyOf(relay: ActiveSelfHostedRelay): string {
  // 种子不进 key 字符串以外的任何地方;key 只在内存里比较。
  return [relay.relayId, relay.baseUrl, relay.deviceId, relay.ownerPublicKey, relay.signingSeed].join('\n');
}

function dispose(): void {
  if (!current) return;
  clearInterval(current.timer);
  current = null;
}

async function refresh(target: Current): Promise<void> {
  target.lastRefreshAt = Date.now();
  try {
    const certs = await fetchRelayCertificates(
      (url, init) => fetch(url, init),
      target.relay.baseUrl,
      target.relay.credential,
      AbortSignal.timeout(10_000),
    );
    if (current !== target) return;
    const { accepted, rejected } = target.authenticator.setCertificates(certs);
    if (rejected > 0) log.warn('relay returned certificates the owner did not issue; ignored', { accepted, rejected });
  } catch (error) {
    log.info('relay certificate refresh failed; will retry', { reason: error instanceof Error ? error.name : 'unknown' });
  }
}

function scheduleRefresh(target: Current, minIntervalMs: number): void {
  if (target.refreshing || Date.now() - target.lastRefreshAt < minIntervalMs) return;
  target.refreshing = refresh(target).finally(() => {
    target.refreshing = null;
  });
}

function create(relay: ActiveSelfHostedRelay): Current {
  let self: Current | null = null;
  const authenticator = new RelayFrameAuthenticator({
    crypto: nodeRelayAuthCrypto,
    relayId: relay.relayId,
    deviceId: relay.deviceId,
    seed: relay.signingSeed,
    ownerPublicKey: relay.ownerPublicKey,
    onUnknownSigner: () => {
      if (self) scheduleRefresh(self, UNKNOWN_SIGNER_REFRESH_MIN_MS);
    },
  });
  const timer = setInterval(() => {
    if (self) scheduleRefresh(self, 0);
  }, REFRESH_INTERVAL_MS);
  timer.unref?.();
  self = {
    key: keyOf(relay),
    relay,
    authenticator,
    frameAuth: {
      peerChallenge: { session: authenticator, state: deviceId => authenticator.peerChallenge(deviceId) },
      sign: (frame) => authenticator.sign(frame),
      verify: (frame) => {
        const verdict = authenticator.verify(frame);
        // 同一设备重新加入会换密钥；当前帧仍拒绝，刷新后核对后续帧。
        if (verdict === 'bad-signature' && self) scheduleRefresh(self, UNKNOWN_SIGNER_REFRESH_MIN_MS);
        return verdict === 'ok';
      },
    },
    timer,
    refreshing: null,
    lastRefreshAt: 0,
  };
  scheduleRefresh(self, 0);
  return self;
}

/** DeviceLinkClient 每帧调用:官方中转返回 null(不签名、不核对)。 */
export function currentRelayFrameAuth(): DeviceLinkFrameAuth | null {
  const relay = activeSelfHostedRelay();
  if (!relay) {
    dispose();
    return null;
  }
  if (current?.key !== keyOf(relay)) {
    dispose();
    try {
      current = create(relay);
    } catch {
      // 本机密钥损坏:不能签名就不能安全通信。返回一个全部拒绝的实现,界面会提示重新加入。
      log.warn('relay signing key is unusable');
      return { sign: () => undefined, verify: () => false };
    }
  }
  return current.frameAuth;
}

/** 新设备刚加入后立刻刷新证书,不必等它的第一条消息被拒一次。 */
export function refreshRelayCertificatesSoon(): void {
  if (current) scheduleRefresh(current, 0);
}
