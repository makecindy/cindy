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
 *
 * 打开 Agent-Net 开关也是同一个恢复入口（2026-11-26 用户定：被删后要能重新加入）：被移除后重新登录过的手机，
 * Device Link 已经回来、横幅里不再有「重新加入」，但它不在账号的设备列表里（同账号的电脑在 Agent-Net 上都拦它），
 * Agent-Net 的身份也可能还是作废的那张。开关打开时读到的设备列表里没有它，或官方服务明确回 `DEVICE_REVOKED`，就按点一次
 * 「重新加入」把它接回来再打开（prepareMobileAgentNetEnable）。被移除时开着的开关会自动关掉（agentNetRuntime.ts）。
 */

/** `AGENT_NET_REJOIN_UNAVAILABLE`: turning Agent-Net on brought Device Link back, but the Agent-Net service still refuses. */
export type MobileDeviceRejoinErrorCode = 'DEVICE_REJOIN_UNSUPPORTED' | 'AGENT_NET_REJOIN_UNSUPPORTED' | 'AGENT_NET_REJOIN_UNAVAILABLE';
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

/** `agentNet`: rejoin Agent-Net too even though the switch is still off (the switch is being turned on). */
type RejoinHandler = (options?: { agentNet?: boolean }) => Promise<MobileDeviceRejoinResult>;
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

const REJOIN_MESSAGES: Record<MobileDeviceRejoinErrorCode, string> = {
  DEVICE_REJOIN_UNSUPPORTED: 'deviceLink.rejoin.unsupported',
  AGENT_NET_REJOIN_UNSUPPORTED: 'deviceLink.rejoin.agentNetUnsupported',
  AGENT_NET_REJOIN_UNAVAILABLE: 'deviceLink.rejoin.agentNetUnavailable',
};

function failureMessage(error: unknown): string {
  if (error instanceof MobileDeviceRejoinError) return i18n.t(REJOIN_MESSAGES[error.code]);
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

// ─── Turning the Agent-Net switch on (AgentNetSettingsGroup) ──────────────────────────────────────────────────────

/** The official Agent-Net service says this phone's identity was revoked: it was removed from the account. */
export function isMobileAgentNetRevocation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'DEVICE_REVOKED';
}

/** 「重新加入」 run by the switch: same handler and one-at-a-time rule as the banner, its failure reported by the caller. */
export async function rejoinMobileDeviceForAgentNet(): Promise<MobileDeviceRejoinResult> {
  const run = handler;
  if (!run) throw new Error('DEVICE_REJOIN_UNAVAILABLE');
  if (busy) throw new Error('DEVICE_REJOIN_BUSY');
  busy = true;
  publish();
  try {
    return await run({ agentNet: true });
  } finally {
    busy = false;
    publish();
  }
}

export interface MobileAgentNetEnablePorts<Identity> {
  /** This phone's Agent-Net identity (`ensureMobileAgentNetIdentity`): the stored certificate while it is unexpired. */
  identity(): Promise<Identity>;
  /** Fetch the signed roster from the service and store it. */
  refreshDirectory(identity: Identity): Promise<void>;
  /** An unexpired roster is already stored on this phone. */
  hasLocalDirectory(identity: Identity): Promise<boolean>;
  /** The official network is selected (a self-hosted relay keeps its own re-pairing). */
  official(): boolean;
  /** Whether the account's official Device Link device list has this phone; null when it cannot be read now. */
  listed(): Promise<boolean | null>;
  /** 「重新加入」 for this phone, Agent-Net included (`rejoinMobileDeviceForAgentNet`). */
  rejoin(): Promise<MobileDeviceRejoinResult>;
}

/**
 * Before the switch goes on. A signed roster is required for cold-start peer authentication; an existing, unexpired local
 * roster also permits enabling while offline — but not once the service said this phone was removed: that answer used to
 * be swallowed by the local roster, turning the switch on with a revoked certificate that no relay accepts. When the
 * official service says so — or the account's device list does not have this phone (signed in again after a removal: every
 * computer of the account refuses it on Agent-Net) — this phone rejoins (one attempt, as one tap on 「重新加入」) and prepares
 * once more. A list that cannot be read now is not a removal.
 */
export async function prepareMobileAgentNetEnable<Identity>(ports: MobileAgentNetEnablePorts<Identity>): Promise<void> {
  const prepare = async () => {
    const identity = await ports.identity();
    try { await ports.refreshDirectory(identity); }
    catch (error) { if (isMobileAgentNetRevocation(error) || !(await ports.hasLocalDirectory(identity))) throw error; }
  };
  const rejoin = async () => {
    const { agentNet } = await ports.rejoin();
    if (agentNet !== 'rejoined') throw new MobileDeviceRejoinError('AGENT_NET_REJOIN_UNAVAILABLE');
    await prepare();
  };
  if (ports.official() && (await ports.listed()) === false) return rejoin();
  try {
    await prepare();
  } catch (error) {
    if (!ports.official() || !isMobileAgentNetRevocation(error)) throw error;
    await rejoin();
  }
}

/** The message key the switch shows when turning Agent-Net on failed. */
export function mobileAgentNetEnableFailureKey(error: unknown): string {
  return error instanceof MobileDeviceRejoinError ? REJOIN_MESSAGES[error.code] : 'relay.agentNet.failed';
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
