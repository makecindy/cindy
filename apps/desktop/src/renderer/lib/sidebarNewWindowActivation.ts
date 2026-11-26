/**
 * Shared platform-aware gesture helpers for opening sidebar targets in a new window.
 *
 * Plan A cross-platform convention:
 * - macOS: Cmd+click (metaKey only; Ctrl+click is the OS context menu gesture)
 * - Windows / Linux: Ctrl+click (ctrlKey only; Meta/Win/Super belongs to the OS,
 *   and Alt+drag is intercepted by many Linux window managers)
 * - All platforms: middle mouse button (auxclick, button === 1)
 */

export interface SidebarClickModifiers {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  button?: number;
}

export type SidebarModifierPlatform = 'darwin' | 'other';

export function resolveSidebarPlatform(platform?: string): SidebarModifierPlatform {
  const value =
    platform ??
    (typeof window !== 'undefined' ? window.electronAPI?.platform : undefined) ??
    (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
      ? 'darwin'
      : 'other');
  return value === 'darwin' ? 'darwin' : 'other';
}

/** True when only the platform's primary modifier (Cmd on macOS, Ctrl on Windows/Linux) is held. */
export function isSidebarPrimaryModifier(
  event: Pick<SidebarClickModifiers, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  platform?: string,
): boolean {
  if (event.shiftKey || event.altKey) return false;
  return resolveSidebarPlatform(platform) === 'darwin'
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);
}

/** True when a click/auxclick/Enter gesture requests opening a sidebar entry in a new window. */
export function isSidebarNewWindowActivation(
  event: SidebarClickModifiers,
  platform?: string,
): boolean {
  if (event.button === 1) return true;
  if (event.button !== undefined && event.button !== 0) return false;
  return isSidebarPrimaryModifier(event, platform);
}

/** Prevent Chromium's Windows/Linux middle-click autoscroll icon on scrollable sidebar lists. */
export function preventMiddleClickAutoscroll(
  event: Pick<MouseEvent, 'button' | 'preventDefault'>,
): void {
  if (event.button === 1) event.preventDefault();
}

export function extractSidebarClickModifiers(
  event: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'button'>,
): SidebarClickModifiers {
  return {
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    button: event.button,
  };
}

export type SidebarNewWindowShortcutKey =
  | 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutMac'
  | 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther';

export function getSidebarNewWindowShortcutKey(platform?: string): SidebarNewWindowShortcutKey {
  return resolveSidebarPlatform(platform) === 'darwin'
    ? 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutMac'
    : 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther';
}

export function openTargetInNewWindow(
  target: string,
  deviceId?: string | null,
  messageClientId?: string | null,
): Promise<void> | undefined {
  return window.electronAPI?.maker?.openSessionInNewWindow(target, deviceId, messageClientId);
}

export type SidebarSessionClickAction =
  | { kind: 'open-new-window' }
  | { kind: 'update-selection'; selectedIds: Set<string>; anchorId: string }
  | { kind: 'navigate'; anchorId: string; clearSelection: boolean };

/**
 * Pure click-intent state machine for sidebar task rows (Plan A):
 * - Programmatic calls without modifiers (`⌘1..9` / knob) navigate and clear selection.
 * - Middle-click (`button === 1`) always opens in a new window.
 * - `Shift+click` enters or extends range multi-select (additive with Cmd/Ctrl).
 * - While multi-select is active (`selectedIds.size > 0`), plain or Cmd/Ctrl clicks
 *   toggle that row in the selection; unselecting the last row exits multi-select.
 * - Outside multi-select, `Cmd+click` (macOS) / `Ctrl+click` (Windows/Linux) opens
 *   in a new window; ordinary clicks navigate in the current window.
 */
export function resolveSidebarSessionClickAction(input: {
  id: string;
  modifiers?: SidebarClickModifiers;
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
  getVisibleIds: () => readonly string[];
  platform?: string;
}): SidebarSessionClickAction {
  const { id, modifiers, selectedIds, anchorId, getVisibleIds, platform } = input;
  if (!modifiers) {
    return { kind: 'navigate', anchorId: id, clearSelection: selectedIds.size > 0 };
  }
  if (modifiers.button === 1) {
    return { kind: 'open-new-window' };
  }
  if (modifiers.shiftKey) {
    const visibleIds = getVisibleIds();
    const visibleIdSet = new Set(visibleIds);
    const resolvedAnchor = anchorId && visibleIds.includes(anchorId) ? anchorId : id;
    const anchorIndex = visibleIds.indexOf(resolvedAnchor);
    const targetIndex = visibleIds.indexOf(id);
    const rangeIds =
      anchorIndex >= 0 && targetIndex >= 0
        ? visibleIds.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          )
        : [id];
    const next = modifiers.metaKey || modifiers.ctrlKey ? new Set(selectedIds) : new Set<string>();
    for (const rangeId of rangeIds) {
      if (visibleIdSet.has(rangeId)) next.add(rangeId);
    }
    return { kind: 'update-selection', selectedIds: next, anchorId: anchorId ?? id };
  }
  if (selectedIds.size > 0) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    return { kind: 'update-selection', selectedIds: next, anchorId: id };
  }
  if (isSidebarNewWindowActivation(modifiers, platform)) {
    return { kind: 'open-new-window' };
  }
  return { kind: 'navigate', anchorId: id, clearSelection: false };
}
