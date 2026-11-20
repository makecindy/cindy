import { useEffect } from 'react';

/** True only when the right-click point falls inside the current non-empty selection. */
export function hasTextSelectionAtPoint(
  clientX: number,
  clientY: number,
  selection: Pick<Selection, 'getRangeAt' | 'isCollapsed' | 'rangeCount' | 'toString'> | null,
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (!selection.toString().trim()) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const rects = selection.getRangeAt(index).getClientRects();
    for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      const rect = rects.item(rectIndex);
      if (
        rect
        && clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * F3: Disable right-click context menu on non-input areas.
 * Uses event delegation at the document level.
 * Preserves context menu for input, textarea, select, and contenteditable elements
 * so users can still copy/paste via right-click in those areas.
 */
export function useDisableContextMenu(): void {
  useEffect(() => {
    function handleContextMenu(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Allow context menu for input elements
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLSelectElement) return;

      // Allow context menu for contenteditable elements and their children
      const editableAncestor = target.closest('[contenteditable="true"]');
      if (editableAncestor) return;

      // Read-only text selections use the main-process platform menu (macOS
      // Copy + Look Up, or Windows/Linux Copy + web search). Keep suppressing the
      // generic browser context menu everywhere else.
      if (hasTextSelectionAtPoint(e.clientX, e.clientY, window.getSelection())) return;

      e.preventDefault();
    }

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);
}
