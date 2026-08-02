import type { ComposerSendShortcutPreference } from '@/hooks/useComposerSendShortcutPreference';
import type { VoiceInputShortcut } from './shortcut';

export type ShortcutConflict = 'composer-voice-input' | null;

/**
 * Return a conflict only when Voice Input owns the platform's complete
 * modifier+Enter combination used by Composer's modifier-send mode.
 */
export function findComposerVoiceInputConflict(
  preference: ComposerSendShortcutPreference,
  voiceShortcut: VoiceInputShortcut | null,
  platform: string | undefined,
): ShortcutConflict {
  if (preference !== 'modifier-enter' || !voiceShortcut) return null;
  if (voiceShortcut.trigger === 'modifier' || voiceShortcut.modifiers.fn) return null;
  if (voiceShortcut.code !== 'Enter' || voiceShortcut.key !== 'Enter') return null;
  if (voiceShortcut.modifiers.alt || voiceShortcut.modifiers.shift) return null;

  const isMac = platform === 'darwin';
  const hasPlatformModifier = isMac ? voiceShortcut.modifiers.meta : voiceShortcut.modifiers.ctrl;
  const hasOtherPlatformModifier = isMac
    ? voiceShortcut.modifiers.ctrl
    : voiceShortcut.modifiers.meta;
  if (!hasPlatformModifier || hasOtherPlatformModifier) return null;

  return 'composer-voice-input';
}
