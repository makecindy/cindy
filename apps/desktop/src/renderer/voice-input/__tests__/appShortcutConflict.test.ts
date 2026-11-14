import { describe, expect, it, vi } from 'vitest';

import type { AppShortcutCombo } from '../../../shared/appShortcuts';
import type { VoiceInputShortcut } from '../shortcut';
import {
  findVoiceInputAppShortcutConflict,
  voiceInputShortcutToAppShortcutCombo,
} from '../appShortcutConflict';

function combo(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

function voiceShortcut(
  code: string,
  mods: Partial<VoiceInputShortcut['modifiers']> = {},
): VoiceInputShortcut {
  return {
    trigger: 'keyboard',
    code,
    key: code,
    modifiers: {
      meta: Boolean(mods.meta),
      ctrl: Boolean(mods.ctrl),
      alt: Boolean(mods.alt),
      shift: Boolean(mods.shift),
      fn: Boolean(mods.fn),
    },
  };
}

describe('voice input app shortcut conflicts', () => {
  it('converts regular keyboard voice shortcuts to app shortcut combos', () => {
    expect(voiceInputShortcutToAppShortcutCombo(voiceShortcut('KeyB', { meta: true }))).toEqual(
      expect.objectContaining({ code: 'KeyB', meta: true, ctrl: false, alt: false, shift: false }),
    );
  });

  it('does not convert modifier-only or Fn-backed shortcuts', () => {
    expect(voiceInputShortcutToAppShortcutCombo({
      trigger: 'modifier',
      code: 'MetaLeft',
      key: 'MetaLeft',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    })).toBeNull();
    expect(voiceInputShortcutToAppShortcutCombo(voiceShortcut('Digit1', { fn: true }))).toBeNull();
  });

  it('finds an app shortcut that already owns the same combo', () => {
    expect(
      findVoiceInputAppShortcutConflict(voiceShortcut('KeyB', { meta: true }), [
        { id: 'new-maker', combos: [combo('KeyN', { meta: true })] },
        { id: 'toggle-sidebar', combos: [combo('KeyB', { meta: true })] },
      ]),
    ).toBe('toggle-sidebar');
  });
});

// PR #10218：通过真实 renderer store 观察账号切换后快捷键显示/冲突表的变化，无需 DOM。
it('refreshes renderer arbitration on auth changes without a voice settings write', async () => {
  const { getAppShortcutCombos, subscribeAppShortcuts, matchesPluginAppShortcut } = await import('../../lib/appShortcutStore');
  let authChanged = () => {};
  let shortcut: VoiceInputShortcut | null = voiceShortcut('KeyL', { ctrl: true, shift: true });
  const api = {
    platform: 'darwin', osRelease: '23.0.0',
    appShortcuts: { getState: () => ({ platform: 'darwin', overrides: {}, globalFailures: [] }), onChanged: () => () => {} },
    voiceInput: { getDataSnapshot: () => ({ settings: { shortcut } }), onDataChanged: () => () => {} },
    onAuthStateChange: (cb: () => void) => { authChanged = cb; return () => {}; },
  };
  vi.stubGlobal('window', { electronAPI: api });
  const changed = vi.fn();
  const unsubscribe = subscribeAppShortcuts(changed);
  try {
    expect(getAppShortcutCombos('away-guard')).toEqual([]);
    shortcut = null;
    authChanged();
    expect(getAppShortcutCombos('away-guard')).toHaveLength(1);
    shortcut = voiceShortcut('KeyL', { ctrl: true, shift: true });
    authChanged();
    expect(getAppShortcutCombos('away-guard')).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    shortcut = null;
    api.osRelease = '22.6.0';
    authChanged();
    expect(getAppShortcutCombos('away-guard')).toEqual([]);
    expect(matchesPluginAppShortcut({ code: 'KeyL', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false } as KeyboardEvent, 'Ctrl+Shift+L')).toBe(true);
  } finally { unsubscribe(); vi.unstubAllGlobals(); }
});
