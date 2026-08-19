/**
 * useProviderUsageCapability — 按 providerId 读订阅用量能力标记(useProviders 快照的
 * 轻量投影,不拉连接态)。
 *
 * chip 用它判定「当前会话的 provider 是否承载可查询的订阅余量」(如 GLM Coding Plan)。
 * 身份来自 provider 配置里快照的 usage 能力标记(preset → CustomProviderConfig →
 * buildUserProvider → ProviderView),不是域名 / 可编辑名称的猜测 —— 普通 GLM API 与
 * Coding Plan 共用同一个 /api/anthropic 端点,只有标记能区分。
 *
 * 数据通道:providersSnapshotStore 的共享快照(App 根节点监听 catalog / 鉴权广播统一
 * 刷新);本 hook 只消费缓存 + 订阅提交,不主动发 IPC。快照未加载 / provider 不存在 /
 * 无 usage 字段 → null。
 */

import { useEffect, useState } from 'react';

import type { ProviderUsageCapability } from '@cindy/model-providers';
import {
  getCachedProvidersSnapshot,
  subscribeProvidersSnapshot,
} from '@/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

export function useProviderUsageCapability(
  providerId: string | null | undefined,
): ProviderUsageCapability | null {
  const [capability, setCapability] = useState<ProviderUsageCapability | null>(() =>
    readCapability(providerId),
  );
  const { dataOwnerId } = getDataOwnerGeneration();

  useEffect(() => {
    setCapability(readCapability(providerId));
    return subscribeProvidersSnapshot(() => {
      setCapability(readCapability(providerId));
    });
  }, [providerId, dataOwnerId]);

  return capability;
}

function readCapability(providerId: string | null | undefined): ProviderUsageCapability | null {
  if (!providerId) return null;
  const snapshot = getCachedProvidersSnapshot();
  if (!snapshot) return null;
  return snapshot.providers.find((p) => p.id === providerId)?.usage ?? null;
}
