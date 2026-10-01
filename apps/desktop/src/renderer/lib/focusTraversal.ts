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

/** 文档序的全部可 Tab 元素（可见性判据与 Radix FocusScope 的 getTabbableCandidates 同源）。 */
function collectTabbables(root: Document): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const walkerRoot = root.documentElement ?? root.body;
  if (!walkerRoot) return nodes;
  const walker = root.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT, {
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
  return nodes.filter((element) => !isHiddenForFocus(element));
}

function isHiddenForFocus(node: HTMLElement): boolean {
  if (node.ownerDocument.defaultView?.getComputedStyle(node).visibility === 'hidden') return true;
  let cursor: HTMLElement | null = node;
  while (cursor) {
    if (cursor.ownerDocument.defaultView?.getComputedStyle(cursor).display === 'none') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

/**
 * Tab 出卡：`cardRoot` 是浮层内容根（`PopoverContent` 渲染的元素）。
 * 返回 true = 本次 Tab 已被接管（调用方应阻止默认行为与 Radix 的环回）。
 */
export function handOffTabFromCard(
  cardRoot: HTMLElement,
  event: { shiftKey: boolean },
): boolean {
  const tabbables = collectTabbables(cardRoot.ownerDocument);
  if (tabbables.length === 0) return false;
  const active = cardRoot.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !cardRoot.contains(active)) return false;

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
