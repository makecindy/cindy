import { useCallback, useState } from 'react';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { VendorPrefs } from '@/state/newMakerDraft';

export interface AlternateDraftModel {
  ownerGeneration: number;
  pageKey: string;
  vendor: MakerVendor;
  prefs: Pick<VendorPrefs, 'model' | 'providerId' | 'effort'>;
  fast: boolean | 'ultrafast';
  favoriteUid: string | null;
  agentDevice?: { deviceId: string; name: string } | null;
}

// One window's unfinished drafts survive page navigation, without changing saved defaults.
const drafts = new Map<string, AlternateDraftModel>();
// 保存的默认暂时用不了时选的另一台电脑 / 分享来的模型(2026-11-26 用户裁决)：与正常选远程模型
// 一样在本次运行内沿用到之后的新建任务，保存的默认不变，重启后不恢复。发送完成、另起新建只清掉
// 这份草稿自己的那一条；用户明确改选别的模型时由 forgetRemoteAlternateDraftModel 清掉。
let lastRemoteAlternate: AlternateDraftModel | null = null;

export function alternateDraftModelFor(key: string, ownerGeneration: number): AlternateDraftModel | null {
  const value = drafts.get(key);
  if (value?.ownerGeneration === ownerGeneration) return value;
  return lastRemoteAlternate?.ownerGeneration === ownerGeneration ? lastRemoteAlternate : null;
}
export function setAlternateDraftModel(key: string, value: AlternateDraftModel | null): void {
  if (value) {
    drafts.set(key, value);
    // 改选本机模型作为替代 = 不再沿用远程那一个。
    lastRemoteAlternate = value.agentDevice ? value : null;
  } else {
    drafts.delete(key);
  }
}
/** 用户明确改选了别的模型(插件模型 / 插件引擎 / 模型组 / 正常模型)：之后的新建不再沿用远程替代。 */
export function forgetRemoteAlternateDraftModel(): void {
  lastRemoteAlternate = null;
}
export function useAlternateDraftModel(key: string, ownerGeneration: number) {
  const [value, setValue] = useState(() => alternateDraftModelFor(key, ownerGeneration));
  const set = useCallback((next: AlternateDraftModel | null) => {
    setAlternateDraftModel(key, next);
    setValue(next);
  }, [key]);
  return [value?.ownerGeneration === ownerGeneration ? value : null, set] as const;
}
