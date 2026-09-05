import { useCallback, useEffect, useMemo } from 'react';
import { clearQuickSwitcherFocus, useQuickSwitcherFocus } from '@/state/quickSwitcherFocus';
import { normalizeProjectKey } from '../lib/projectGrouping';
import { revealQuickSwitcherTarget } from '../lib/quickSwitcherReveal';
import type { useCollapsedProjects } from './useCollapsedProjects';

/** Navigation-only expansion shared by pinned and regular project rows. */
export function useQuickSwitcherProjectReveal(
  collapse: ReturnType<typeof useCollapsedProjects>,
  activeProjectKeys: readonly string[],
) {
  const quickFocus = useQuickSwitcherFocus();
  const focusedProjectKey = quickFocus?.project?.projectKey;
  const collapsed = useMemo(() => {
    if (!focusedProjectKey || !collapse.collapsed.has(focusedProjectKey)) return collapse.collapsed;
    const visible = new Set(collapse.collapsed);
    visible.delete(focusedProjectKey);
    return visible;
  }, [collapse.collapsed, focusedProjectKey]);

  useEffect(() => {
    if (!quickFocus) return;
    return revealQuickSwitcherTarget({
      kind: quickFocus.kind,
      sessionId: quickFocus.session?.id ?? null,
      projectKey: quickFocus.project?.projectKey ?? null,
    });
  }, [quickFocus]);

  // Explicit user actions end the temporary override. Toggling a revealed row
  // means collapse, even when its saved state was already collapsed.
  const toggle = useCallback(
    (projectKey: string) => {
      const key = normalizeProjectKey(projectKey);
      if (!key) return;
      if (key === focusedProjectKey) collapse.setCollapsed(key, true);
      else collapse.toggle(key);
      clearQuickSwitcherFocus();
    },
    [collapse.setCollapsed, collapse.toggle, focusedProjectKey],
  );
  const collapseAll = useCallback(() => {
    collapse.collapseAll();
    clearQuickSwitcherFocus();
  }, [collapse.collapseAll]);
  const expandAll = useCallback(() => {
    collapse.expandAll();
    clearQuickSwitcherFocus();
  }, [collapse.expandAll]);

  return {
    collapsed,
    isAllCollapsed:
      activeProjectKeys.length > 0 && activeProjectKeys.every((key) => collapsed.has(key)),
    toggle,
    collapseAll,
    expandAll,
  };
}
