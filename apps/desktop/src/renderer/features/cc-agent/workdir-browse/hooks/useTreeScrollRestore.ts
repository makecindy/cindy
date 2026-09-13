/**
 * useTreeScrollRestore — 文件树视口的滚动位置保存 / 恢复。
 *
 * 保存：滚动容器的 onScroll 里持续把「顶部行 + 行内偏移」写进 treeScrollStore。
 *   用 onScroll 而不是卸载/切换时读 scrollTop —— 后者要跟 React 提交顺序、条件
 *   分支、DOM 回收赛跑，实测做不到可靠（隐藏容器读到的 scrollTop 已经是 0）。
 *
 * 恢复：在一个视图「重新可见」或「换了 store/行数据」后，把锚点行重新对齐到视口
 *   顶部。三类触发：
 *   - 组件挂载 / scope（视口 + store key）变化：useLayoutEffect 里尝试，赶在
 *     绘制前完成，不闪。
 *   - 锚点行还不在树里（新 store 数据未到 / 父目录还没展开）：保持 pending，
 *     每次 rows 变化再试，行一出现就恢复。用户只要一滚动就放弃（用户接管）。
 *   - 容器尺寸变化（RSB 隐藏 tab 切回、doc 模式搜索态切回）：每次 ResizeObserver
 *     回调（可见时）都重新对齐 —— 浏览器对 display:none 期间 scrollTop 的处理
 *     并不一致，不能赌它自己保留。用户没移动时这一步就是 no-op。
 *
 * 不依赖虚拟器：行高固定，目标 scrollTop 由「行索引 × pitch」直接算出，
 * 设置后浏览器会派发 scroll 事件让虚拟器自己跟上。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import {
  computeTreeRestoreScrollTop,
  computeTreeScrollAnchor,
  loadTreeScrollAnchor,
  saveTreeScrollAnchor,
} from '../lib/treeScrollStore';
import type { TreeRow } from '../lib/treeRows';

/** 小于这个差值就不动 scrollTop（避免无谓的 scroll 事件 / 子像素抖动）。 */
const RESTORE_EPSILON_PX = 1;

export function useTreeScrollRestore(
  scope: string,
  rows: readonly TreeRow[],
  containerRef: RefObject<HTMLElement | null>,
  active = true,
): () => void {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scopeRef = useRef(scope);
  /** 还有一次「待完成」的恢复：scope 变化 / 重新激活时置位，恢复成功或用户滚动后清除。 */
  const pendingRestoreRef = useRef(true);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    pendingRestoreRef.current = true;
  }
  // 宿主 tab 从非激活变激活（RSB 多标签）：重新尝试恢复。宿主直接告知比赌
  // ResizeObserver 能不能看到 0 尺寸更可靠（浏览器对 display:none 是否回调不一致）。
  const activeRef = useRef(active);
  if (activeRef.current !== active) {
    activeRef.current = active;
    if (active) pendingRestoreRef.current = true;
  }

  const tryRestore = useCallback((): boolean => {
    const el = containerRef.current;
    // 不可见（隐藏 tab）时布局高度为 0，此时写 scrollTop 没有意义；保持 pending，
    // 等可见性恢复的回调再来。
    if (!el || el.clientHeight === 0) return false;
    const anchor = loadTreeScrollAnchor(scopeRef.current);
    if (!anchor) {
      pendingRestoreRef.current = false;
      return true;
    }
    const target = computeTreeRestoreScrollTop(rowsRef.current, anchor);
    if (target === null) return false; // 锚点行还没进树：继续等 rows 变化
    pendingRestoreRef.current = false;
    if (Math.abs(el.scrollTop - target) >= RESTORE_EPSILON_PX) {
      el.scrollTop = target;
    }
    return true;
  }, [containerRef]);

  // 挂载 / 换 scope / 重新激活 / 行数据更新后重试。赶在 paint 之前写 scrollTop，
  // 避免先画在顶部再跳。
  useLayoutEffect(() => {
    if (pendingRestoreRef.current && active) tryRestore();
  }, [active, rows, scope, tryRestore]);

  // 容器尺寸恢复：隐藏 tab / 隐藏视图切回时恢复视口位置。
  //
  // 不跟踪 0 → 非 0 的跳变：浏览器对 display:none 是否派发 RO 回调并不一致，
  // 漏一次 0 就会丢掉后续的恢复机会。每次回调（可见时）都调 tryRestore —— 用户
  // 没有移动时锚点就是当前顶部行，目标是当前 scrollTop，写入被 eps 守回；只有
  // 浏览器把位置复位（或锚点行被折叠后复活）时才会真的动。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) tryRestore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, tryRestore]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    // 隐藏态 scrollTop 会复位成 0，那不是用户位置，不能覆盖已有锚点。
    if (!el || el.clientHeight === 0) return;
    const anchor = computeTreeScrollAnchor(rowsRef.current, el.scrollTop);
    if (!anchor) return;
    pendingRestoreRef.current = false; // 用户自己滚了 = 放弃本次恢复
    saveTreeScrollAnchor(scopeRef.current, anchor);
  }, [containerRef]);

  return onScroll;
}
