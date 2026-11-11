/**
 * 读取某个供应商的组(含组内电脑实时状态)。组设置变化时 main 广播 CHANGED；组内电脑的在线与
 * 运行情况没有推送，打开期间定时重读。
 *
 * 读组要逐台问组内电脑的状态，可能要好几秒。所以打开时先显示已知的组，再在后台刷新
 * (2026-10-11 用户反馈：每次进来都看到先「未设置」再跳成组)：
 * - 这个窗口读过就先用上次的结果(按账号存，换账号不沿用)；
 * - 没读过就用本机组设置快照(useLocalProviderGroups，全窗口共用、模型列表启动时就读好)排出组与组内电脑，
 *   每台的状态先显示「检查中」，读回来再补上。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig, ProviderGroupView } from '../../../shared/providerGroup';
import { peekLocalProviderGroup } from './useLocalProviderGroups';
import { providerGroupManagementCommand, providerManagementErrorKey } from './providerManagement';
import { extractIpcError } from '@/utils/ipcError';

/** 组内电脑在线、正在运行等状态的重读间隔。 */
const REFRESH_INTERVAL_MS = 15_000;

interface CachedGroupView {
  view: ProviderGroupView;
  /** Absolute deadlines derived from the host's remaining display budget. */
  wallUntil?: number;
  monoUntil?: number;
  /** Sticky observation: wall rollback must not make an observed expiry live again. */
  expired?: boolean;
}

/** 上次读到的组，按「账号 + 供应商」存。 */
const lastViews = new Map<string, CachedGroupView>();

function cacheKey(providerId: string, deviceId?: string): string {
  return `${getDataOwnerGeneration().dataOwnerId ?? ''}\u0000${deviceId ?? ''}\u0000${providerId}`;
}

function remember(providerId: string, view: ProviderGroupView, deviceId?: string,
  requestedAt?: { wall: number; mono: number }): CachedGroupView {
  const remaining = view.providerContinuity?.remainingMs;
  const wallUntil = requestedAt && typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0
    ? requestedAt.wall + remaining : undefined;
  const monoUntil = requestedAt && typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0
    ? requestedAt.mono + remaining : undefined;
  const entry: CachedGroupView = {
    view,
    ...(wallUntil !== undefined && monoUntil !== undefined
      ? { wallUntil, monoUntil, expired: Date.now() >= wallUntil || performance.now() >= monoUntil }
      : {}),
  };
  lastViews.set(cacheKey(providerId, deviceId), entry);
  return entry;
}

function staleGroupView(view: ProviderGroupView): ProviderGroupView {
  return { ...view, providerContinuity: { stale: true, remainingMs: 0 } };
}

/** 打开时先显示的组；null = 还不知道有没有组。 */
function knownView(providerId: string, deviceId?: string, initialConfig?: ProviderGroupConfig | null): ProviderGroupView | null {
  const cached = lastViews.get(cacheKey(providerId, deviceId));
  if (cached) {
    if (cached.expired) return staleGroupView(cached.view);
    // A cached view may be recalled long after its bounded display window. Keep
    // config fallback for navigation, but never present its member/running/quota
    // rows as live status once either clock passed the forwarded deadline.
    if (cached.wallUntil !== undefined && cached.monoUntil !== undefined
      && (Date.now() >= cached.wallUntil || performance.now() >= cached.monoUntil)) {
      cached.expired = true;
      return staleGroupView(cached.view);
    }
    return cached.view;
  }
  if (deviceId) return initialConfig ? { providerId, config: initialConfig, members: [] } : null;
  const local = peekLocalProviderGroup(providerId);
  return local.ready ? { providerId, config: local.config, members: [] } : null;
}

export interface ProviderGroupState {
  view: ProviderGroupView | null;
  loading: boolean;
  failed: boolean;
  /** The current view's forwarded display budget has ended. */
  expired: boolean;
  errorKey: string | null;
  reload: () => Promise<void>;
  save: (config: ProviderGroupConfig) => Promise<ProviderGroupView>;
  remove: () => Promise<ProviderGroupView>;
}

export function useProviderGroup(providerId: string, options: { live?: boolean; deviceId?: string; initialConfig?: ProviderGroupConfig | null } = {}): ProviderGroupState {
  const { deviceId, initialConfig } = options;
  // The exact cached entry this hook is displaying. An expiry observed during
  // render must latch on this shared source, not only on this mount's ref, so an
  // unmount/reopen after a wall rollback cannot revive it.
  const cachedEntry = lastViews.get(cacheKey(providerId, deviceId)) ?? null;
  const [view, setView] = useState<ProviderGroupView | null>(() => knownView(providerId, deviceId, initialConfig));
  const [loading, setLoading] = useState(() => knownView(providerId, deviceId, initialConfig) === null || Boolean(deviceId));
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(() => cachedEntry?.expired === true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const seq = useRef(0);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryToken = useRef(0);
  const viewDeadline = useRef<{ wallUntil?: number; monoUntil?: number; expired: boolean }>({ expired: false });
  const viewEntry = useRef<CachedGroupView | null>(cachedEntry);

  const viewExpired = () => {
    const deadline = viewDeadline.current;
    if (deadline.expired) {
      if (viewEntry.current) viewEntry.current.expired = true;
      return true;
    }
    if (deadline.wallUntil === undefined || deadline.monoUntil === undefined) return false;
    if (Date.now() < deadline.wallUntil && performance.now() < deadline.monoUntil) return false;
    // Latch a boundary observed during render; this is a ref, not a state update
    // or notification. Latch the shared cache entry too: a later wall rollback
    // must not revive the same source when the hook remounts and reopens it.
    deadline.expired = true;
    if (viewEntry.current) viewEntry.current.expired = true;
    return true;
  };

  const armExpiry = useCallback((wallUntil?: number, monoUntil?: number, alreadyExpired = false) => {
    if (expiryTimer.current !== null) clearTimeout(expiryTimer.current);
    expiryTimer.current = null;
    expiryToken.current += 1;
    if (wallUntil === undefined || monoUntil === undefined) {
      viewDeadline.current = { expired: false };
      setExpired(false);
      return;
    }
    viewDeadline.current = { wallUntil, monoUntil, expired: alreadyExpired };
    if (alreadyExpired) {
      if (viewEntry.current) viewEntry.current.expired = true;
      setExpired(true);
      return;
    }
    const remaining = Math.min(wallUntil - Date.now(), monoUntil - performance.now());
    if (remaining <= 0) {
      viewDeadline.current.expired = true;
      setExpired(true);
      return;
    }
    setExpired(false);
    const token = expiryToken.current;
    expiryTimer.current = setTimeout(() => {
      if (token !== expiryToken.current) return;
      expiryTimer.current = null;
      viewDeadline.current.expired = true;
      if (viewEntry.current) viewEntry.current.expired = true;
      setExpired(true);
    }, remaining);
  }, []);

  const armViewExpiry = useCallback((next: ProviderGroupView, requestedAt?: { wall: number; mono: number }) => {
    const remaining = next.providerContinuity?.remainingMs;
    if (!requestedAt || typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) {
      armExpiry();
      return;
    }
    armExpiry(requestedAt.wall + remaining, requestedAt.mono + remaining);
  }, [armExpiry]);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    const owner = getDataOwnerGeneration();
    const requestedAt = { wall: Date.now(), mono: performance.now() };
    try {
      const next = await providerGroupManagementCommand({ action: 'get', providerId }, deviceId);
      if (current !== seq.current || !isDataOwnerGenerationCurrent(owner)) return;
      viewEntry.current = remember(providerId, next, deviceId, requestedAt);
      setView(next);
      armViewExpiry(next, requestedAt);
      setFailed(false);
      setErrorKey(null);
    } catch (error) {
      if (current !== seq.current || !isDataOwnerGenerationCurrent(owner)) return;
      setFailed(true);
      setErrorKey(providerManagementErrorKey(error, Boolean(deviceId)));
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [armViewExpiry, providerId, deviceId]);

  useEffect(() => {
    const known = knownView(providerId, deviceId, initialConfig);
    const cached = lastViews.get(cacheKey(providerId, deviceId));
    viewEntry.current = cached ?? null;
    setView(known);
    setLoading(known === null || Boolean(deviceId));
    setFailed(false);
    setErrorKey(null);
    armExpiry(cached?.wallUntil, cached?.monoUntil, cached?.expired === true);
    void reload();
    const off = window.electronAPI.providerGroup.onChanged((event) => {
      if (event?.providerId === providerId) void reload();
    });
    return () => {
      off();
      seq.current += 1;
      if (expiryTimer.current !== null) clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    };
  }, [armExpiry, providerId, deviceId, initialConfig, reload]);

  useEffect(() => {
    if (!options.live) return;
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [options.live, reload]);

  const apply = useCallback(
    (next: ProviderGroupView, requestedAt?: { wall: number; mono: number }) => {
      seq.current += 1;
      viewEntry.current = remember(providerId, next, deviceId, requestedAt);
      setView(next);
      armViewExpiry(next, requestedAt);
      setFailed(false);
      setErrorKey(null);
      setLoading(false);
      return next;
    },
    [armViewExpiry, providerId, deviceId],
  );

  const save = useCallback(
    async (config: ProviderGroupConfig) => {
      const requestedAt = { wall: Date.now(), mono: performance.now() };
      try {
        return apply(await providerGroupManagementCommand({
          action: 'save-if-current', providerId, config, expectedConfig: view?.config ?? null,
        }, deviceId), requestedAt);
      } catch (error) {
        if (extractIpcError(error)?.code === 'PROVIDER_GROUP_CHANGED') await reload();
        throw error;
      }
    },
    [apply, providerId, deviceId, view, reload],
  );

  const remove = useCallback(
    async () => {
      const requestedAt = { wall: Date.now(), mono: performance.now() };
      try {
        return apply(await providerGroupManagementCommand({
          action: 'delete-if-current', providerId, expectedConfig: view?.config ?? null,
        }, deviceId), requestedAt);
      } catch (error) {
        if (extractIpcError(error)?.code === 'PROVIDER_GROUP_CHANGED') await reload();
        throw error;
      }
    },
    [apply, providerId, deviceId, view, reload],
  );

  const expiredNow = expired || viewExpired();
  return { view, loading, failed, expired: expiredNow, errorKey, reload, save, remove };
}

export const __testing = {
  reset(): void {
    lastViews.clear();
  },
};
