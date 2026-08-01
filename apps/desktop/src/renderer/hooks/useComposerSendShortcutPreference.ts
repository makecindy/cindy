import { useCallback, useEffect, useState } from 'react';

export type ComposerSendShortcutPreference = 'enter' | 'modifier-enter';

export type ComposerEnterIntent = 'queue' | 'steer' | 'native' | 'ignore' | null;

export type ComposerEnterEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'repeat' | 'isComposing'
>;

export const COMPOSER_SEND_SHORTCUT_STORAGE_KEY = 'chat.sendShortcutPreference';
export const DEFAULT_COMPOSER_SEND_SHORTCUT: ComposerSendShortcutPreference = 'enter';

function parsePreference(raw: string | null): ComposerSendShortcutPreference | null {
  return raw === 'modifier-enter' ? raw : null;
}

/**
 * Decide what the composer should do with an Enter keydown.
 *
 * The resolver deliberately does not perform any side effect. Callers can
 * therefore share the same preference semantics while keeping their own
 * event-target and delivery plumbing.
 */
export function resolveComposerEnterIntent(
  event: ComposerEnterEvent,
  preference: ComposerSendShortcutPreference,
  options: { turnRunning: boolean },
): ComposerEnterIntent {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return null;
  if (event.isComposing) return 'native';
  if (event.repeat) return 'ignore';

  const hasModifier = event.metaKey || event.ctrlKey;
  if (preference === 'modifier-enter') {
    return hasModifier ? 'queue' : 'native';
  }

  if (!hasModifier) return 'queue';
  return options.turnRunning ? 'steer' : 'queue';
}

/** Module-level memory is the synchronous source of truth for event handlers. */
let memoryValue: ComposerSendShortcutPreference | null = null;

const listeners = new Set<() => void>();

export function getComposerSendShortcutPreference(): ComposerSendShortcutPreference {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parsePreference(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage may be unavailable in a restricted renderer.
  }
  return DEFAULT_COMPOSER_SEND_SHORTCUT;
}

export function useComposerSendShortcutPreference(): {
  preference: ComposerSendShortcutPreference;
  isCustomized: boolean;
  setPreference: (next: ComposerSendShortcutPreference) => void;
} {
  const [preference, setState] = useState<ComposerSendShortcutPreference>(
    getComposerSendShortcutPreference,
  );

  const setPreference = useCallback((next: ComposerSendShortcutPreference) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_COMPOSER_SEND_SHORTCUT) {
        localStorage.removeItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY);
      } else {
        localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, next);
      }
    } catch {
      // The in-memory value still applies for this renderer.
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getComposerSendShortcutPreference());
    listeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COMPOSER_SEND_SHORTCUT_STORAGE_KEY) return;
      memoryValue = parsePreference(event.newValue) ?? DEFAULT_COMPOSER_SEND_SHORTCUT;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    preference,
    isCustomized: preference !== DEFAULT_COMPOSER_SEND_SHORTCUT,
    setPreference,
  };
}

/** Test-only reset for the module-level source of truth. */
export function _resetComposerSendShortcutPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}
