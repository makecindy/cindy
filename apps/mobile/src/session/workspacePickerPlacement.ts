interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspacePickerFrame {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

// Includes the two action rows, separators and the usual recent-project viewport.
export const WORKSPACE_PICKER_MAX_HEIGHT = 336;

/** Host is the visible content area below the top bar and above the keyboard. */
export function resolveWorkspacePickerFrame(
  anchor: WindowRect,
  host: WindowRect,
  gap: number,
): WorkspacePickerFrame {
  const viewportHeight = Math.max(0, host.height - gap * 2);
  const maxHeight = Math.min(WORKSPACE_PICKER_MAX_HEIGHT, viewportHeight);
  const anchorTop = Math.max(0, Math.min(anchor.y - host.y, host.height));
  const anchorBottom = Math.max(0, Math.min(anchor.y - host.y + anchor.height, host.height));
  const above = anchorTop - gap * 2;
  const below = host.height - anchorBottom - gap * 2;
  const horizontal = { left: anchor.x - host.x, width: anchor.width, maxHeight };

  if (above >= maxHeight) {
    return { ...horizontal, bottom: host.height - anchorTop + gap };
  }
  if (below >= maxHeight) {
    return { ...horizontal, top: anchorBottom + gap };
  }
  // Neither side fits: shift within the visible host, rather than shrinking to
  // the sliver above the anchor. All options share one scrollable viewport.
  return {
    ...horizontal,
    top: Math.max(gap, Math.min(anchorTop - gap - maxHeight, host.height - gap - maxHeight)),
  };
}
