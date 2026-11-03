import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import {
  getMessageStreamIndicatorResizeTargets,
  measureMessageStreamIndicatorClearanceOffset,
} from '@/components/chat/messageStreamIndicatorPosition';

export interface ComposerOverlayMetrics {
  /** Feeds MessageStream bottomPadding. */
  overlayHeight: number;
  /** Bottom-center clearance for the stream's floating indicators. */
  bottomCenterClearanceOffset: number | undefined;
}

const INITIAL_METRICS: ComposerOverlayMetrics = {
  overlayHeight: 200,
  bottomCenterClearanceOffset: undefined,
};

/**
 * 实测输入区 overlay 的高度与底部中央避让边界。
 *
 * 运行状态行、步骤 / 接管胶囊、多行输入都会让 overlay 变高变矮;新值必须与 overlay 的
 * 尺寸变化同帧提交给消息流。默认优先级的 setState 在切换任务时会排在整列消息的挂载
 * 之后,晚 50–150ms 才生效:贴底的消息先被输入区盖住一截,再整体平移(2026-10-08
 * 实录)。所以观察回调里用 flushSync 提交,并且只在数值真的变化时提交——输入框打字
 * 引起的 DOM 变动不会因此多渲染。
 */
export function useComposerOverlayMetrics(overlayEl: HTMLElement | null): ComposerOverlayMetrics {
  const [metrics, setMetrics] = useState(INITIAL_METRICS);

  // Layout effect: the first paint after the overlay node attaches already uses its geometry.
  useLayoutEffect(() => {
    if (!overlayEl) return;
    let last: ComposerOverlayMetrics | null = null;
    const measure = (sync: boolean) => {
      // 状态行会动态出现 / 收起，overlay 总高度不等于底部中央控件的避让边界。
      // 空中央行仍以 composer 栈为锚；步骤 / 接管胶囊在场时改取中央组顶边，
      // 让消息流悬浮按钮与它们纵向成栈，而不是共享同一块 32px 区域。
      const next: ComposerOverlayMetrics = {
        overlayHeight: overlayEl.offsetHeight,
        bottomCenterClearanceOffset: measureMessageStreamIndicatorClearanceOffset(overlayEl),
      };
      if (
        last &&
        last.overlayHeight === next.overlayHeight &&
        last.bottomCenterClearanceOffset === next.bottomCenterClearanceOffset
      ) {
        return;
      }
      last = next;
      const apply = () =>
        setMetrics((previous) =>
          previous.overlayHeight === next.overlayHeight &&
          previous.bottomCenterClearanceOffset === next.bottomCenterClearanceOffset
            ? previous
            : next,
        );
      // Observer callbacks run outside React work, before the browser paints this frame.
      if (sync) flushSync(apply);
      else apply();
    };
    const ro = new ResizeObserver(() => measure(true));
    let observedTargets = new Set<HTMLElement>();
    const syncResizeTargetsAndMeasure = (sync: boolean) => {
      const nextTargets = new Set(getMessageStreamIndicatorResizeTargets(overlayEl));
      for (const target of observedTargets) {
        if (!nextTargets.has(target)) ro.unobserve(target);
      }
      for (const target of nextTargets) {
        if (!observedTargets.has(target)) ro.observe(target);
      }
      observedTargets = nextTargets;
      measure(sync);
    };

    // Seed with the current geometry so the first paint after remount does not
    // reuse stale state. The plan flyout is absolutely positioned and mounts
    // only on hover/click, so its insertion does not resize the center group;
    // resync observed targets whenever that subtree changes.
    syncResizeTargetsAndMeasure(false);
    const mutationObserver = new MutationObserver(() => syncResizeTargetsAndMeasure(true));
    mutationObserver.observe(overlayEl, { childList: true, subtree: true });
    return () => {
      mutationObserver.disconnect();
      ro.disconnect();
    };
  }, [overlayEl]);

  return metrics;
}
