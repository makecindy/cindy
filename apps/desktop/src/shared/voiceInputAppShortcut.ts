import type { AppShortcutCombo } from './appShortcuts';
import type { VoiceInputShortcut } from './voiceInputData';

/**
 * Keep Main and Renderer voice conflicts identical. Modifier-only and Fn-backed
 * shortcuts use native paths and cannot collide with app shortcut listeners.
 */
export function voiceInputShortcutToAppShortcutCombo(
  shortcut: VoiceInputShortcut,
): AppShortcutCombo | null {
  if (shortcut.trigger === 'modifier' || shortcut.modifiers.fn) return null;
  return {
    code: shortcut.code,
    key: shortcut.key,
    meta: shortcut.modifiers.meta,
    ctrl: shortcut.modifiers.ctrl,
    alt: shortcut.modifiers.alt,
    shift: shortcut.modifiers.shift,
  };
}
