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

/** 上次读到的组，按「账号 + 供应商」存。 */
const lastViews = new Map<string, ProviderGroupView>();

function cacheKey(providerId: string, deviceId?: string): string {
  return `${getDataOwnerGeneration().dataOwnerId ?? ''}\u0000${deviceId ?? ''}\u0000${providerId}`;
}

function remember(providerId: string, view: ProviderGroupView, deviceId?: string): void {
  lastViews.set(cacheKey(providerId, deviceId), view);
}

/** 打开时先显示的组；null = 还不知道有没有组。 */
function knownView(providerId: string, deviceId?: string, initialConfig?: ProviderGroupConfig | null): ProviderGroupView | null {
  const cached = lastViews.get(cacheKey(providerId, deviceId));
  if (cached) return cached;
  if (deviceId) return initialConfig ? { providerId, config: initialConfig, members: [] } : null;
  const local = peekLocalProviderGroup(providerId);
  return local.ready ? { providerId, config: local.config, members: [] } : null;
}

export interface ProviderGroupState {
  view: ProviderGroupView | null;
  loading: boolean;
  failed: boolean;
  errorKey: string | null;
  reload: () => Promise<void>;
  save: (config: ProviderGroupConfig) => Promise<ProviderGroupView>;
  remove: () => Promise<ProviderGroupView>;
}

export function useProviderGroup(providerId: string, options: { live?: boolean; deviceId?: string; initialConfig?: ProviderGroupConfig | null } = {}): ProviderGroupState {
  const { deviceId, initialConfig } = options;
  const [view, setView] = useState<ProviderGroupView | null>(() => knownView(providerId, deviceId, initialConfig));
  const [loading, setLoading] = useState(() => knownView(providerId, deviceId, initialConfig) === null || Boolean(deviceId));
  const [failed, setFailed] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const current = ++seq.current;
    const owner = getDataOwnerGeneration();
    try {
      const next = await providerGroupManagementCommand({ action: 'get', providerId }, deviceId);
      if (current !== seq.current || !isDataOwnerGenerationCurrent(owner)) return;
      remember(providerId, next, deviceId);
      setView(next);
      setFailed(false);
      setErrorKey(null);
    } catch (error) {
      if (current !== seq.current || !isDataOwnerGenerationCurrent(owner)) return;
      setFailed(true);
      setErrorKey(providerManagementErrorKey(error, Boolean(deviceId)));
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [providerId, deviceId]);

  useEffect(() => {
    const known = knownView(providerId, deviceId, initialConfig);
    setView(known);
    setLoading(known === null || Boolean(deviceId));
    setFailed(false);
    setErrorKey(null);
    void reload();
    const off = window.electronAPI.providerGroup.onChanged((event) => {
      if (event?.providerId === providerId) void reload();
    });
    return () => {
      off();
      seq.current += 1;
    };
  }, [providerId, deviceId, initialConfig, reload]);

  useEffect(() => {
    if (!options.live) return;
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [options.live, reload]);

  const apply = useCallback(
    (next: ProviderGroupView) => {
      seq.current += 1;
      remember(providerId, next, deviceId);
      setView(next);
      setFailed(false);
      setErrorKey(null);
      setLoading(false);
      return next;
    },
    [providerId, deviceId],
  );

  const save = useCallback(
    async (config: ProviderGroupConfig) => {
      try {
        return apply(await providerGroupManagementCommand({
          action: 'save-if-current', providerId, config, expectedConfig: view?.config ?? null,
        }, deviceId));
      } catch (error) {
        if (extractIpcError(error)?.code === 'PROVIDER_GROUP_CHANGED') await reload();
        throw error;
      }
    },
    [apply, providerId, deviceId, view, reload],
  );

  const remove = useCallback(
    async () => {
      try {
        return apply(await providerGroupManagementCommand({
          action: 'delete-if-current', providerId, expectedConfig: view?.config ?? null,
        }, deviceId));
      } catch (error) {
        if (extractIpcError(error)?.code === 'PROVIDER_GROUP_CHANGED') await reload();
        throw error;
      }
    },
    [apply, providerId, deviceId, view, reload],
  );

  return { view, loading, failed, errorKey, reload, save, remove };
}

export const __testing = {
  reset(): void {
    lastViews.clear();
  },
};
