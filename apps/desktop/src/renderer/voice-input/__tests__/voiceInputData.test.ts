import { describe, expect, it } from 'vitest';

import {
  createVoiceInputShortcutFromMacNativeKeys,
  getDefaultVoiceInputSettings,
  isVoiceInputBareFunctionKeyShortcut,
  isVoiceInputMacNativeKeyboardShortcutPressed,
  isVoiceInputMacNativeKeyboardShortcutTargetDown,
  isVoiceInputModifierShortcut,
  normalizeVoiceInputSettings,
  normalizeVoiceInputShortcut,
  voiceInputShortcutNeedsMacNativeListener,
  voiceInputShortcutNeedsWindowsNativeListener,
} from '../../../shared/voiceInputData';
import {
  createVoiceInputModifierShortcut,
  createVoiceInputShortcutFromEvent,
  getVoiceInputBareModifierCodeFromEvent,
} from '../shortcut';

describe('voice input language defaults', () => {
  it('defaults Global to auto and Mainland China to Simplified Chinese', () => {
    expect(getDefaultVoiceInputSettings('darwin', 'global').language).toBe('auto');
    expect(getDefaultVoiceInputSettings('darwin', 'cn').language).toBe('zh-CN');
    expect(getDefaultVoiceInputSettings('darwin', 'dev').language).toBe('auto');
  });

  it('keeps an explicit language instead of replacing it with the region default', () => {
    expect(normalizeVoiceInputSettings({ language: 'en' }, 'darwin', 'cn').language).toBe('en');
    expect(normalizeVoiceInputSettings({ language: 'auto' }, 'darwin', 'cn').language).toBe('auto');
    expect(normalizeVoiceInputSettings({}, 'darwin', 'cn').language).toBe('zh-CN');
  });
});

describe('voice input shortcut normalization', () => {
  it('keeps legacy keyboard shortcuts compatible', () => {
    expect(normalizeVoiceInputShortcut({
      code: 'Space',
      key: ' ',
      modifiers: {
        meta: false,
        ctrl: true,
        alt: false,
        shift: true,
        fn: false,
      },
    })).toEqual({
      trigger: 'keyboard',
      code: 'Space',
      key: ' ',
      modifiers: {
        meta: false,
        ctrl: true,
        alt: false,
        shift: true,
        fn: false,
      },
    });
  });

  it('normalizes legacy shortcuts without function modifiers', () => {
    expect(normalizeVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'Digit1',
      key: '1',
      modifiers: {
        meta: true,
        ctrl: false,
        alt: false,
        shift: false,
      },
    })?.modifiers.fn).toBe(false);
  });

  it('normalizes modifier-only shortcuts without keyboard modifiers', () => {
    const shortcut = normalizeVoiceInputShortcut({
      trigger: 'modifier',
      code: 'MetaLeft',
      key: 'MetaLeft',
      modifiers: {
        meta: true,
        ctrl: true,
        alt: true,
        shift: true,
      },
    });

    expect(shortcut).toEqual({
      trigger: 'modifier',
      code: 'MetaLeft',
      key: 'MetaLeft',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    });
    expect(isVoiceInputModifierShortcut(shortcut)).toBe(true);
  });

  it('rejects unsupported modifier-only shortcut codes', () => {
    expect(normalizeVoiceInputShortcut({
      trigger: 'modifier',
      code: 'ShiftLeft',
      key: 'ShiftLeft',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    })).toBeNull();
  });
});

describe('voice input shortcut recording helpers', () => {
  it('preserves normal keyboard combinations with modifier keys', () => {
    expect(createVoiceInputShortcutFromEvent({
      code: 'Digit1',
      key: '1',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    } as KeyboardEvent)).toEqual({
      trigger: 'keyboard',
      code: 'Digit1',
      key: '1',
      modifiers: {
        meta: true,
        ctrl: false,
        alt: false,
        shift: true,
        fn: false,
      },
    });
  });

  it('detects bare modifier events separately from keyboard combinations', () => {
    const event = {
      code: 'MetaRight',
      key: 'Meta',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;

    expect(getVoiceInputBareModifierCodeFromEvent(event)).toBe('MetaRight');
    expect(createVoiceInputModifierShortcut('MetaRight')).toEqual({
      trigger: 'modifier',
      code: 'MetaRight',
      key: 'MetaRight',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    });
  });

  it('creates macOS native Fn keyboard shortcuts from key snapshots', () => {
    expect(createVoiceInputShortcutFromMacNativeKeys(['Fn', 'KeyCode:18'])).toEqual({
      trigger: 'keyboard',
      code: 'Digit1',
      key: '1',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    });

    expect(createVoiceInputShortcutFromMacNativeKeys(['Fn', 'ShiftLeft', 'KeyCode:18'])).toEqual({
      trigger: 'keyboard',
      code: 'Digit1',
      key: '1',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: true,
        fn: true,
      },
    });
  });

  it('matches macOS native Fn keyboard shortcuts exactly', () => {
    const shortcut = createVoiceInputShortcutFromMacNativeKeys(['Fn', 'ShiftLeft', 'KeyCode:18']);
    expect(shortcut).not.toBeNull();
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Fn', 'ShiftRight', 'KeyCode:18'], shortcut!)).toBe(true);
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['ShiftRight', 'KeyCode:18'], shortcut!)).toBe(false);
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Fn', 'KeyCode:18'], shortcut!)).toBe(false);
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Fn', 'ShiftRight', 'KeyCode:19'], shortcut!)).toBe(false);
  });

  it('routes standalone F1-F24 shortcuts through native press/release listeners', () => {
    const shortcut = normalizeVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    });

    expect(shortcut).not.toBeNull();
    expect(isVoiceInputBareFunctionKeyShortcut(shortcut)).toBe(true);
    expect(voiceInputShortcutNeedsMacNativeListener(shortcut, 'darwin')).toBe(true);
    expect(voiceInputShortcutNeedsMacNativeListener(shortcut, 'win32')).toBe(false);
    expect(voiceInputShortcutNeedsWindowsNativeListener(shortcut, 'win32')).toBe(true);
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Function:F16'], shortcut!)).toBe(true);
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Fn', 'Function:F16'], shortcut!)).toBe(
      false,
    );
    expect(
      isVoiceInputMacNativeKeyboardShortcutPressed(['ShiftLeft', 'Function:F16'], shortcut!),
    ).toBe(false);
    expect(
      isVoiceInputMacNativeKeyboardShortcutTargetDown(['ShiftLeft', 'Function:F16'], shortcut!),
    ).toBe(true);
    expect(isVoiceInputMacNativeKeyboardShortcutTargetDown(['Function:F15'], shortcut!)).toBe(
      false,
    );

    const f24 = normalizeVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'F24',
      key: 'F24',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    });
    expect(isVoiceInputMacNativeKeyboardShortcutPressed(['Function:F24'], f24!)).toBe(true);

    const modified = normalizeVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: true, alt: false, shift: false, fn: false },
    });
    expect(isVoiceInputBareFunctionKeyShortcut(modified)).toBe(false);
    expect(voiceInputShortcutNeedsMacNativeListener(modified, 'darwin')).toBe(false);
    expect(voiceInputShortcutNeedsWindowsNativeListener(modified, 'win32')).toBe(false);
  });
});
