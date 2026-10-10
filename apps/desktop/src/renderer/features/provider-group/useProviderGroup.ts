/**
 * 读取某个供应商的组(含组内电脑实时状态)。组设置变化时 main 广播 CHANGED；组内电脑的在线与
 * 运行情况没有推送，打开期间定时重读。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderGroupConfig, ProviderGroupView } from '../../../shared/providerGroup';

/** 组内电脑在线、正在运行等状态的重读间隔。 */
const REFRESH_INTERVAL_MS = 15_000;

export interface ProviderGroupState {
  view: ProviderGroupView | null;
  loading: boolean;
  failed: boolean;
  reload: () => Promise<void>;
  save: (config: ProviderGroupConfig) => Promise<ProviderGroupView>;
  remove: () => Promise<ProviderGroupView>;
}

export function useProviderGroup(providerId: string, options: { live?: boolean } = {}): ProviderGroupState {
  const [view, setView] = useState<ProviderGroupView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    try {
      const next = await window.electronAPI.providerGroup.command({ action: 'get', providerId });
      if (current !== seq.current) return;
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
    setView(null);
    setLoading(true);
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

  const apply = useCallback((next: ProviderGroupView) => {
    seq.current += 1;
    setView(next);
    setFailed(false);
    setLoading(false);
    return next;
  }, []);

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
