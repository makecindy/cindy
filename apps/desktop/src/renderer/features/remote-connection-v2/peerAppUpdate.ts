/**
 * peerAppUpdate —— 在 Agent-Net 拓扑卡片里按需探测并触发 Cindy 更新(发起端状态)。
 * ---------------------------------------------------------------------------
 * - 非 dev 版本才探测：排除 0.0.0 / 0.0.0-* / *-dev / 非 semver、手机、非 Cindy App、离线或不可控设备。
 * - 不轮询：只在打开设备卡片(或本机卡片)时按需问一次，短时间内复用结果，不给 CDN / 对端施压。
 * - 老版本对端返回 CHANNEL_NOT_ALLOWED 时静默记为 unsupported(不显示更新图标，零误报)。
 * - 触发更新后状态保存在模块级 store：关掉卡片或离开设置页，更新照常进行；后台失败通过回调给 toast。
 */

import {
  parsePeerAppUpdateInstallAccepted,
  parsePeerAppUpdateStatus,
  peerAppUpdateErrorCode,
  type PeerAppUpdateErrorCode,
  type PeerAppUpdateRequest,
  type PeerAppUpdateStatus,
} from '@cindy/device-link';
import { isCindyApp } from '@cindy/maker-shared/device-list';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  subscribeDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { PeerAppUpdateReply } from '../../../shared/selfHostedRelay';
import type { TopologyNode } from './topologyModel';

export const SELF_UPDATE_TARGET_ID = '__self__';

export type PeerUpdateEntry =
  | { kind: 'checking' }
  | {
      kind: 'available';
      currentVersion: string;
      targetVersion: string;
      busy: boolean;
      platform?: string;
      ready: boolean;
    }
  | {
      kind: 'updating';
      phase: 'downloading' | 'relaunching';
      currentVersion: string;
      targetVersion: string;
    }
  | { kind: 'up-to-date'; currentVersion: string }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' };

export interface PeerUpdateConfirmTarget {
  targetId: string;
  isSelf: boolean;
  deviceName: string;
  currentVersion: string;
  targetVersion: string;
  busy: boolean;
  platform?: string;
}

export type StartPeerUpdateResult =
  | { ok: true; state: 'downloading' | 'relaunching'; targetVersion: string }
  | { ok: false; code: PeerAppUpdateErrorCode | 'UNREACHABLE' };

const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEV_PRERELEASE_PATTERN = /(?:^|[.-])dev(?:[.-]|$)/i;

/** 非 dev / 非占位版本才展示与探测更新入口。 */
export function isNonDevAppVersion(version: string | null | undefined): boolean {
  if (typeof version !== 'string') return false;
  const trimmed = version.trim();
  if (!trimmed || trimmed === '0.0.0' || trimmed.startsWith('0.0.0-')) return false;
  if (!SEMVER_PATTERN.test(trimmed)) return false;
  const dash = trimmed.indexOf('-');
  if (dash !== -1) {
    const prerelease = trimmed.slice(dash + 1).split('+')[0] ?? '';
    if (DEV_PRERELEASE_PATTERN.test(prerelease)) return false;
  }
  return true;
}

/** 该远端设备卡片是否允许探测更新。 */
export function canProbePeerUpdate(node: TopologyNode): boolean {
  return (
    isCindyApp(node.app)
    && !node.isMobile
    && node.status !== 'offline'
    && node.status !== 'connecting'
    && node.remoteControlEnabled
    && node.controlEnabled
    && isNonDevAppVersion(node.appVersion)
  );
}

const PROBE_COOLDOWN_MS = 15_000;
const WATCH_DOWNLOAD_INTERVAL_MS = 3_000;
const WATCH_RELAUNCH_INTERVAL_MS = 4_000;
const MAX_DOWNLOAD_TICKS = 60;
const MAX_RELAUNCH_TICKS = 5;

interface Snapshot {
  entries: ReadonlyMap<string, PeerUpdateEntry>;
}

const entries = new Map<string, PeerUpdateEntry>();
const probedAt = new Map<string, number>();
const probing = new Map<string, Promise<PeerUpdateEntry>>();
const watchAbort = new Map<string, () => void>();
let snapshot: Snapshot = { entries: new Map() };
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { entries: new Map(entries) };
  for (const listener of listeners) listener();
}

function setEntry(targetId: string, entry: PeerUpdateEntry | null): void {
  if (entry) entries.set(targetId, entry);
  else entries.delete(targetId);
  publish();
}

function clearAllState(): void {
  for (const stop of watchAbort.values()) stop();
  watchAbort.clear();
  entries.clear();
  probedAt.clear();
  probing.clear();
  publish();
}

// 切换账号 / 登出时立即中止所有观察器并清空缓存，防止跨账号复用 __self__ 或迟到回包。
subscribeDataOwnerGeneration(clearAllState);

export const peerUpdateStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): Snapshot {
    return snapshot;
  },
  resetForTest(): void {
    clearAllState();
  },
};

async function ask(targetId: string, request: PeerAppUpdateRequest): Promise<PeerAppUpdateReply> {
  const api = window.electronAPI?.selfHostedRelay;
  if (!api) return { ok: false, code: 'NOT_CONNECTED', message: 'no host' };
  try {
    const result = await api.command(
      targetId === SELF_UPDATE_TARGET_ID
        ? { type: 'self-app-update', request }
        : { type: 'peer-app-update', deviceId: targetId, request },
    );
    return result.peerUpdate ?? { ok: false, code: result.error ?? 'NOT_CONNECTED', message: '' };
  } catch (error) {
    return { ok: false, code: 'NOT_CONNECTED', message: error instanceof Error ? error.message : '' };
  }
}

function entryFromStatus(status: PeerAppUpdateStatus): PeerUpdateEntry {
  switch (status.state) {
    case 'available':
    case 'ready':
      if (!status.targetVersion) return { kind: 'unavailable' };
      return {
        kind: 'available',
        currentVersion: status.currentVersion,
        targetVersion: status.targetVersion,
        busy: status.busy === true,
        platform: status.platform,
        ready: status.state === 'ready',
      };
    case 'downloading':
    case 'relaunching':
      if (!status.targetVersion) return { kind: 'unavailable' };
      return {
        kind: 'updating',
        phase: status.state,
        currentVersion: status.currentVersion,
        targetVersion: status.targetVersion,
      };
    case 'up-to-date':
      return { kind: 'up-to-date', currentVersion: status.currentVersion };
    case 'unsupported':
      return { kind: 'unsupported' };
    default:
      return { kind: 'unavailable' };
  }
}

function entryFromReply(reply: PeerAppUpdateReply): { entry: PeerUpdateEntry; status: PeerAppUpdateStatus | null } {
  if (!reply.ok) {
    return {
      entry: reply.code === 'CHANNEL_NOT_ALLOWED' ? { kind: 'unsupported' } : { kind: 'unavailable' },
      status: null,
    };
  }
  const status = parsePeerAppUpdateStatus(reply.result);
  if (!status) return { entry: { kind: 'unavailable' }, status: null };
  return { entry: entryFromStatus(status), status };
}

/** 设备重连后若版本号已变化，清掉旧缓存，避免继续显示旧的更新中或有新版状态。 */
export function syncPeerUpdateVersion(targetId: string, observedVersion: string | null | undefined): void {
  const clean = observedVersion?.trim();
  if (!clean) return;
  const current = entries.get(targetId);
  if (!current) return;
  if (
    (current.kind === 'updating' && (current.targetVersion === clean || current.currentVersion !== clean))
    || (current.kind === 'available' && (current.targetVersion === clean || current.currentVersion !== clean))
    || (current.kind === 'up-to-date' && current.currentVersion !== clean)
  ) {
    watchAbort.get(targetId)?.();
    watchAbort.delete(targetId);
    probedAt.delete(targetId);
    setEntry(targetId, null);
  }
}

/** 打开卡片时按需向对端（或本机）查一次更新状态。 */
export function probePeerUpdate(
  targetId: string,
  options?: { force?: boolean; observedVersion?: string | null },
): Promise<PeerUpdateEntry> {
  syncPeerUpdateVersion(targetId, options?.observedVersion);
  const existing = entries.get(targetId);
  // 仅在观察器仍在跟踪一次进行中的更新时跳过探测；只读看到的 downloading 或超时后的旧状态重新打开卡片应重新查询。
  if (existing?.kind === 'updating' && watchAbort.has(targetId)) return Promise.resolve(existing);
  const last = probedAt.get(targetId) ?? 0;
  if (
    !options?.force
    && existing
    && existing.kind !== 'checking'
    && existing.kind !== 'updating'
    && Date.now() - last < PROBE_COOLDOWN_MS
  ) {
    return Promise.resolve(existing);
  }
  const inflight = probing.get(targetId);
  if (inflight) return inflight;

  const owner = getDataOwnerGeneration();
  if (!existing) setEntry(targetId, { kind: 'checking' });
  const req = ask(targetId, { action: 'status' }).then((reply) => {
    if (probing.get(targetId) === req) probing.delete(targetId);
    if (!isDataOwnerGenerationCurrent(owner)) return { kind: 'unavailable' } as PeerUpdateEntry;
    const { entry } = entryFromReply(reply);
    // 观察器仍在跟踪的新发起更新不被迟到的旧 probe 覆盖
    if (entries.get(targetId)?.kind === 'updating' && watchAbort.has(targetId) && entry.kind !== 'updating') {
      return entries.get(targetId)!;
    }
    probedAt.set(targetId, Date.now());
    setEntry(targetId, entry);
    return entry;
  });
  probing.set(targetId, req);
  return req;
}

function watchUpdatingPeer(
  targetId: string,
  expectedVersion: string,
  initialPhase: 'downloading' | 'relaunching',
  owner: DataOwnerGeneration,
  onBackgroundError?: (errorCode: string) => void,
): void {
  watchAbort.get(targetId)?.();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase: 'downloading' | 'relaunching' = initialPhase;
  let ticks = 0;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (watchAbort.get(targetId) === stop) watchAbort.delete(targetId);
  };
  watchAbort.set(targetId, stop);

  const schedule = () => {
    if (stopped || !isDataOwnerGenerationCurrent(owner)) {
      stop();
      return;
    }
    const maxTicks = phase === 'downloading' ? MAX_DOWNLOAD_TICKS : MAX_RELAUNCH_TICKS;
    if (ticks >= maxTicks) {
      stop();
      return;
    }
    const delay = phase === 'downloading' ? WATCH_DOWNLOAD_INTERVAL_MS : WATCH_RELAUNCH_INTERVAL_MS;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || !isDataOwnerGenerationCurrent(owner)) {
        stop();
        return;
      }
      ticks += 1;
      const reply = await ask(targetId, { action: 'status' });
      if (stopped || !isDataOwnerGenerationCurrent(owner)) {
        stop();
        return;
      }
      if (!reply.ok) {
        // relaunching 期间连接断开是预期行为（对端正在重启）；停止轮询，等重连后版本号刷新。
        if (phase === 'relaunching') {
          stop();
          return;
        }
        schedule();
        return;
      }
      const { entry, status } = entryFromReply(reply);
      if (!status) {
        schedule();
        return;
      }
      if (status.state === 'downloading' || status.state === 'relaunching') {
        if (status.state === 'relaunching' && phase !== 'relaunching') {
          phase = 'relaunching';
          ticks = 0;
        }
        setEntry(targetId, entry);
        schedule();
        return;
      }
      // 离开 downloading/relaunching：更新完成、渠道变化或后台失败
      probedAt.set(targetId, Date.now());
      setEntry(targetId, entry);
      stop();
      if (status.lastErrorCode && status.currentVersion !== expectedVersion) {
        onBackgroundError?.(status.lastErrorCode);
      }
    }, delay);
  };

  schedule();
}

/** 二次确认后触发对端（或本机）内置更新。 */
export async function startPeerUpdate(
  targetId: string,
  expectedVersion: string,
  currentVersion: string,
  onBackgroundError?: (errorCode: string) => void,
): Promise<StartPeerUpdateResult> {
  const owner = getDataOwnerGeneration();
  const reply = await ask(targetId, { action: 'install', expectedVersion });
  if (!isDataOwnerGenerationCurrent(owner)) {
    return { ok: false, code: 'UNREACHABLE' };
  }
  if (!reply.ok) {
    const code = peerAppUpdateErrorCode(reply.message);
    if (code === 'PEER_APP_UPDATE_VERSION_CHANGED' || code === 'PEER_APP_UPDATE_NO_UPDATE') {
      void probePeerUpdate(targetId, { force: true });
    }
    return { ok: false, code: code ?? 'UNREACHABLE' };
  }
  const accepted = parsePeerAppUpdateInstallAccepted(reply.result);
  if (!accepted) return { ok: false, code: 'UNREACHABLE' };

  setEntry(targetId, {
    kind: 'updating',
    phase: accepted.state,
    currentVersion,
    targetVersion: accepted.targetVersion,
  });
  watchUpdatingPeer(targetId, accepted.targetVersion, accepted.state, owner, onBackgroundError);
  return { ok: true, state: accepted.state, targetVersion: accepted.targetVersion };
}
