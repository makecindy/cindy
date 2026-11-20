import { useCallback, useEffect, useState } from 'react';

import { getVoiceInputSettings } from './useVoiceInputSettings';
import type { ComposerFollowUpBehavior } from './useComposerFollowUpPreference';
import { findComposerVoiceInputConflict } from '@/voice-input/composerVoiceInputConflict';
import { getComposerModifierShortcutLabel, hasComposerModifier } from '@/voice-input/composerShortcut';

export { getComposerModifierShortcutLabel, hasComposerModifier } from '@/voice-input/composerShortcut';

export type ComposerSendShortcutPreference = 'enter' | 'modifier-enter';

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

export function getComposerSendShortcutLabel(
  preference: ComposerSendShortcutPreference,
  platform: string | undefined,
): string {
  return preference === 'modifier-enter' ? getComposerModifierShortcutLabel(platform) : 'Enter';
}

function parsePreference(raw: string | null): ComposerSendShortcutPreference | null {
  return raw === 'modifier-enter' ? raw : null;
}

/**
 * Decide what the composer should do with an Enter keydown.
 *
 * The resolver deliberately does not perform any side effect. Callers can
 * therefore share the same preference semantics while keeping their own
 * event-target and delivery plumbing.
 *
 * The send shortcut only decides which key sends. While a turn runs, the
 * sending key delivers `followUpBehavior` (queue or steer); when idle it is an
 * ordinary send. Composers that do not expose the preference omit it and keep
 * the legacy mapping: Enter queues, modifier+Enter in Enter mode steers.
 *
 * `alternateOnModifier` is for composers that offer both modes for one message
 * (the send button's delivery tip): with Enter as the send key, modifier+Enter
 * sends this message the other way. When modifier+Enter is itself the send key
 * there is no second key, so the option has no effect.
 */
export function resolveComposerEnterIntent(
  event: ComposerEnterEvent,
  preference: ComposerSendShortcutPreference,
  options: {
    turnRunning: boolean;
    platform: string | undefined;
    followUpBehavior?: ComposerFollowUpBehavior;
    alternateOnModifier?: boolean;
  },
): ComposerEnterIntent {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return null;
  if (event.isComposing) return 'native';

  const hasModifier = hasComposerModifier(event, options.platform);
  if (event.repeat) {
    const isSendShortcut = preference === 'enter' || hasModifier;
    return isSendShortcut ? 'ignore' : 'native';
  }

  const { followUpBehavior } = options;
  // Idle sends are ordinary sends; queue/steer only differ while a turn runs.
  const deliver = (mode: ComposerFollowUpBehavior) => (options.turnRunning ? mode : 'queue');

  if (preference === 'modifier-enter') {
    return hasModifier ? deliver(followUpBehavior ?? 'queue') : 'native';
  }

  if (followUpBehavior === undefined) return deliver(hasModifier ? 'steer' : 'queue');
  if (hasModifier && options.alternateOnModifier) {
    return deliver(followUpBehavior === 'steer' ? 'queue' : 'steer');
  }
  return deliver(followUpBehavior);
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
