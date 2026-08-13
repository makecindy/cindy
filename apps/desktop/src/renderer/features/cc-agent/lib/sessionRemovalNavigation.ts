export function getVisibleSidebarSessionIds(root?: Document | Element | null): string[] {
  if (root == null && typeof document === 'undefined') return [];
  const queryRoot = root ?? document;
  const ids: string[] = [];
  const seen = new Set<string>();
  Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-sidebar-session-row="true"][data-session-id]'))
    .filter(isRenderedVisible)
    .sort(compareSidebarRowOrder)
    .forEach((node) => {
      const id = node.dataset.sessionId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });
  return ids;
}

function compareSidebarRowOrder(a: HTMLElement, b: HTMLElement): number {
  const aOrder = getSidebarRowOrder(a);
  const bOrder = getSidebarRowOrder(b);
  if (aOrder == null && bOrder == null) return 0;
  if (aOrder == null) return 1;
  if (bOrder == null) return -1;
  return aOrder - bOrder;
}

function getSidebarRowOrder(node: HTMLElement): number | null {
  const orderedRow = typeof node.closest === 'function'
    ? node.closest<HTMLElement>('[data-sidebar-row-order]')
    : null;
  const raw = orderedRow?.dataset.sidebarRowOrder;
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRenderedVisible(node: HTMLElement): boolean {
  const view = node.ownerDocument?.defaultView;
  if (isCoveredBySearchOverlay(node)) return false;
  for (let current: HTMLElement | null = node; current != null; current = current.parentElement) {
    if (current.hasAttribute?.('hidden')) return false;

    const style = view?.getComputedStyle?.(current);
    if (!style) continue;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  }
  return true;
}

/** Sidebar search sits on top of the real list without hiding it. */
function isCoveredBySearchOverlay(node: HTMLElement): boolean {
  if (typeof node.closest !== 'function') return false;
  if (node.closest('[data-conversation-search-overlay]')) return false;
  const root = node.ownerDocument;
  if (!root) return false;
  for (const overlay of root.querySelectorAll('[data-conversation-search-overlay]')) {
    if (!(overlay instanceof HTMLElement)) continue;
    if (overlay.contains(node)) continue;
    const ancestor = node.closest('aside, [data-sidebar], nav');
    if (ancestor && ancestor.contains(overlay)) return true;
  }
  return false;
}

export function pickSessionIdAfterRemoval(
  orderedSessionIds: readonly string[],
  removedSessionIds: ReadonlySet<string>,
  anchorSessionId: string,
): string | null {
  const anchorIndex = orderedSessionIds.indexOf(anchorSessionId);
  if (anchorIndex < 0) return null;

  for (let index = anchorIndex + 1; index < orderedSessionIds.length; index += 1) {
    const sessionId = orderedSessionIds[index];
    if (!removedSessionIds.has(sessionId)) return sessionId;
  }

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const sessionId = orderedSessionIds[index];
    if (!removedSessionIds.has(sessionId)) return sessionId;
  }

  return null;
}
