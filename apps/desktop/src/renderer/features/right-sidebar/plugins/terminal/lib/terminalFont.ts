import type { Terminal } from '@xterm/xterm';

import { DEFAULT_TERMINAL_FONT_FAMILY } from '@/../shared/appearanceSettings';
import type { TerminalFontSettings } from './useTerminalFontSettings';

/** Applies font options only when loaded and measurable, without owning the PTY or focus. */
export function createTerminalFontController(
  terminal: Terminal,
  canMeasure: () => boolean,
  onApplied: () => void,
) {
  let generation = 0;
  let disposed = false;
  let frame: number | null = null;
  let pending: { family: string; size: number } | null = null;

  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  const flush = (): boolean => {
    if (disposed || !pending || !canMeasure()) return false;
    const next = pending;
    pending = null;
    if (terminal.options.fontFamily === next.family && terminal.options.fontSize === next.size) {
      return false;
    }
    // xterm measures character cells when these options change. Assigning a
    // webfont before loading it, then only fitting, would retain fallback metrics.
    terminal.options.fontFamily = next.family;
    terminal.options.fontSize = next.size;
    onApplied();
    return true;
  };

  return {
    update({ terminalFamily, terminalSize }: TerminalFontSettings) {
      const request = ++generation;
      pending = null;
      cancelFrame();
      if (disposed) return;
      const family = terminalFamily
        ? `${terminalFamily}, ${DEFAULT_TERMINAL_FONT_FAMILY}`
        : DEFAULT_TERMINAL_FONT_FAMILY;
      if (terminal.options.fontFamily === family && terminal.options.fontSize === terminalSize) {
        return;
      }
      const ready = (loadedFamily: string) => {
        if (disposed || request !== generation) return;
        pending = { family: loadedFamily, size: terminalSize };
        frame = requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      };
      // System fonts can resolve to an empty FontFace list; that is still success.
      try {
        if (!document.fonts?.load) {
          ready(family);
        } else {
          void document.fonts.load(`${terminalSize}px ${family}`, 'W0 ')
            .then(() => ready(family), () => ready(DEFAULT_TERMINAL_FONT_FAMILY));
        }
      } catch {
        ready(DEFAULT_TERMINAL_FONT_FAMILY);
      }
    },
    flush,
    dispose() {
      disposed = true;
      generation += 1;
      pending = null;
      cancelFrame();
    },
  };
}
