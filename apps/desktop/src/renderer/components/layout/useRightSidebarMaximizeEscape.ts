import { useEffect } from 'react';

/** Owns the background sidebar's Escape listener while maximized. */
export function useRightSidebarMaximizeEscape(maximized: boolean, onExit: () => void) {
  useEffect(() => {
    if (!maximized) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat ||
        e.altKey || e.ctrlKey || e.metaKey || e.shiftKey
      ) return;
      // Foreground owners may run later on window, or keep their DOM mounted
      // through an exit animation. Do not depend on listener registration order.
      if (document.querySelector(
        '[data-lightbox-layer], [data-morph-side], [role="dialog"][aria-modal="true"], [role="alertdialog"], [data-radix-popper-content-wrapper]',
      )) return;
      // 输入态让路 —— 用户在 input / contenteditable 里按 Esc 通常是取消编辑。
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.closest?.('[contenteditable="true"]')
      ) {
        return;
      }
      e.preventDefault();
      onExit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [maximized, onExit]);
}
