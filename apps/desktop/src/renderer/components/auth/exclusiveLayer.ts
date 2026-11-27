import { useLayoutEffect, type RefObject } from 'react';

import { acquireAppInteractionLock } from '@/lib/appInteractionLock';

/**
 * 让一层整窗遮挡(协议更新确认及其加载中的透明层)独占交互,直到卸载:
 *
 * - 加应用交互锁(全局快捷键不在背后执行);
 * - 把焦点移到 `focusTarget`(缺省为遮挡层本身),卸载时归还原焦点;
 * - 背景兄弟节点 inert,**之后新挂到 body 下的节点同样 inert**——任何来源的弹窗(Radix portal
 *   等)在遮挡期间出现,都只能留在下面,不能抢焦点或接收输入;遮挡解除时一并恢复;
 * - 焦点若被移到遮挡层之外(例如新弹窗的焦点陷阱),立即拉回。
 *
 * 遮挡层自身需要 `pointer-events: auto`:Radix 模态打开时会把 body 设为 pointer-events: none。
 *
 * 集中在这里处理,而不是要求每个会弹窗的宿主各自暂缓:新增宿主时不会再漏。
 * 用 layout effect,在浏览器绘制、用户能操作之前就生效;前后两层遮挡切换在同一次提交里交接。
 */
export function useExclusiveLayer(
  rootRef: RefObject<HTMLElement | null>,
  focusTargetRef?: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const releaseLock = acquireAppInteractionLock();
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusInside = () => (focusTargetRef?.current ?? root).focus();
    focusInside();

    const inerted = new Set<HTMLElement>();
    const makeInert = (node: Node) => {
      if (node instanceof HTMLElement && node !== root && !node.contains(root) && !node.inert) {
        node.inert = true;
        inerted.add(node);
      }
    };
    const host = root.parentElement;
    if (host) for (const child of Array.from(host.children)) makeInert(child);
    const observer = host
      ? new MutationObserver((records) => {
          for (const record of records) record.addedNodes.forEach(makeInert);
        })
      : null;
    observer?.observe(host!, { childList: true });

    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) focusInside();
    };
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      observer?.disconnect();
      document.removeEventListener('focusin', onFocusIn, true);
      for (const el of inerted) el.inert = false;
      releaseLock();
      opener?.focus();
    };
  }, [rootRef, focusTargetRef]);
}
