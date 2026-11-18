/**
 * 最近照片条的多选:点缩略图右上角的选择圈才进入多选,选中的照片先留在面板里,
 * 由底部「加入对话」一次提交;不碰选择圈时,点照片仍是单张即加入(见 ContextSheetMediaViews)。
 *
 * 待选集由页面持有(页面还要用它决定面板底部按钮),本文件只提供状态与提交按钮,
 * 会话页、新建任务页与伙伴群聊共用。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextSheetFooterButton, useContextSheetDismissAction } from '@/session/ContextSheet';
import type { ContextSheetMediaAsset } from '@/session/useContextSheetMediaAssets';

export interface ContextSheetMediaSelection {
  /** 待选照片,按选中顺序。 */
  assets: readonly ContextSheetMediaAsset[];
  /** assetId → 选中序号(从 1 起),缩略图选择圈里显示。 */
  order: ReadonlyMap<string, number>;
  /** 选中 / 取消选中一张。 */
  toggle: (asset: ContextSheetMediaAsset) => void;
}

export function useContextSheetMediaSelection({ open, getRemainingSlots, onLimitReached, onChanged }: {
  /** 面板是否打开;每次重新打开都从空的待选集开始(没提交就关掉 = 放弃)。 */
  open: boolean;
  /** 还能再加几张:已附加与正在上传的都算占用。 */
  getRemainingSlots: () => number;
  /** 已选满,再选一张时提示(页面显示附件上限错误)。 */
  onLimitReached: () => void;
  /** 待选集变化(页面借此清掉上一次的上限提示)。 */
  onChanged?: () => void;
}): ContextSheetMediaSelection {
  const [assets, setAssets] = useState<readonly ContextSheetMediaAsset[]>([]);
  // 同一帧内的连续点按读不到尚未提交的 state,上限与去重都按 ref 判断。
  const assetsRef = useRef(assets);
  // 在渲染期清空而不是 effect:重新打开的第一帧就不带上一次的待选,关闭动画期间也不闪。
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open && assetsRef.current.length > 0) {
      assetsRef.current = [];
      setAssets(assetsRef.current);
    }
  }
  const callbacks = useRef({ getRemainingSlots, onLimitReached, onChanged });
  callbacks.current = { getRemainingSlots, onLimitReached, onChanged };

  const toggle = useCallback((asset: ContextSheetMediaAsset) => {
    const current = assetsRef.current;
    const picked = current.some((item) => item.id === asset.id);
    if (!picked && current.length >= callbacks.current.getRemainingSlots()) {
      callbacks.current.onLimitReached();
      return;
    }
    assetsRef.current = picked ? current.filter((item) => item.id !== asset.id) : [...current, asset];
    setAssets(assetsRef.current);
    callbacks.current.onChanged?.();
  }, []);

  const order = useMemo(() => new Map(assets.map((item, index) => [item.id, index + 1])), [assets]);
  return useMemo(() => ({ assets, order, toggle }), [assets, order, toggle]);
}

/** 面板底部的提交按钮:把选择圈选中的照片一次加入;页面在待选非空时放进 ContextSheet 的 footer。 */
export function ContextSheetMediaAddButton({ selection, onAddAssets, disabled, testID }: {
  selection: ContextSheetMediaSelection;
  /** 与单张点选同一入口:同步入队并关闭面板,关闭后再恢复输入。 */
  onAddAssets: (assets: readonly ContextSheetMediaAsset[], dismiss?: (afterClose: () => void) => void) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const dismiss = useContextSheetDismissAction();
  const { t } = useTranslation();
  return (
    <ContextSheetFooterButton
      disabled={disabled}
      label={t('session.common.joinConversation', { num: selection.assets.length })}
      onPress={() => onAddAssets(selection.assets, dismiss)}
      testID={testID}
    />
  );
}
