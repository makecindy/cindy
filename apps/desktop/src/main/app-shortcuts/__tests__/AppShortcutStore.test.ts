import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AppShortcutStore } from '../AppShortcutStore';
import type { AppShortcutCombo } from '../../../shared/appShortcuts';

let dir: string;

function filePath(): string {
  return path.join(dir, 'app-shortcuts.v1.json');
}

function makeStore(platform = 'darwin', onChanged?: (o: unknown) => void): AppShortcutStore {
  return new AppShortcutStore({ getFilePath: filePath, platform, onChanged });
}

function combo(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-shortcuts-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AppShortcutStore', () => {
  it('returns registry defaults when no overrides exist', () => {
    const store = makeStore('darwin');
    expect(store.getEffectiveCombos('toggle-sidebar')).toEqual([
      expect.objectContaining({ code: 'KeyB', meta: true, ctrl: false }),
    ]);
    expect(store.getOverrides()).toEqual({});
  });

  it('setOverride persists only the override key to disk', () => {
    const store = makeStore('darwin');
    expect(store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }))).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    expect(Object.keys(onDisk.overrides)).toEqual(['toggle-sidebar']);
    // 存储红线: 默认值绝不落盘
    expect(onDisk.overrides['new-maker']).toBeUndefined();

    expect(store.getEffectiveCombos('toggle-sidebar')).toEqual([
      expect.objectContaining({ code: 'KeyJ', meta: true }),
    ]);
    // 未 override 的 id 仍走默认
    expect(store.getEffectiveCombos('new-maker')[0]).toEqual(
      expect.objectContaining({ code: 'KeyN', meta: true }),
    );
  });

  it('rejects invalid override attempts with the right reason', () => {
    const store = makeStore('darwin');
    expect(store.setOverride('nope', combo('KeyJ', { meta: true }))).toBe('unknown-id');
    expect(store.setOverride('toggle-sidebar', { code: '' })).toBe('invalid-combo');
    expect(store.setOverride('toggle-sidebar', combo('KeyJ'))).toBe('not-bindable');
    expect(store.setOverride('toggle-sidebar', combo('KeyC', { meta: true }))).toBe('system-reserved');
    expect(store.setOverride('zoom-in', combo('KeyJ', { ctrl: true }))).toBe('platform-unavailable');
    expect(store.getOverrides()).toEqual({});
  });

  it('rejects combos conflicting with another shortcut in an overlapping scope', () => {
    const store = makeStore('darwin');
    // find-in-page 默认 ⌘F, 与 toggle-sidebar 同属 app 域 → 冲突
    expect(store.setOverride('toggle-sidebar', combo('KeyF', { meta: true }))).toBe('conflict');
    // 与已有 override 也冲突: 先把 toggle-sidebar 改到 ⌘J, 再给 new-maker 绑 ⌘J
    expect(store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }))).toBeNull();
    expect(store.setOverride('new-maker', combo('KeyJ', { meta: true }))).toBe('conflict');
    // workdir-doc 与 browser 可同屏挂载, 同键会在 capture 阶段互相抢事件 → 冲突
    expect(
      store.setOverride('browser-focus-url', combo('KeyF', { meta: true, shift: true })),
    ).toBe('conflict');
    // composer 与 workdir-doc 同屏挂载, 也必须拒绝同键
    expect(
      store.setOverride('cycle-permission-mode', combo('KeyF', { meta: true, shift: true })),
    ).toBe('conflict');
  });

  it('rejects menu-backed combos that cannot map to an accelerator on darwin', () => {
    const store = makeStore('darwin');
    // NumpadAdd 无 accelerator 映射; new-maker 在 mac 只有菜单触发路径 → 拒绝
    expect(store.setOverride('new-maker', combo('NumpadAdd', { meta: true }))).toBe(
      'menu-inexpressible',
    );
    // 非菜单专属 id 不受限 (renderer 匹配路径可用任意 code)
    expect(store.setOverride('save-file', combo('NumpadAdd', { meta: true }))).toBeNull();
    // win32 上 new-maker 走 before-input-event, 不受菜单可表达性限制
    // (IntlYen 无 accelerator 映射且不与任何默认组合撞键)
    const winStore = makeStore('win32');
    expect(winStore.setOverride('new-maker', combo('IntlYen', { ctrl: true }))).toBeNull();
  });

  it('rejects global shortcut combos that Electron cannot register', () => {
    const store = makeStore('win32');
    expect(store.validateOverride(
      'toggle-main-window',
      combo('NumpadAdd', { ctrl: true }),
    )).toBe('global-inexpressible');
    expect(store.setOverride(
      'toggle-main-window',
      combo('NumpadAdd', { ctrl: true }),
    )).toBe('global-inexpressible');
    expect(store.getOverrides()).toEqual({});
  });

  it('setOverride(null) deletes the binding: effective combos become empty', () => {
    const store = makeStore('darwin');
    expect(store.setOverride('find-in-page', null)).toBeNull();
    expect(store.getEffectiveCombos('find-in-page')).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    expect(onDisk.overrides['find-in-page']).toBeNull();
    // 恢复默认后回到 registry 默认
    store.clearOverride('find-in-page');
    expect(store.getEffectiveCombos('find-in-page')[0]!.code).toBe('KeyF');
  });

  it('null overrides survive reload from disk', () => {
    const first = makeStore('darwin');
    first.setOverride('find-in-page', null);
    const second = makeStore('darwin');
    expect(second.getEffectiveCombos('find-in-page')).toEqual([]);
    expect('find-in-page' in second.getOverrides()).toBe(true);
  });

  it('clearOverride restores the default and removes the key from disk', () => {
    const store = makeStore('darwin');
    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    store.clearOverride('toggle-sidebar');
    expect(store.getOverrides()).toEqual({});
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
    expect(onDisk.overrides).toEqual({});
    expect(store.getEffectiveCombos('toggle-sidebar')[0]!.code).toBe('KeyB');
  });

  it('resetAll clears every override', () => {
    const store = makeStore('darwin');
    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    store.setOverride('save-file', combo('KeyO', { meta: true }));
    store.resetAll();
    expect(store.getOverrides()).toEqual({});
  });

  it('keeps memory, disk, and notifications unchanged when writing fails', () => {
    const onChanged = vi.fn();
    const subscriber = vi.fn();
    const store = makeStore('darwin', onChanged);
    store.subscribe(subscriber);
    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    onChanged.mockClear();
    subscriber.mockClear();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => store.setOverride('toggle-sidebar', combo('KeyK', { meta: true }))).toThrow(
      'disk full',
    );
    expect(store.getOverrides()['toggle-sidebar']).toEqual(combo('KeyJ', { meta: true }));
    expect(onChanged).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(filePath(), 'utf-8')).overrides['toggle-sidebar']).toEqual(
      combo('KeyJ', { meta: true }),
    );
    expect(fs.existsSync(`${filePath()}.tmp`)).toBe(false);
    expect(makeStore('darwin').getOverrides()['toggle-sidebar']).toEqual(
      combo('KeyJ', { meta: true }),
    );
  });

  it('keeps a deleted override when clearOverride cannot be persisted', () => {
    const store = makeStore('darwin');
    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('read-only');
    });

    expect(() => store.clearOverride('toggle-sidebar')).toThrow('read-only');
    expect(store.getOverrides()['toggle-sidebar']).toEqual(combo('KeyJ', { meta: true }));
    expect(JSON.parse(fs.readFileSync(filePath(), 'utf-8')).overrides['toggle-sidebar']).toEqual(
      combo('KeyJ', { meta: true }),
    );
  });

  it('keeps all overrides when resetAll cannot be persisted', () => {
    const store = makeStore('darwin');
    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    store.setOverride('save-file', combo('KeyO', { meta: true }));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => store.resetAll()).toThrow('permission denied');
    expect(Object.keys(store.getOverrides())).toEqual(['toggle-sidebar', 'save-file']);
  });

  it('drops unknown ids and corrupt combos on load (self-healing)', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        overrides: {
          'toggle-sidebar': combo('KeyJ', { meta: true }),
          'removed-in-new-version': combo('KeyX', { meta: true }),
          'save-file': { bogus: true },
        },
      }),
    );
    const store = makeStore('darwin');
    expect(Object.keys(store.getOverrides())).toEqual(['toggle-sidebar']);
  });

  it('falls back to defaults on corrupt file', () => {
    fs.writeFileSync(filePath(), 'not json at all');
    const store = makeStore('darwin');
    expect(store.getOverrides()).toEqual({});
    expect(store.getEffectiveCombos('toggle-sidebar')[0]!.code).toBe('KeyB');
  });

  it('notifies subscribers and onChanged on every mutation', () => {
    const onChanged = vi.fn();
    const store = makeStore('darwin', onChanged);
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    store.setOverride('toggle-sidebar', combo('KeyJ', { meta: true }));
    store.clearOverride('toggle-sidebar');
    // 幂等操作不触发
    store.clearOverride('toggle-sidebar');
    store.resetAll();

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(subscriber).toHaveBeenCalledTimes(2);
  });

  it('platform-specific ids resolve per platform', () => {
    const winStore = makeStore('win32');
    expect(winStore.getEffectiveCombos('zoom-in').length).toBeGreaterThan(0);
    expect(winStore.getEffectiveCombos('open-settings')).toEqual([]);
    expect(winStore.getEffectiveCombos('toggle-sidebar')[0]).toEqual(
      expect.objectContaining({ code: 'KeyB', ctrl: true, meta: false }),
    );
  });
});
