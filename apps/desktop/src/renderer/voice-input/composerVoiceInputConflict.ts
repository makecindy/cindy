import {
  usesModifierSendShortcut,
  type ComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { hasComposerModifier } from './composerShortcut';
import type { VoiceInputShortcut } from './shortcut';

export type ShortcutConflict = 'composer-voice-input' | null;

/**
 * Return a conflict only when Voice Input owns the platform's complete
 * modifier+Enter combination used by Composer's modifier-send modes
 * (always, or for multiline drafts — either way it is the only send key).
 */
export function findComposerVoiceInputConflict(
  preference: ComposerSendShortcutPreference,
  voiceShortcut: VoiceInputShortcut | null,
  platform: string | undefined,
): ShortcutConflict {
  if (!usesModifierSendShortcut(preference) || !voiceShortcut) return null;
  if (voiceShortcut.trigger === 'modifier' || voiceShortcut.modifiers.fn) return null;
  if (voiceShortcut.code !== 'Enter' || voiceShortcut.key !== 'Enter') return null;
  if (voiceShortcut.modifiers.alt || voiceShortcut.modifiers.shift) return null;

  if (
    !hasComposerModifier(
      {
        metaKey: voiceShortcut.modifiers.meta,
        ctrlKey: voiceShortcut.modifiers.ctrl,
      },
      platform,
    )
  ) {
    return null;
  }

  return 'composer-voice-input';
}
