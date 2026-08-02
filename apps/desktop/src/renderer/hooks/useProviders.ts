/**
 * useProviders — 模型供应商列表 hook(设置 → 模型供应商页消费)。
 *
 * 数据来自 main 的 `maker.listProviders()`(读 @cindy/model-providers 注册表,
 * 每次调用都现读各 agent 的连接态)。App 根节点统一监听 catalog / 鉴权广播并联合刷新
 * providers + 两份 capabilities；本 hook 只消费共享快照，并暴露 `refetch` 给页面处理
 * 不改变模型目录的连接动作(例如 api-key 断开)。
 *
 * 遵守「先取数据、拿到后再刷新显示」时序:数据来自本地 IPC,极快返回,因此
 * 不做 loading 态界面;`loading` 仅用于首帧避免渲染空列表(初值空数组 + loading
 * true,IPC 返回后一次性填充)。
 */

import { useCallback, useEffect, useState } from 'react';

import type { ProviderView } from '@cindy/model-providers';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';
import {
  getCachedProvidersSnapshot,
  subscribeProvidersSnapshot,
  type ProvidersSnapshot,
} from '@/lib/providersSnapshotStore';

export interface UseProvidersReturn {
  providers: ProviderView[];
  providerOrder: string[];
  ownerGeneration: number | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * 跨 mount 的供应商快照缓存。
 *
 * 消费方(设置 → 模型供应商页、ModelSelector、CreateWorkerPopover 等)大多是
 * conditional render —— 切走即卸载、重开即重新 mount。没有缓存时每次 mount 都从
 * `providers: []` 起步,第一帧把所有来源按"未连接"画出来,IPC 返回后 connected 才
 * 翻 true:XD 行会因此多撑出一行 masked-key chip,cell 高度跳变一帧(供应商页最明显)。
 *
 * 这里把最近一次拉到的快照存到模块级:重开时第一帧直接用上次连接态渲染(高度即终态),
 * 后台由 App 的联合刷新静默校正(连接态在两次开页之间几乎不变 → 通常无可见变化)。
 * 只缓存"快照"不缓存"是否在拉取中",故不破坏 refetch 的现有刷新语义。
 */
export function useProviders(): UseProvidersReturn {
  const { dataOwnerId } = getDataOwnerGeneration();
  const [snapshot, setSnapshot] = useState<ProvidersSnapshot | null>(() =>
    getCachedProvidersSnapshot(),
  );

  // AuthContext 会先同步切换全局 data owner 代际、再提交 React state。owner 改变后的
  // 首次 render 不能继续暴露旧 state；只接受同 owner state 或 owner-scoped 模块缓存。
  const currentSnapshot =
    snapshot?.dataOwnerId === dataOwnerId
      ? snapshot
      : getCachedProvidersSnapshot();

  const refetch = useCallback(() => {
    void refreshLocalCatalogSnapshot();
  }, []);

  useEffect(() => {
    setSnapshot(getCachedProvidersSnapshot());
    const onRefresh = (next: ProvidersSnapshot | null): void => setSnapshot(next);
    return subscribeProvidersSnapshot(onRefresh);
  }, [dataOwnerId]);

  return {
    providers: currentSnapshot?.providers ?? [],
    providerOrder: currentSnapshot?.providerOrder ?? [],
    ownerGeneration: currentSnapshot?.ownerGeneration ?? null,
    loading: currentSnapshot == null,
    refetch,
  };
}
