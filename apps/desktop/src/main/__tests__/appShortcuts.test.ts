import { describe, expect, it } from 'vitest';

import {
  APP_SHORTCUT_DEFINITIONS,
  appShortcutCombosEqual,
  appShortcutScopesOverlap,
  comboToElectronAccelerator,
  createAppShortcutComboFromEvent,
  formatAppShortcutCombo,
  getEffectiveAppShortcuts,
  isAppShortcutAvailableOnPlatform,
  isAppShortcutComboBindable,
  matchesElectronInput,
  matchesKeyboardEvent,
  normalizeAppShortcutCombo,
  normalizeAppShortcutOverrides,
  type AppShortcutCombo,
} from '../../shared/appShortcuts';
import { isMacReservedShortcut, isWindowsReservedShortcut } from '../../shared/keyboardReserved';

function combo(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

function keyboardEvent(code: string, mods: Partial<AppShortcutCombo> = {}) {
  return {
    code,
    metaKey: Boolean(mods.meta),
    ctrlKey: Boolean(mods.ctrl),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
  };
}

function electronInput(code: string, mods: Partial<AppShortcutCombo> = {}) {
  return {
    code,
    meta: Boolean(mods.meta),
    control: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

describe('matching', () => {
  it('matches exact modifier state only', () => {
    const c = combo('KeyB', { meta: true });
    expect(matchesKeyboardEvent(keyboardEvent('KeyB', { meta: true }), c)).toBe(true);
    expect(matchesKeyboardEvent(keyboardEvent('KeyB', { meta: true, shift: true }), c)).toBe(false);
    expect(matchesKeyboardEvent(keyboardEvent('KeyB', { ctrl: true }), c)).toBe(false);
    expect(matchesKeyboardEvent(keyboardEvent('KeyC', { meta: true }), c)).toBe(false);
  });

  it('KeyboardEvent and Electron Input forms are symmetric for all registry defaults', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const def of APP_SHORTCUT_DEFINITIONS) {
        if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
        for (const c of def.getDefaultCombos(platform)) {
          const pressedVariants: Array<Partial<AppShortcutCombo>> = [
            { meta: c.meta, ctrl: c.ctrl, alt: c.alt, shift: c.shift },
            { meta: !c.meta, ctrl: c.ctrl, alt: c.alt, shift: c.shift },
            { meta: c.meta, ctrl: c.ctrl, alt: c.alt, shift: !c.shift },
          ];
          for (const pressed of pressedVariants) {
            expect(matchesKeyboardEvent(keyboardEvent(c.code, pressed), c)).toBe(
              matchesElectronInput(electronInput(c.code, pressed), c),
            );
          }
        }
      }
    }
  });
});

describe('comboToElectronAccelerator', () => {
  it('maps letters, digits, punctuation and named keys', () => {
    expect(comboToElectronAccelerator(combo('KeyB', { meta: true }), 'darwin')).toBe('Command+B');
    expect(comboToElectronAccelerator(combo('KeyN', { ctrl: true }), 'win32')).toBe('Ctrl+N');
    expect(comboToElectronAccelerator(combo('Comma', { meta: true }), 'darwin')).toBe('Command+,');
    expect(comboToElectronAccelerator(combo('Digit0', { ctrl: true }), 'win32')).toBe('Ctrl+0');
    expect(comboToElectronAccelerator(combo('F5'), 'win32')).toBe('F5');
    expect(comboToElectronAccelerator(combo('ArrowLeft', { alt: true }), 'win32')).toBe('Alt+Left');
    expect(comboToElectronAccelerator(combo('Tab', { shift: true }), 'darwin')).toBe('Shift+Tab');
  });

  it('meta maps to Super on non-darwin', () => {
    expect(comboToElectronAccelerator(combo('KeyB', { meta: true }), 'win32')).toBe('Super+B');
  });

  it('returns null for unmappable codes', () => {
    expect(comboToElectronAccelerator(combo('IntlYen', { ctrl: true }), 'win32')).toBeNull();
    expect(comboToElectronAccelerator(combo('NumpadAdd', { ctrl: true }), 'win32')).toBeNull();
  });
});

describe('formatAppShortcutCombo', () => {
  it('formats mac with symbol modifiers and no separator', () => {
    expect(formatAppShortcutCombo(combo('KeyB', { meta: true }), 'darwin')).toBe('⌘B');
    expect(formatAppShortcutCombo(combo('Tab', { shift: true }), 'darwin')).toBe('⇧Tab');
    expect(formatAppShortcutCombo(combo('KeyF', { meta: true, shift: true }), 'darwin')).toBe('⇧⌘F');
    expect(formatAppShortcutCombo(combo('Comma', { meta: true }), 'darwin')).toBe('⌘,');
  });

  it('formats windows with + separator', () => {
    expect(formatAppShortcutCombo(combo('KeyB', { ctrl: true }), 'win32')).toBe('Ctrl+B');
    expect(formatAppShortcutCombo(combo('Tab', { shift: true }), 'win32')).toBe('Shift+Tab');
    expect(formatAppShortcutCombo(combo('Equal', { ctrl: true }), 'win32')).toBe('Ctrl+=');
    expect(formatAppShortcutCombo(combo('F5'), 'win32')).toBe('F5');
  });
});

describe('overrides normalization and effective merge', () => {
  it('defines right sidebar tab cycling defaults with primary and fallback combos', () => {
    const mac = getEffectiveAppShortcuts({}, 'darwin');
    expect(mac.get('right-tab-prev')).toEqual([
      combo('BracketLeft', { meta: true, shift: true }),
      combo('Tab', { ctrl: true, shift: true }),
    ]);
    expect(mac.get('right-tab-next')).toEqual([
      combo('BracketRight', { meta: true, shift: true }),
      combo('Tab', { ctrl: true }),
    ]);

    for (const platform of ['win32', 'linux']) {
      const effective = getEffectiveAppShortcuts({}, platform);
      expect(effective.get('right-tab-prev')).toEqual([
        combo('PageUp', { ctrl: true }),
        combo('Tab', { ctrl: true, shift: true }),
      ]);
      expect(effective.get('right-tab-next')).toEqual([
        combo('PageDown', { ctrl: true }),
        combo('Tab', { ctrl: true }),
      ]);
    }
  });

  it('drops unknown ids, invalid combos and platform-unavailable ids', () => {
    const normalized = normalizeAppShortcutOverrides(
      {
        'toggle-sidebar': combo('KeyJ', { meta: true }),
        'not-a-real-id': combo('KeyX', { meta: true }),
        'save-file': { code: '' },
        'zoom-in': combo('Equal', { ctrl: true, shift: true }),
      },
      'darwin',
    );
    expect(Object.keys(normalized)).toEqual(['toggle-sidebar']);
  });

  it('keeps platform-specific ids on their platform', () => {
    const normalized = normalizeAppShortcutOverrides(
      { 'zoom-in': combo('KeyK', { ctrl: true }) },
      'win32',
    );
    expect(normalized['zoom-in']).toBeTruthy();
  });

  it('drops stale overrides colliding with a non-rebindable default (mod+W)', () => {
    // close-tab-or-window (不可改绑, 默认 mod+W) 引入前, 用户可能已把其它动作
    // override 到同一组合。load 归一化必须丢弃这类撞键 override 自愈回默认值,
    // 否则消费端各自的监听会与保留键动作并发触发。
    const win = normalizeAppShortcutOverrides(
      {
        'browser-reload': combo('KeyW', { ctrl: true }),
        'toggle-sidebar': combo('KeyJ', { ctrl: true }),
      },
      'win32',
    );
    expect('browser-reload' in win).toBe(false);
    expect(win['toggle-sidebar']).toBeTruthy();

    const mac = normalizeAppShortcutOverrides(
      { 'open-terminal': combo('KeyW', { meta: true }) },
      'darwin',
    );
    expect('open-terminal' in mac).toBe(false);
    // 撞键 override 被丢弃后, 该 id 回落默认组合
    const effective = getEffectiveAppShortcuts(mac, 'darwin');
    expect(effective.get('open-terminal')!.length).toBeGreaterThan(0);
  });

  it('null override (deleted binding) yields an empty effective combo list', () => {
    const normalized = normalizeAppShortcutOverrides({ 'find-in-page': null }, 'darwin');
    expect('find-in-page' in normalized).toBe(true);
    expect(normalized['find-in-page']).toBeNull();
    const effective = getEffectiveAppShortcuts(normalized, 'darwin');
    expect(effective.get('find-in-page')).toEqual([]);
  });

  it('override replaces the whole default combo list', () => {
    const effective = getEffectiveAppShortcuts(
      { 'browser-reload': combo('KeyR', { ctrl: true, shift: true }) },
      'win32',
    );
    expect(effective.get('browser-reload')).toHaveLength(1);
    // 未 override 的 id 保持默认多组合
    expect(effective.get('zoom-in')!.length).toBeGreaterThan(1);
  });

  it('excludes ids not available on the platform', () => {
    const mac = getEffectiveAppShortcuts({}, 'darwin');
    expect(mac.has('zoom-in')).toBe(false);
    expect(mac.has('open-settings')).toBe(true);
    const win = getEffectiveAppShortcuts({}, 'win32');
    expect(win.has('zoom-in')).toBe(true);
    expect(win.has('open-settings')).toBe(false);
  });

  it('normalizeAppShortcutCombo rejects modifier-only codes', () => {
    expect(normalizeAppShortcutCombo({ code: 'ShiftLeft', shift: true })).toBeNull();
    expect(normalizeAppShortcutCombo(combo('KeyA', { ctrl: true }))).toEqual(
      expect.objectContaining({ code: 'KeyA', ctrl: true }),
    );
  });
});

describe('recording and bindability', () => {
  it('createAppShortcutComboFromEvent returns null for modifier-only presses', () => {
    expect(
      createAppShortcutComboFromEvent({
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      createAppShortcutComboFromEvent({
        code: 'KeyK',
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual(expect.objectContaining({ code: 'KeyK', meta: true }));
  });

  it('isAppShortcutComboBindable enforces bare-key rules', () => {
    expect(isAppShortcutComboBindable(combo('KeyB', { meta: true }))).toBe(true);
    expect(isAppShortcutComboBindable(combo('F6'))).toBe(true);
    expect(isAppShortcutComboBindable(combo('KeyB'))).toBe(false);
    expect(isAppShortcutComboBindable(combo('Tab', { shift: true }))).toBe(true);
    expect(isAppShortcutComboBindable(combo('KeyB', { shift: true }))).toBe(false);
  });
});

describe('scopes and equality', () => {
  it('app scope overlaps everything and workdir-doc overlaps contexts it can coexist with', () => {
    expect(appShortcutScopesOverlap('app', 'browser')).toBe(true);
    expect(appShortcutScopesOverlap('workdir-doc', 'app')).toBe(true);
    expect(appShortcutScopesOverlap('browser', 'workdir-doc')).toBe(true);
    expect(appShortcutScopesOverlap('workdir-doc', 'browser')).toBe(true);
    expect(appShortcutScopesOverlap('composer', 'workdir-doc')).toBe(true);
    expect(appShortcutScopesOverlap('workdir-doc', 'composer')).toBe(true);
    expect(appShortcutScopesOverlap('composer', 'browser')).toBe(false);
    expect(appShortcutScopesOverlap('composer', 'composer')).toBe(true);
  });

  it('appShortcutCombosEqual ignores display key', () => {
    expect(
      appShortcutCombosEqual(
        { ...combo('KeyB', { meta: true }), key: 'b' },
        { ...combo('KeyB', { meta: true }), key: 'B' },
      ),
    ).toBe(true);
  });
});

describe('shared reserved-shortcut tables (extracted from voice-input)', () => {
  it('keeps the same mac verdicts as the pre-extraction implementation', () => {
    expect(isMacReservedShortcut({ code: 'KeyC', meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isMacReservedShortcut({ code: 'Comma', meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isMacReservedShortcut({ code: 'KeyZ', meta: true, ctrl: false, alt: false, shift: true })).toBe(true);
    expect(isMacReservedShortcut({ code: 'KeyB', meta: true, ctrl: false, alt: false, shift: false })).toBe(false);
  });

  it('reserves mac native menu role accelerators (they fire before renderer keydown)', () => {
    // ⌘Q 退出 / ⌘H 隐藏 / ⌘M 最小化 / ⌘W 关窗 / ⌘0 与 ⌘= 与 ⌘- 缩放
    for (const code of ['KeyQ', 'KeyH', 'KeyM', 'KeyW', 'Digit0', 'Equal', 'Minus']) {
      expect(isMacReservedShortcut({ code, meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    }
    // ⇧⌘= 即 ⌘+ (zoomIn) / ⌥⌘H 隐藏其他 / ⌃⌘F 全屏
    expect(isMacReservedShortcut({ code: 'Equal', meta: true, ctrl: false, alt: false, shift: true })).toBe(true);
    expect(isMacReservedShortcut({ code: 'KeyH', meta: true, ctrl: false, alt: true, shift: false })).toBe(true);
    expect(isMacReservedShortcut({ code: 'KeyF', meta: true, ctrl: true, alt: false, shift: false })).toBe(true);
    // ⌘F / ⌘J 等应用可自用的组合不受影响
    expect(isMacReservedShortcut({ code: 'KeyF', meta: true, ctrl: false, alt: false, shift: false })).toBe(false);
    expect(isMacReservedShortcut({ code: 'KeyJ', meta: true, ctrl: false, alt: false, shift: false })).toBe(false);
  });

  it('keeps the same windows verdicts as the pre-extraction implementation', () => {
    expect(isWindowsReservedShortcut({ code: 'Space', meta: false, ctrl: true, alt: false, shift: false })).toBe(true);
    expect(isWindowsReservedShortcut({ code: 'Tab', meta: false, ctrl: false, alt: true, shift: false })).toBe(true);
    expect(isWindowsReservedShortcut({ code: 'KeyL', meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isWindowsReservedShortcut({ code: 'KeyB', meta: false, ctrl: true, alt: false, shift: false })).toBe(false);
  });

  it('does not reserve right sidebar tab cycling defaults', () => {
    expect(isMacReservedShortcut({ code: 'BracketLeft', meta: true, ctrl: false, alt: false, shift: true })).toBe(false);
    expect(isMacReservedShortcut({ code: 'BracketRight', meta: true, ctrl: false, alt: false, shift: true })).toBe(false);
    expect(isMacReservedShortcut({ code: 'Tab', meta: false, ctrl: true, alt: false, shift: false })).toBe(false);
    expect(isMacReservedShortcut({ code: 'Tab', meta: false, ctrl: true, alt: false, shift: true })).toBe(false);
    expect(isWindowsReservedShortcut({ code: 'PageUp', meta: false, ctrl: true, alt: false, shift: false })).toBe(false);
    expect(isWindowsReservedShortcut({ code: 'PageDown', meta: false, ctrl: true, alt: false, shift: false })).toBe(false);
    expect(isWindowsReservedShortcut({ code: 'Tab', meta: false, ctrl: true, alt: false, shift: false })).toBe(false);
    expect(isWindowsReservedShortcut({ code: 'Tab', meta: false, ctrl: true, alt: false, shift: true })).toBe(false);
  });
});
