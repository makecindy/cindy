import { useCallback, useEffect, useState } from 'react';

import { getVoiceInputSettings } from './useVoiceInputSettings';
import { findComposerVoiceInputConflict } from '@/voice-input/composerVoiceInputConflict';
import { hasComposerModifier } from '@/voice-input/composerShortcut';

export { hasComposerModifier } from '@/voice-input/composerShortcut';

export type ComposerSendShortcutPreference = 'enter' | 'modifier-enter' | 'modifier-enter-multiline';

/** The two concrete key semantics; the multiline preference resolves into one of them per draft. */
export type ComposerSendMode = 'enter' | 'modifier-enter';

export type ComposerEnterIntent = 'queue' | 'steer' | 'native' | 'ignore' | null;

export type ComposerEnterEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'repeat' | 'isComposing'
>;

export type ComposerSendShortcutUpdateResult =
  | { ok: true }
  | { ok: false; conflict: 'composer-voice-input' };

export const COMPOSER_SEND_SHORTCUT_STORAGE_KEY = 'chat.sendShortcutPreference';
export const DEFAULT_COMPOSER_SEND_SHORTCUT: ComposerSendShortcutPreference = 'enter';

export function getComposerModifierShortcutLabel(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘+Enter' : 'Ctrl+Enter';
}

export function getComposerSendShortcutLabel(
  mode: ComposerSendMode,
  platform: string | undefined,
): string {
  return mode === 'modifier-enter' ? getComposerModifierShortcutLabel(platform) : 'Enter';
}

/** Whether the preference relies on modifier+Enter as the only way to send (some drafts, for the multiline mode). */
export function usesModifierSendShortcut(preference: ComposerSendShortcutPreference): boolean {
  return preference !== 'enter';
}

/**
 * Collapse the persisted preference into the concrete key semantics for the
 * current draft. The multiline mode is intentionally not a third branch in the
 * intent resolver: single-line drafts keep the plain-Enter semantics, multiline
 * drafts switch to the modifier semantics wholesale.
 */
export function resolveEffectiveSendMode(
  preference: ComposerSendShortcutPreference,
  multilineDraft: boolean,
): ComposerSendMode {
  if (preference === 'modifier-enter-multiline') return multilineDraft ? 'modifier-enter' : 'enter';
  return preference;
}

function parsePreference(raw: string | null): ComposerSendShortcutPreference | null {
  return raw === 'modifier-enter' || raw === 'modifier-enter-multiline' ? raw : null;
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
  options: { turnRunning: boolean; platform: string | undefined; multilineDraft: boolean },
): ComposerEnterIntent {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return null;
  if (event.isComposing) return 'native';

  const mode = resolveEffectiveSendMode(preference, options.multilineDraft);
  const hasModifier = hasComposerModifier(event, options.platform);
  if (event.repeat) {
    const isSendShortcut = mode === 'enter' || hasModifier;
    return isSendShortcut ? 'ignore' : 'native';
  }

  if (mode === 'modifier-enter') {
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
  setPreference: (next: ComposerSendShortcutPreference) => ComposerSendShortcutUpdateResult;
} {
  const [preference, setState] = useState<ComposerSendShortcutPreference>(
    getComposerSendShortcutPreference,
  );

  const setPreference = useCallback((next: ComposerSendShortcutPreference): ComposerSendShortcutUpdateResult => {
    if (
      findComposerVoiceInputConflict(
        next,
        getVoiceInputSettings().shortcut,
        window.electronAPI?.platform,
      )
    ) {
      return { ok: false, conflict: 'composer-voice-input' };
    }

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
    return { ok: true };
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
