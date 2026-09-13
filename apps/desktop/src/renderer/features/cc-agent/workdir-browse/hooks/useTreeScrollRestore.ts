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
 *   - 容器尺寸变化（RSB 隐藏 tab 切回、doc 模式搜索态切回）：只在容器「从隐藏变
 *     可见」（0 → 非 0）或仍有待完成的恢复时对齐 —— 浏览器对 display:none 期间
 *     scrollTop 的处理并不一致，不能赌它自己保留；但用户接管后的普通 resize
 *     （拖动侧栏 / 缩放窗口）不能无条件回拉可能已过期的锚点（评审 P2）。
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
  type TreeScrollAnchor,
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
  /** 最近一次观察到的视口顶部行（onScroll 更新）。换到没有历史锚点的 scope 时
   *  继承它 —— 否则新树的 DOM 保留旧像素 scrollTop，而被忽略目录 / 分批数据在
   *  上方插入行后，视口会落到另一批条目上（评审 P2）。 */
  const lastAnchorRef = useRef<TreeScrollAnchor | null>(null);
  /** 还有一次「待完成」的恢复：scope 变化 / 重新激活时置位。
   *  注意：找到锚点行后**不**立即清除 —— 换 store 时新树是分批长出来的，锚点行
   *  的 index 会随后续数据到达而位移，要跟到树稳定为止。清除只发生在用户自己
   *  滚动时（用户接管）。 */
  const pendingRestoreRef = useRef(true);
  /** 我们自己写进的 scrollTop；用来识别并忽略由它触发的那次 scroll 事件，
   *  否则会把程序性滚动误判成用户滚动、提前交还控制权。 */
  const programmaticScrollRef = useRef<number | null>(null);
  if (scopeRef.current !== scope) {
    const previousScope = scopeRef.current;
    scopeRef.current = scope;
    // 首次进入的 scope（例如第一次打开「显示被忽略的目录」）没有历史锚点：继承
    // 切换前视口顶部的行，保持「看同一批条目」。只继承一次，之后由滚动 / 接管更新。
    if (!loadTreeScrollAnchor(scope)) {
      const inherited = lastAnchorRef.current ?? loadTreeScrollAnchor(previousScope);
      if (inherited) saveTreeScrollAnchor(scope, inherited);
    }
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
    // 目标可能超出当前可滚范围（树还在长），先按容器现状钳一次 —— 这样
    // programmaticScrollRef 与浏览器实际落点一致，不会把钳位误判成用户滚动。
    // jsdom 无布局（scrollHeight 恒 0）时跳过钳位，否则会把所有恢复都钳成 0。
    const maxScroll =
      el.scrollHeight > 0 ? Math.max(0, el.scrollHeight - el.clientHeight) : target;
    const clamped = Math.min(target, maxScroll);
    if (Math.abs(el.scrollTop - clamped) >= RESTORE_EPSILON_PX) {
      programmaticScrollRef.current = clamped;
      el.scrollTop = clamped;
    }
    // 保持 pending：后续 rows 变化（数据分批到达 / 树稳定过程）继续对齐锚点行。
    return true;
  }, [containerRef]);

  // 挂载 / 换 scope / 重新激活 / 行数据更新后重试。赶在 paint 之前写 scrollTop，
  // 避免先画在顶部再跳。
  useLayoutEffect(() => {
    if (pendingRestoreRef.current && active) tryRestore();
  }, [active, rows, scope, tryRestore]);

  // 容器尺寸恢复（补充路径）：隐藏 tab / 隐藏视图切回时恢复视口位置。
  //
  // 只在两种情况下恢复：
  //   - 容器刚从隐藏变可见（0 → 非 0）：display:none 期间 scrollTop 可能被浏览器
  //     复位，这里是唯一可靠的恢复时机；
  //   - 仍有一次待完成的恢复（pending）：对齐锚点行还在进行中。
  // 其余 resize（拖动侧栏 / 缩放窗口）不动视口 —— 用户接管后锚点可能已经落后于
  // 当前行（上方行在无 scroll 事件的情况下增删），无条件恢复会把刚展开的内容
  // 推出视口（评审 P2：过期锚点）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = el.clientHeight;
      const wasHidden = lastHeight === 0;
      lastHeight = height;
      if (height > 0 && (pendingRestoreRef.current || wasHidden)) tryRestore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, tryRestore]);

  // 用户对行的操作（点击展开 / 选中）也算接管：sticky 锚点只在数据分批到达
  // 期间需要；一旦交互就交还控制权 —— 否则首次滚动前点击展开锚点行上方的目录
  // 会被立刻回拉，刚展开的内容被推出视口（reviewer P3）。
  // 注意：滚动条拖拽不在此列 —— Chromium 不向页面派发滚动条的 pointer 事件，
  // 那种接管靠随后的 scroll 事件；且顶部行未变的行内微幅拖动会被 anchoring
  // 守卫当作非接管（有意的窄代价）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const takeover = () => {
      pendingRestoreRef.current = false;
    };
    el.addEventListener('pointerdown', takeover, { passive: true });
    return () => el.removeEventListener('pointerdown', takeover);
  }, [containerRef]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    // 隐藏态 scrollTop 会复位成 0，那不是用户位置，不能覆盖已有锚点。
    if (!el || el.clientHeight === 0) return;
    const current = computeTreeScrollAnchor(rowsRef.current, el.scrollTop);
    // 记录最近一次真实视口位置：换到没有历史锚点的 scope 时用它继承（评审 P2）。
    if (current) lastAnchorRef.current = current;
    if (pendingRestoreRef.current) {
      const anchor = loadTreeScrollAnchor(scopeRef.current);
      const expected = programmaticScrollRef.current;
      programmaticScrollRef.current = null;
      // 我们自己的恢复写入：忽略。
      if (expected !== null && Math.abs(el.scrollTop - expected) < RESTORE_EPSILON_PX) return;
      // 浏览器 scroll anchoring：行插入/删除时 Chrome 会自行调 scrollTop，但顶部仍是
      // 锚点行 —— 这不代表用户接管，保持 pending，继续跟随树的变化。
      if (anchor && current && current.rowKey === anchor.rowKey) return;
    }
    if (!current) return;
    pendingRestoreRef.current = false; // 用户自己滚了 = 放弃本次恢复
    saveTreeScrollAnchor(scopeRef.current, current);
  }, [containerRef]);

  return onScroll;
}
