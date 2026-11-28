import { useCallback, useState } from 'react';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { NewMakerDraft, VendorPrefs } from '@/state/newMakerDraft';
import { NEW_MAKER_DRAFT_KEY } from './newMakerDraftKeys';

export interface AlternateDraftModel {
  ownerGeneration: number;
  pageKey: string;
  vendor: MakerVendor;
  prefs: Pick<VendorPrefs, 'model' | 'providerId' | 'effort'>;
  fast: boolean | 'ultrafast';
  favoriteUid: string | null;
  agentDevice?: { deviceId: string; name: string } | null;
}

/**
 * Overlay a one-task built-in model override onto the saved draft without mutating it.
 * Clear alternate routing modes (plugin model, model group, plugin engine) for this task
 * so stale saved choices cannot hijack or block submission of the selected built-in model.
 */
export function applyAlternateDraftModel(
  savedDraft: NewMakerDraft,
  alternate: AlternateDraftModel | null,
): NewMakerDraft {
  if (!alternate) return savedDraft;
  return {
    ...savedDraft,
    vendor: alternate.vendor,
    agentDeviceId: alternate.agentDevice?.deviceId ?? null,
    agentDeviceName: alternate.agentDevice?.name ?? null,
    pluginModel: null,
    modelGroup: null,
    pluginEngine: null,
    lastByVendor: {
      ...savedDraft.lastByVendor,
      [alternate.vendor]: { ...savedDraft.lastByVendor[alternate.vendor], ...alternate.prefs },
    },
  };
}

// One window's unfinished drafts survive page navigation, without changing saved defaults.
const drafts = new Map<string, AlternateDraftModel>();
// 保存的默认暂时用不了时选的另一台电脑 / 分享来的模型(2026-11-26 用户裁决)：与正常选远程模型
// 一样在本次运行内沿用到之后的新建任务，保存的默认不变，重启后不恢复。发送完成、另起新建只清掉
// 这份草稿自己的那一条；用户明确改选别的模型时由 forgetRemoteAlternateDraftModel 清掉。
let lastRemoteAlternate: AlternateDraftModel | null = null;

export function alternateDraftModelFor(key: string, ownerGeneration: number, isLocalDraft: boolean): AlternateDraftModel | null {
  const value = drafts.get(key);
  if (value?.ownerGeneration === ownerGeneration) return value;
  return isLocalDraft && key === NEW_MAKER_DRAFT_KEY && lastRemoteAlternate?.ownerGeneration === ownerGeneration
    ? lastRemoteAlternate : null;
}
export function setAlternateDraftModel(key: string, value: AlternateDraftModel | null, isLocalDraft: boolean): void {
  if (value) {
    drafts.set(key, value);
    if (isLocalDraft && key === NEW_MAKER_DRAFT_KEY) {
      lastRemoteAlternate = value.agentDevice ? value : null;
    }
  } else {
    drafts.delete(key);
  }
}
/** 用户明确改选了别的模型(插件模型 / 插件引擎 / 模型组 / 正常模型)：之后的新建不再沿用远程替代。 */
export function forgetRemoteAlternateDraftModel(key: string, isLocalDraft: boolean): void {
  if (isLocalDraft && key === NEW_MAKER_DRAFT_KEY) lastRemoteAlternate = null;
}
export function useAlternateDraftModel(key: string, ownerGeneration: number, isLocalDraft: boolean) {
  const [value, setValue] = useState(() => alternateDraftModelFor(key, ownerGeneration, isLocalDraft));
  const set = useCallback((next: AlternateDraftModel | null) => {
    setAlternateDraftModel(key, next, isLocalDraft);
    setValue(next);
  }, [key, isLocalDraft]);
  const forget = useCallback(() => forgetRemoteAlternateDraftModel(key, isLocalDraft), [key, isLocalDraft]);
  return [value?.ownerGeneration === ownerGeneration ? value : null, set, forget] as const;
}
