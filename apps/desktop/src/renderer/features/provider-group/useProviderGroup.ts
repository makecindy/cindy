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

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig, ProviderGroupView } from '../../../shared/providerGroup';
import { peekLocalProviderGroup } from './useLocalProviderGroups';

/** 组内电脑在线、正在运行等状态的重读间隔。 */
const REFRESH_INTERVAL_MS = 15_000;

/** 上次读到的组，按「账号 + 供应商」存。 */
const lastViews = new Map<string, ProviderGroupView>();

function cacheKey(providerId: string): string {
  return `${getDataOwnerGeneration().dataOwnerId ?? ''}\u0000${providerId}`;
}

function remember(providerId: string, view: ProviderGroupView): void {
  lastViews.set(cacheKey(providerId), view);
}

/** 打开时先显示的组；null = 还不知道有没有组。 */
function knownView(providerId: string): ProviderGroupView | null {
  const cached = lastViews.get(cacheKey(providerId));
  if (cached) return cached;
  const local = peekLocalProviderGroup(providerId);
  return local.ready ? { providerId, config: local.config, members: [] } : null;
}

export interface ProviderGroupState {
  view: ProviderGroupView | null;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  save: (config: ProviderGroupConfig) => Promise<ProviderGroupView>;
  remove: () => Promise<ProviderGroupView>;
}

export function useProviderGroup(providerId: string, options: { live?: boolean } = {}): ProviderGroupState {
  const [view, setView] = useState<ProviderGroupView | null>(() => knownView(providerId));
  const [loading, setLoading] = useState(() => knownView(providerId) === null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    try {
      const next = await window.electronAPI.providerGroup.command({ action: 'get', providerId });
      if (current !== seq.current) return;
      remember(providerId, next);
      setView(next);
      setFailed(false);
    } catch {
      if (current !== seq.current) return;
      setFailed(true);
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    const known = knownView(providerId);
    setView(known);
    setLoading(known === null);
    void reload();
    const off = window.electronAPI.providerGroup.onChanged((event) => {
      if (event?.providerId === providerId) void reload();
    });
    return () => {
      off();
      seq.current += 1;
    };
  }, [providerId, reload]);

  useEffect(() => {
    if (!options.live) return;
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [options.live, reload]);

  const apply = useCallback(
    (next: ProviderGroupView) => {
      seq.current += 1;
      remember(providerId, next);
      setView(next);
      setFailed(false);
      setLoading(false);
      return next;
    },
    [providerId],
  );

  const save = useCallback(
    async (config: ProviderGroupConfig) =>
      apply(await window.electronAPI.providerGroup.command({ action: 'save', providerId, config })),
    [apply, providerId],
  );

  const remove = useCallback(
    async () => apply(await window.electronAPI.providerGroup.command({ action: 'delete', providerId })),
    [apply, providerId],
  );

  return { view, loading, failed, reload, save, remove };
}

export const __testing = {
  reset(): void {
    lastViews.clear();
  },
};
