import { useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import type { DeviceLinkConnectionIssue } from '@cindy/device-link';
import { ApiError } from '@/api/client';
import { i18n } from '@/i18n';
import { getActiveSelfHostedRelay } from './selfHostedRelayRouting';

/**
 * 「重新加入」：在官方网络上被移除的这台手机，由本机的人点一下就回来（2026-11-23 用户定：不重新登录，
 * 也不要别的设备批准）。服务端契约：`POST /api/device-link/rejoin` 只清掉 token 自己这台设备的删除记录；
 * 官方 Agent-Net 入网带 `rejoin: true` 时给被撤销的设备号重新发证书，移除前的证书继续作废。
 *
 * 一次点击只发一轮请求，不自动重试、不轮询。恢复动作只重建本机自己的连接：它已经被 4410 停掉，
 * 其他对端和其他连接不受影响。自建中转仍走原来的重新配对（remoteStatus.ts 的 isSelfHostedRelayRemoval）。
 */

export type MobileDeviceRejoinErrorCode = 'DEVICE_REJOIN_UNSUPPORTED' | 'AGENT_NET_REJOIN_UNSUPPORTED';
export class MobileDeviceRejoinError extends Error {
  constructor(readonly code: MobileDeviceRejoinErrorCode) {
    super(code);
    this.name = 'MobileDeviceRejoinError';
  }
}

export interface MobileDeviceRejoinResult {
  /** `unavailable`: the Agent-Net service predates rejoin and still refuses; this phone runs on Device Link. */
  agentNet: 'rejoined' | 'not-used' | 'unavailable';
}

export interface MobileDeviceRejoinPorts {
  /** `POST /api/device-link/rejoin` on the official Device Link service, with the account token. */
  rejoinDeviceLink(): Promise<void>;
  /** The Agent-Net switch is on, or this account already enrolled an official Agent-Net identity on this phone. */
  agentNetInvolved(): Promise<boolean>;
  /** 「仅使用加密连接」: there is no Device Link connection to fall back to. */
  agentNetRequired(): boolean;
  /** Official enrollment with `rejoin: true`, also while the stored (revoked) certificate is unexpired. */
  rejoinAgentNet(): Promise<void>;
  /** Forget that Agent-Net refused this identity, so the rebuilt connection tries it again. */
  clearAgentNetRefusal(): void;
  /** Rebuild this phone's own connection: the shared client stays stopped after 4410 and ignores connectNow. */
  restartConnection(): void;
}

const keepsRevocation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL';

export async function rejoinRemovedMobileDevice(ports: MobileDeviceRejoinPorts): Promise<MobileDeviceRejoinResult> {
  try {
    await ports.rejoinDeviceLink();
  } catch (error) {
    // A service without the route: nothing changed, so nothing is restarted.
    if (error instanceof ApiError && error.status === 404) throw new MobileDeviceRejoinError('DEVICE_REJOIN_UNSUPPORTED');
    throw error;
  }
  // Device Link has this phone back. Whatever Agent-Net answers, its own connection is rebuilt exactly once.
  try {
    if (!(await ports.agentNetInvolved())) return { agentNet: 'not-used' };
    try {
      await ports.rejoinAgentNet();
    } catch (error) {
      if (!keepsRevocation(error)) throw error;
      if (ports.agentNetRequired()) throw new MobileDeviceRejoinError('AGENT_NET_REJOIN_UNSUPPORTED');
      // The remembered refusal stays: the rebuilt connection goes straight to Device Link.
      return { agentNet: 'unavailable' };
    }
    ports.clearAgentNetRefusal();
    return { agentNet: 'rejoined' };
  } finally {
    ports.restartConnection();
  }
}

// ─── The action the banners show, registered by DeviceLinkProvider ─────────────────────────────────────────────────

type RejoinHandler = () => Promise<MobileDeviceRejoinResult>;
let handler: RejoinHandler | null = null;
let busy = false;
let snapshot = { registered: false, busy: false };
const listeners = new Set<() => void>();
function publish(): void {
  snapshot = { registered: handler !== null, busy };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getSnapshot = () => snapshot;

/** DeviceLinkProvider supplies the handler for the signed-in account; the returned disposer removes only its own. */
export function registerMobileDeviceRejoin(next: RejoinHandler): () => void {
  handler = next;
  publish();
  return () => {
    if (handler !== next) return;
    handler = null;
    publish();
  };
}

/** Only this phone's own removal on the official network; a self-hosted relay keeps its re-pairing path. */
export function canRejoinRemovedMobileDevice(issue: DeviceLinkConnectionIssue | null | undefined): boolean {
  return issue?.kind === 'device-removed' && getActiveSelfHostedRelay() === null;
}

function failureMessage(error: unknown): string {
  if (error instanceof MobileDeviceRejoinError) {
    return i18n.t(error.code === 'DEVICE_REJOIN_UNSUPPORTED' ? 'deviceLink.rejoin.unsupported' : 'deviceLink.rejoin.agentNetUnsupported');
  }
  return i18n.t('deviceLink.rejoin.failed');
}

/** One tap, one attempt; a second tap while it runs does nothing. */
export async function runMobileDeviceRejoin(): Promise<void> {
  const run = handler;
  if (!run || busy) return;
  busy = true;
  publish();
  try {
    const result = await run();
    if (result.agentNet === 'unavailable') {
      Alert.alert(i18n.t('deviceLink.rejoin.doneTitle'), i18n.t('deviceLink.rejoin.agentNetUnavailable'));
    }
  } catch (error) {
    Alert.alert(i18n.t('deviceLink.rejoin.failedTitle'), failureMessage(error));
  } finally {
    busy = false;
    publish();
  }
}

export function useMobileDeviceRejoin(issue: DeviceLinkConnectionIssue | null | undefined): {
  visible: boolean;
  busy: boolean;
  run(): void;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return {
    visible: state.registered && canRejoinRemovedMobileDevice(issue),
    busy: state.busy,
    run: () => { void runMobileDeviceRejoin(); },
  };
}
