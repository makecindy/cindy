import { useMemo } from 'react';

import type { InstalledGhost } from '../../shared/ghost';
import type { GhostPanelWindowsState } from '../../shared/ghostPanelWindow';
import {
  useGhostPanelBubbleState,
  type GhostPanelBubbleMap,
} from '../lib/ghostPanelBubbleState';
import { useGhostPanelWindowsState } from '../lib/ghostPanelWindowState';
import { useInstalledGhosts } from './useInstalledGhosts';

/**
 * 两种恢复入口共享的唯一筛选器。只有已装、启用、停靠形态、已最小化且未抽离到
 * 独立窗口的插件面板才允许出现在恢复入口中。
 */
export function selectMinimizedGhostPanels(
  ghosts: readonly InstalledGhost[],
  bubbles: GhostPanelBubbleMap,
  windows: GhostPanelWindowsState,
): InstalledGhost[] {
  return ghosts.filter(
    (ghost) =>
      ghost.enabled !== false &&
      ghost.manifest.panel !== undefined &&
      ghost.manifest.panel.position !== 'tab' &&
      bubbles[ghost.manifest.id]?.minimized === true &&
      windows[ghost.manifest.id]?.detached !== true,
  );
}

export function useMinimizedGhostPanels(): InstalledGhost[] {
  const ghosts = useInstalledGhosts();
  const bubbles = useGhostPanelBubbleState();
  const windows = useGhostPanelWindowsState();
  return useMemo(
    () => selectMinimizedGhostPanels(ghosts, bubbles, windows),
    [bubbles, ghosts, windows],
  );
}
