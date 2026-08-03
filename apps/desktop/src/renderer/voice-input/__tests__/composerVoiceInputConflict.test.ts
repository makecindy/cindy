import { describe, expect, it } from 'vitest';

import { findComposerVoiceInputConflict } from '../composerVoiceInputConflict';
import type { VoiceInputShortcut } from '../shortcut';

type ShortcutOverrides = Omit<Partial<VoiceInputShortcut>, 'modifiers'> & {
  modifiers?: Partial<VoiceInputShortcut['modifiers']>;
};

function shortcut(overrides: ShortcutOverrides = {}): VoiceInputShortcut {
  const { modifiers: overrideModifiers, ...shortcutOverrides } = overrides;
  return {
    trigger: 'keyboard',
    code: 'Enter',
    key: 'Enter',
    ...shortcutOverrides,
    modifiers: {
      meta: false,
      ctrl: true,
      alt: false,
      shift: false,
      fn: false,
      ...overrideModifiers,
    },
  };
}

describe('findComposerVoiceInputConflict', () => {
  it.each([
    ['darwin', shortcut({ modifiers: { meta: true, ctrl: false } })],
    ['darwin', shortcut()],
    ['win32', shortcut()],
    ['linux', shortcut()],
  ] as const)('detects the platform modifier+Enter conflict on %s', (platform, voiceShortcut) => {
    expect(findComposerVoiceInputConflict('modifier-enter', voiceShortcut, platform)).toBe(
      'composer-voice-input',
    );
  });

  it.each([
    ['default Composer mode', 'enter', shortcut(), 'win32'],
    [
      'plain Enter',
      'modifier-enter',
      shortcut({ modifiers: { meta: false, ctrl: false } }),
      'win32',
    ],
    [
      'wrong platform modifier',
      'modifier-enter',
      shortcut({ modifiers: { meta: true, ctrl: false } }),
      'win32',
    ],
    ['Alt+Enter', 'modifier-enter', shortcut({ modifiers: { alt: true } }), 'win32'],
    ['Shift+Enter', 'modifier-enter', shortcut({ modifiers: { shift: true } }), 'win32'],
    ['Fn+Enter', 'modifier-enter', shortcut({ modifiers: { fn: true } }), 'win32'],
    [
      'modifier-only shortcut',
      'modifier-enter',
      shortcut({ trigger: 'modifier', code: 'ControlLeft', key: 'ControlLeft' }),
      'win32',
    ],
    ['empty Voice Input shortcut', 'modifier-enter', null, 'win32'],
  ] as const)('does not flag %s', (_name, preference, voiceShortcut, platform) => {
    expect(findComposerVoiceInputConflict(preference, voiceShortcut, platform)).toBeNull();
  });

  it('matches the Composer modifier logic when both platform modifiers are held', () => {
    expect(
      findComposerVoiceInputConflict(
        'modifier-enter',
        shortcut({ modifiers: { meta: true, ctrl: true } }),
        'darwin',
      ),
    ).toBe('composer-voice-input');
  });
});
