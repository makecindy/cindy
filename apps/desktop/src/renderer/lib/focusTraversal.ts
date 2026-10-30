/**
 * 底栏卡片的 Tab 走廊：把「卡片内最后一个/第一个可 Tab 边缘」的 Tab 交出卡外。
 *
 * 为什么需要：Radix 的 `PopoverContentImpl` 给 FocusScope 写死 `loop: true`
 * （trapped 才跟随 modal），Tab 在卡内永远环回 —— 键盘焦点一旦进卡，就再也走不到
 * 底栏右边下一枚 chip（用户实测：Tab 到「用量明细」卡后停在原地）。
 * Radix 不透传 `loop`，所以我们在它之前（React 的 onKeyDownCapture 先于同元素的
 * onKeyDown bubble）接管卡的两个 Tab 边缘：
 *   - Tab 在**最后一个**可 Tab 边 → 焦点交给卡外 DOM 序的下一个可 Tab 元素；
 *   - Shift+Tab 在**第一个**可 Tab 边 → 焦点交给卡外 DOM 序的上一个（回到触发器方向）。
 * 卡内其余 Tab 行为不变（多行卡的行间移动照旧自然进行）。
 */

/**
 * 文档序的可 Tab 元素（可见性判据与 Radix FocusScope 的 getTabbableCandidates 同源）。
 * `scope` 限定扫描子树：卡内边缘判定只扫卡片子树（小），只有真要出卡时才扫全文档。
 */
function collectTabbables(scope: Document | HTMLElement): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const walkerRoot = scope instanceof Document ? (scope.documentElement ?? scope.body) : scope;
  if (!walkerRoot) return nodes;
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  const walker = doc.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as HTMLElement;
      const isHiddenInput = element instanceof HTMLInputElement && element.type === 'hidden';
      if (element.hasAttribute('disabled') || element.hidden || isHiddenInput) {
        return NodeFilter.FILTER_SKIP;
      }
      return element.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as HTMLElement);
  const hiddenCache = new Map<Element, boolean>();
  return nodes.filter((element) => !isHiddenForFocus(element, hiddenCache));
}

/**
 * 隐藏判定带记忆化：一次扫描里共享父节点（卡片根、容器等）只查一次 getComputedStyle。
 * 缓存语义：`cache.get(el) === true` = el 因自身或祖先隐藏而不可聚焦（其子树同判）；
 * `false` = el 到根全可见。路径节点的缓存值在**定论后统一回写**——中途发现外层
 * 隐藏时，先前按可见缓存的中间层必须一起改判，否则同容器的兄弟元素会命中过期的
 * false，把 display:none 里的按钮当成可聚焦目标（Greptile P1）。
 */
function isHiddenForFocus(node: HTMLElement, hiddenCache: Map<Element, boolean>): boolean {
  const cached = hiddenCache.get(node);
  if (cached !== undefined) return cached;
  const view = node.ownerDocument.defaultView;
  const path: HTMLElement[] = [];
  let hidden = view?.getComputedStyle(node).visibility === 'hidden';
  let cursor: HTMLElement | null = node;
  while (!hidden && cursor) {
    path.push(cursor);
    hidden = view?.getComputedStyle(cursor).display === 'none';
    const parent: HTMLElement | null = cursor.parentElement;
    if (!hidden && parent) {
      const parentCached = hiddenCache.get(parent);
      if (parentCached !== undefined) { hidden = parentCached; break; }
    }
    cursor = parent;
  }
  for (const element of path) hiddenCache.set(element, hidden);
  return hidden;
}

/**
 * Tab 出卡：`cardRoot` 是浮层内容根（`PopoverContent` 渲染的元素）。
 * 返回 true = 本次 Tab 已被接管（调用方应阻止默认行为与 Radix 的环回）。
 */
export function handOffTabFromCard(
  cardRoot: HTMLElement,
  event: { shiftKey: boolean },
): boolean {
  const active = cardRoot.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !cardRoot.contains(active)) return false;

  // 先只扫卡片子树判边缘：不在边缘立即放行（不扫全文档 —— Tab 是高频按键，
  // 长聊天记录下每次全页 TreeWalker + getComputedStyle 会拖慢键盘移动）。
  const inside = collectTabbables(cardRoot);
  if (inside.length === 0) return false;
  const atLastEdge = !event.shiftKey && active === inside[inside.length - 1];
  const atFirstEdge = event.shiftKey && active === inside[0]!;
  if (!atLastEdge && !atFirstEdge) return false;

  // 只有边缘的 Tab 才值得做全文档序定位，找出卡外目标。
  const tabbables = collectTabbables(cardRoot.ownerDocument);
  if (tabbables.length === 0) return false;
  const activeIndex = tabbables.indexOf(active);
  if (activeIndex === -1) return false;
  const lastInside = (() => {
    for (let i = tabbables.length - 1; i >= 0; i -= 1) {
      if (cardRoot.contains(tabbables[i]!)) return i;
    }
    return -1;
  })();
  const firstInside = tabbables.findIndex((element) => cardRoot.contains(element));
  if (lastInside === -1 || firstInside === -1) return false;

  if (!event.shiftKey && active === tabbables[lastInside]!) {
    const next = tabbables[lastInside + 1];
    if (!next) return false;
    next.focus();
    return true;
  }
  if (event.shiftKey && active === tabbables[firstInside]!) {
    const previous = firstInside > 0 ? tabbables[firstInside - 1]! : null;
    if (!previous) return false;
    previous.focus();
    return true;
  }
  return false;
}
