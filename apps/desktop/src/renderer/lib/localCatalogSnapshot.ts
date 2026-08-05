/**
 * 本地 provider catalog 的 renderer 原子刷新协调器。
 *
 * providers 与两份 agent capabilities 必须来自同一轮 main 快照：三次 IPC 全部成功、
 * 且期间没有更新一代目录时才同步提交。失败或乱序结果一律保留上一份有效快照。
 * device-link 的远端 capabilities 不经过这里，继续按 deviceId 独立缓存。
 */
import { createLogger } from '@/lib/logger';
import {
  beginLocalCapabilitiesRefresh,
  commitLocalCapabilitiesSnapshot,
  isLocalCapabilitiesRefreshCurrent,
  loadLocalCapabilitiesSnapshot,
} from '@/hooks/useAgentCapabilities';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
  isProvidersRefreshCurrent,
  loadProvidersSnapshot,
} from '@/lib/providersSnapshotStore';

const log = createLogger('localCatalogSnapshot');
let refreshGeneration = 0;

/** 联合刷新 providers + Claude/Codex capabilities，并只提交最新的完整结果。 */
export async function refreshLocalCatalogSnapshot(): Promise<boolean> {
  const generation = ++refreshGeneration;
  const providersGeneration = beginProvidersRefresh();
  const capabilitiesGeneration = beginLocalCapabilitiesRefresh();

  try {
    const [providers, capabilities] = await Promise.all([
      loadProvidersSnapshot(),
      loadLocalCapabilitiesSnapshot(),
    ]);
    if (
      refreshGeneration !== generation
      || !isProvidersRefreshCurrent(providersGeneration)
      || !isLocalCapabilitiesRefreshCurrent(capabilitiesGeneration)
    ) {
      return false;
    }

    // 两次提交均为同步通知；React 会把同一事件循环内的 hook 更新批处理到同一帧。
    commitLocalCapabilitiesSnapshot(capabilitiesGeneration, capabilities);
    commitProvidersSnapshot(providersGeneration, providers);
    return true;
  } catch (error) {
    if (refreshGeneration === generation) {
      log.warn('local catalog snapshot refresh failed; keeping last valid snapshot', error);
    }
    return false;
  }
}

/** 启动预热保留原有三次瞬时 IPC 重试语义；每次仍按完整快照原子提交。 */
export async function preloadLocalCatalogSnapshot(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await refreshLocalCatalogSnapshot()) return;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log.warn('local catalog snapshot preload failed after 3 attempts');
}
