export function getVisibleSidebarSessionIds(root?: Document | Element | null): string[] {
  if (root == null && typeof document === 'undefined') return [];
  const queryRoot = root ?? document;
  const ids: string[] = [];
  const seen = new Set<string>();
  const coveringAncestors = findSearchOverlayCoveringAncestors(queryRoot);
  Array.from(
    queryRoot.querySelectorAll<HTMLElement>('[data-sidebar-session-row="true"][data-session-id]'),
  )
    .filter((node) => isRenderedVisible(node, coveringAncestors))
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
  const orderedRow =
    typeof node.closest === 'function'
      ? node.closest<HTMLElement>('[data-sidebar-row-order]')
      : null;
  const raw = orderedRow?.dataset.sidebarRowOrder;
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function findSearchOverlayCoveringAncestors(queryRoot: Document | Element): Element[] {
  const searchRoot =
    queryRoot instanceof Document ? queryRoot : (queryRoot.ownerDocument ?? queryRoot);
  if (typeof searchRoot.querySelectorAll !== 'function') return [];
  const ancestors: Element[] = [];
  for (const overlay of searchRoot.querySelectorAll('[data-conversation-search-overlay]')) {
    if (!(overlay instanceof HTMLElement)) continue;
    const ancestor = overlay.closest('aside, [data-sidebar], nav');
    if (ancestor) ancestors.push(ancestor);
  }
  return ancestors;
}

function isRenderedVisible(node: HTMLElement, coveringAncestors: readonly Element[]): boolean {
  if (isCoveredBySearchOverlay(node, coveringAncestors)) return false;
  if (
    typeof node.closest === 'function' &&
    node.closest('[data-sidebar-section-collapsed="true"]')
  ) {
    return false;
  }
  const view = node.ownerDocument?.defaultView;
  for (let current: HTMLElement | null = node; current != null; current = current.parentElement) {
    if (current.hasAttribute?.('hidden')) return false;

    const style = view?.getComputedStyle?.(current);
    if (!style) continue;
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  }
  return true;
}

/** Sidebar search sits on top of the real list without hiding it. */
function isCoveredBySearchOverlay(
  node: HTMLElement,
  coveringAncestors: readonly Element[],
): boolean {
  if (coveringAncestors.length === 0) return false;
  if (typeof node.closest !== 'function') return false;
  if (node.closest('[data-conversation-search-overlay]')) return false;
  return coveringAncestors.some((ancestor) => ancestor.contains(node));
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
