import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOverrideSettingsFile, setPreserveUnreadableSettingsFilesByDefault } from '../override-settings-file.js';

interface TestSettings {
  enabled: boolean;
  limit: number;
  nested: { a: number; b: number };
}

const DEFAULTS: TestSettings = {
  enabled: true,
  limit: 5,
  nested: { a: 1, b: 2 },
};

function createTempStore(
  existing?: { dir: string; file: string },
  options: {
    logLoadedValue?: boolean;
    logReadErrorDetails?: boolean;
    maxBytes?: number;
    preserveUnreadableFile?: boolean;
    scopeKey?: () => string;
    validateOverrides?: (raw: Record<string, unknown>) => void;
  } = {},
) {
  const dir = existing?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-override-settings-'));
  const file = existing?.file ?? path.join(dir, 'settings.json');
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const store = createOverrideSettingsFile<TestSettings>({
    filePath: () => file,
    defaults: DEFAULTS,
    normalize: (raw) => {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      return {
        enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
        limit: typeof r.limit === 'number' ? r.limit : DEFAULTS.limit,
        nested:
          r.nested && typeof r.nested === 'object' && !Array.isArray(r.nested)
            ? {
                a:
                  typeof (r.nested as Record<string, unknown>).a === 'number'
                    ? (r.nested as Record<string, number>).a
                    : DEFAULTS.nested.a,
                b:
                  typeof (r.nested as Record<string, unknown>).b === 'number'
                    ? (r.nested as Record<string, number>).b
                    : DEFAULTS.nested.b,
              }
            : DEFAULTS.nested,
      };
    },
    log,
    label: 'test',
    maxBytes: options.maxBytes,
    preserveUnreadableFile: options.preserveUnreadableFile,
    logLoadedValue: options.logLoadedValue,
    logReadErrorDetails: options.logReadErrorDetails,
    scopeKey: options.scopeKey,
    validateOverrides: options.validateOverrides,
  });

  return { dir, file, store, log };
}

describe('host settings CAS and pure inspection', () => {
  it('preserves unreadable bytes without logging or silently supplying defaults', async () => {
    const { dir, file, store, log } = createTempStore();
    try {
      fs.writeFileSync(file, '{private-invalid');
      expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
      await expect(store.commitAtomic({ set: { limit: 7 } })).rejects.toMatchObject({ code: 'UNREADABLE' });
      expect(fs.readFileSync(file, 'utf8')).toBe('{private-invalid');
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps explicit default values and clears individual keys with same-lock CAS', async () => {
    const first = createTempStore();
    const second = createTempStore(first);
    try {
      const initial = first.store.inspect();
      if (initial.status !== 'ready') throw new Error('test setup');
      const results = await Promise.allSettled([
        first.store.commitAtomic({ set: { enabled: true } }, { expectedRevision: initial.revision }),
        second.store.commitAtomic({ set: { limit: 9 } }, { expectedRevision: initial.revision }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const state = await first.store.commitAtomic({ set: { enabled: true, limit: 9 } });
      expect(state.customizedKeys).toEqual(expect.arrayContaining(['enabled', 'limit']));
      const cleared = await first.store.commitAtomic({ clear: ['enabled'] }, { expectedRevision: state.revision });
      expect(cleared.customizedKeys).toEqual(['limit']);
    } finally { fs.rmSync(first.dir, { recursive: true, force: true }); }
  });

  it('rechecks the owner and caller inside the write lock and notifies only saved writes', async () => {
    let owner = 'owner-a:1';
    const { dir, file, store } = createTempStore(undefined, { scopeKey: () => owner });
    const listener = vi.fn();
    const unsubscribe = store.onChanged(listener);
    try {
      const write = store.commitAtomic({ set: { limit: 7 } });
      owner = 'owner-b:2';
      await expect(write).rejects.toMatchObject({ code: 'SCOPE_CHANGED' });
      expect(fs.existsSync(file)).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      const assertCurrent = vi.fn();
      await store.commitAtomic({ set: { limit: 7 } }, { assertCurrent });
      expect(assertCurrent).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      await store.writePatchAtomic({ limit: 8 });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('shared final validation and bounded inspection', () => {
  it.each(['sync', 'atomic', 'update'] as const)('keeps the opted-in validator off ordinary %s writes; only cloud commits check it', async (kind) => {
    const validateOverrides = vi.fn((raw: Record<string, unknown>) => {
      if (raw.limit !== undefined && (typeof raw.limit !== 'number' || raw.limit > 10)) throw new Error('invalid limit');
    });
    const { dir, store } = createTempStore(undefined, { validateOverrides });
    try {
      store.writePatch({ limit: 7 });
      if (kind === 'sync') store.writePatch({ limit: 99 });
      else if (kind === 'atomic') await store.writePatchAtomic({ limit: 99 });
      else await store.updateAtomic(() => ({ limit: 99 }));
      expect(store.read()).toMatchObject({ limit: 99 });
      await expect(store.commitAtomic({ set: { limit: 100 } })).rejects.toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not add validation constraints to stores that did not opt in', async () => {
    const { dir, file, store } = createTempStore();
    try {
      await store.writePatchAtomic({ limit: 123.5 });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ limit: 123.5 });
      expect(store.inspect()).toMatchObject({ status: 'ready', value: { limit: 123.5 } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['null', '[1]', '{bad-json', '{"limit":123456789}'])('rejects malformed or oversized bytes %s without repair', (raw) => {
    const { dir, file, store, log } = createTempStore(undefined, { maxBytes: 16 });
    try {
      fs.writeFileSync(file, raw);
      expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
      expect(fs.readdirSync(dir)).toEqual(['settings.json']);
      expect(log.info).not.toHaveBeenCalled(); expect(log.warn).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('distinguishes a missing file from a permission failure without an unbounded read', () => {
    const { dir, file, store } = createTempStore();
    try {
      expect(store.inspect()).toMatchObject({ status: 'ready', value: DEFAULTS, customizedKeys: [] });
      fs.writeFileSync(file, '{"limit":7}');
      const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('private directory'), { code: 'EACCES' });
      });
      const unbounded = vi.spyOn(fs, 'readFileSync');
      try {
        expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
        expect(unbounded).not.toHaveBeenCalled();
      } finally { open.mockRestore(); unbounded.mockRestore(); }
      expect(fs.readFileSync(file, 'utf8')).toBe('{"limit":7}');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a symbolic-link settings file without changing the link or target', ({ skip }) => {
    const { dir, file, store } = createTempStore();
    const target = path.join(dir, 'target.json');
    try {
      fs.writeFileSync(target, '{"limit":7}');
      try { fs.symlinkSync(target, file, 'file'); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; }
        throw error;
      }
      expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(file)).toBe(target);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"limit":7}');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a directory without trying to read it as settings', () => {
    const { dir, file, store } = createTempStore();
    try {
      fs.mkdirSync(file);
      expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
      expect(fs.statSync(file).isDirectory()).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds allocation and discards a file that grows after its handle stat', () => {
    const { dir, file, store } = createTempStore(undefined, { maxBytes: 32 });
    const original = '{"limit":7}'; const appended = ' '.repeat(1024);
    fs.writeFileSync(file, original);
    const actualFstat = fs.fstatSync;
    let grew = false;
    const fstat = vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
      const stat = Reflect.apply(actualFstat, fs, args);
      if (!grew) { grew = true; fs.appendFileSync(file, appended); }
      return stat;
    });
    const read = vi.spyOn(fs, 'readSync');
    const unbounded = vi.spyOn(fs, 'readFileSync');
    try {
      expect(store.inspect()).toEqual({ status: 'unreadable', revision: null });
      expect(unbounded).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalled();
      for (const call of read.mock.calls) expect((call[1] as NodeJS.ArrayBufferView).byteLength).toBeLessThanOrEqual(32);
      fstat.mockRestore(); read.mockRestore(); unbounded.mockRestore();
      expect(fs.readFileSync(file, 'utf8')).toBe(original + appended);
    } finally {
      fstat.mockRestore(); read.mockRestore(); unbounded.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createOverrideSettingsFile', () => {
  it('uses defaults and reports no customization when the file is missing', () => {
    const { dir, store } = createTempStore();
    try {
      expect(store.readState()).toMatchObject({
        value: DEFAULTS,
        isCustomized: false,
        defaults: DEFAULTS,
        customizedKeys: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges existing file keys as user overrides', () => {
    const { dir, file, store } = createTempStore();
    try {
      fs.writeFileSync(file, JSON.stringify({ enabled: false }), 'utf-8');
      expect(store.readState()).toMatchObject({
        value: { enabled: false, limit: 5 },
        isCustomized: true,
        defaults: DEFAULTS,
        customizedKeys: ['enabled'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can log load metadata without exposing normalized setting values', () => {
    const { dir, file, store, log } = createTempStore(undefined, {
      logLoadedValue: false,
    });
    try {
      fs.writeFileSync(file, JSON.stringify({ limit: 918_273 }), 'utf-8');
      expect(store.read().limit).toBe(918_273);
      expect(log.info).toHaveBeenCalledWith('test settings loaded', {
        path: file,
        isCustomized: true,
      });
      expect(JSON.stringify(log.info.mock.calls)).not.toContain('918273');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can omit malformed setting contents from read failure logs', () => {
    const { dir, file, store, log } = createTempStore(undefined, {
      logReadErrorDetails: false,
    });
    const sensitiveValue = 'private-settings-sentinel';
    try {
      fs.writeFileSync(file, `{"limit":${sensitiveValue}}`, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(log.warn).toHaveBeenCalledWith('test settings read failed; falling back to defaults', {
        path: file,
      });
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(sensitiveValue);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves unreadable settings and rejects mutations until the file is repaired', async () => {
    const { dir, file, store } = createTempStore(undefined, {
      preserveUnreadableFile: true,
    });
    const malformed = '{"limit":private-settings-sentinel}';
    const updater = vi.fn(() => ({ limit: 9 }));
    try {
      fs.writeFileSync(file, malformed, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);

      expect(() => store.writePatch({ enabled: false })).toThrow(/unreadable/);
      await expect(store.writePatchAtomic({ limit: 8 })).rejects.toThrow(/unreadable/);
      await expect(store.updateAtomic(updater)).rejects.toThrow(/unreadable/);
      expect(updater).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, 'utf-8')).toBe(malformed);

      fs.writeFileSync(file, JSON.stringify({ enabled: false }), 'utf-8');
      await expect(store.writePatchAtomic({ limit: 8 })).resolves.toBeUndefined();
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
        enabled: false,
        limit: 8,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['a non-object root', 'null', undefined],
    ['an oversized file', '{"limit":8}', 4],
  ])('treats %s as unreadable when preservation is enabled', (_label, contents, maxBytes) => {
    const { dir, file, store } = createTempStore(undefined, {
      maxBytes,
      preserveUnreadableFile: true,
    });
    try {
      fs.writeFileSync(file, contents, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(() => store.writePatch({ limit: 9 })).toThrow(/unreadable/);
      expect(fs.readFileSync(file, 'utf-8')).toBe(contents);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects writes over maxBytes before touching the target or temp file', () => {
    const { dir, file, store } = createTempStore(undefined, { maxBytes: 32 });
    try {
      const original = JSON.stringify({ enabled: false });
      fs.writeFileSync(file, original, 'utf-8');

      expect(() => store.writePatch({ nested: { a: 123_456_789, b: 987_654_321 } })).toThrow(
        /file exceeds 32 byte limit/,
      );
      expect(fs.readFileSync(file, 'utf-8')).toBe(original);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses the initial stat snapshot when caching a readable file', () => {
    const { dir, file, store } = createTempStore();
    const statSync = vi.spyOn(fs, 'statSync');
    try {
      fs.writeFileSync(file, JSON.stringify({ enabled: false }), 'utf-8');
      store.readState();
      expect(statSync).toHaveBeenCalledTimes(1);
      expect(statSync).toHaveBeenCalledWith(file, { bigint: true });
    } finally {
      statSync.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writePatch persists only touched keys as overrides', () => {
    const { dir, file, store } = createTempStore();
    try {
      store.writePatch({ limit: 8 });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ limit: 8 });
      expect(store.readState()).toMatchObject({
        value: { enabled: true, limit: 8, nested: DEFAULTS.nested },
        isCustomized: true,
        customizedKeys: ['limit'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writePatch clears a key override when the user changes it back to default', () => {
    const { dir, file, store } = createTempStore();
    try {
      store.writePatch({ enabled: false, limit: 8 });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
        enabled: false,
        limit: 8,
      });

      store.writePatch({ enabled: true });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ limit: 8 });
      expect(store.readState()).toMatchObject({
        value: { enabled: true, limit: 8, nested: DEFAULTS.nested },
        isCustomized: true,
        customizedKeys: ['limit'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writePatch removes the override file when every touched key is back to default', () => {
    const { dir, file, store } = createTempStore();
    try {
      store.writePatch({ enabled: false });
      expect(fs.existsSync(file)).toBe(true);

      store.writePatch({ enabled: true });
      expect(fs.existsSync(file)).toBe(false);
      expect(store.readState()).toMatchObject({
        value: DEFAULTS,
        isCustomized: false,
        customizedKeys: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reset removes the override file so future defaults can flow through', () => {
    const { dir, file, store } = createTempStore();
    try {
      store.writePatch({ enabled: false });
      expect(fs.existsSync(file)).toBe(true);

      expect(store.reset()).toEqual(DEFAULTS);
      expect(fs.existsSync(file)).toBe(false);
      expect(store.readState().isCustomized).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidateIfChanged reloads after external file edits and is a no-op otherwise', () => {
    const { dir, file, store } = createTempStore();
    try {
      // 初始:文件不存在,缓存默认态。
      expect(store.read().limit).toBe(5);

      // 外部写入(模拟用户手改文件)→ 失效 → 现读到新值。
      fs.writeFileSync(file, JSON.stringify({ limit: 9 }), 'utf-8');
      store.invalidateIfChanged();
      expect(store.read().limit).toBe(9);

      // 文件没变 → no-op(仍读到同一份,不炸不重置)。
      store.invalidateIfChanged();
      expect(store.read().limit).toBe(9);

      // 外部再改,mtime 强制前移(防同毫秒粒度误判"没变")。
      fs.writeFileSync(file, JSON.stringify({ limit: 3 }), 'utf-8');
      const future = new Date(Date.now() + 5_000);
      fs.utimesSync(file, future, future);
      store.invalidateIfChanged();
      expect(store.read().limit).toBe(3);

      // 外部删除文件 → 失效 → 回到默认态。
      fs.rmSync(file);
      store.invalidateIfChanged();
      expect(store.read().limit).toBe(5);
      expect(store.readState().isCustomized).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Unit: real settings reads/writes. Repeated ordinary reads used to stat on every call.
  // Minimal input: one file, an external replacement, then a local write and same-path owner change.
  it('bounds opted-in file checks without delaying strict reads, local writes or owner changes', () => {
    let owner = 'owner:1';
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { dir, file, store } = createTempStore(undefined, { scopeKey: () => owner });
    const stat = vi.spyOn(fs, 'statSync');
    const replace = (limit: number) => {
      fs.writeFileSync(`${file}.replacement`, JSON.stringify({ limit }));
      fs.renameSync(`${file}.replacement`, file);
    };
    try {
      store.writePatch({ limit: 7 });
      stat.mockClear();
      for (let i = 0; i < 60; i++) { store.invalidateIfChanged(60_000); expect(store.read().limit).toBe(7); }
      expect(stat).not.toHaveBeenCalled();
      replace(9);
      now += 59_999;
      store.invalidateIfChanged(60_000);
      expect(store.read().limit).toBe(7);
      now++;
      store.invalidateIfChanged(60_000);
      expect(store.read().limit).toBe(9);
      replace(11);
      store.invalidateIfChanged(); // Uncached callers explicitly bypass the window.
      expect(store.read().limit).toBe(11);
      store.writePatch({ limit: 13 });
      store.invalidateIfChanged(60_000);
      expect(store.read().limit).toBe(13);
      replace(17);
      owner = 'owner:2';
      store.invalidateIfChanged(60_000);
      expect(store.read().limit).toBe(17);
      now -= 120_000; // A backwards wall-clock jump cannot extend the cache.
      replace(19);
      store.invalidateIfChanged(60_000);
      expect(store.read().limit).toBe(19);
    } finally { stat.mockRestore(); clock.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('writePatch clears object overrides that match defaults with different key order', () => {
    const { dir, file, store } = createTempStore();
    try {
      store.writePatch({ nested: { a: 7, b: 2 } });
      expect(fs.existsSync(file)).toBe(true);

      store.writePatch({ nested: { b: 2, a: 1 } });
      expect(fs.existsSync(file)).toBe(false);
      expect(store.readState()).toMatchObject({
        value: DEFAULTS,
        isCustomized: false,
        customizedKeys: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes atomic patches from separate instances without losing unrelated keys', async () => {
    const first = createTempStore();
    const second = createTempStore({ dir: first.dir, file: first.file });
    try {
      // 两个实例都先缓存同一份旧状态，复现共享 userData 的并发读改写窗口。
      expect(first.store.read()).toEqual(DEFAULTS);
      expect(second.store.read()).toEqual(DEFAULTS);

      await Promise.all([
        first.store.writePatchAtomic({ enabled: false }),
        second.store.writePatchAtomic({ limit: 9 }),
      ]);

      expect(JSON.parse(fs.readFileSync(first.file, 'utf-8'))).toEqual({
        enabled: false,
        limit: 9,
      });
      expect(fs.existsSync(`${first.file}.lock`)).toBe(false);
    } finally {
      fs.rmSync(first.dir, { recursive: true, force: true });
    }
  });
});

/**
 * The process-wide default (setPreserveUnreadableSettingsFilesByDefault): the desktop never sets
 * it; the Host sets it at boot. Stores without their own preserveUnreadableFile follow it.
 */
describe('the process-wide default for unreadable settings files', () => {
  afterEach(() => setPreserveUnreadableSettingsFilesByDefault(false));
  const malformed = '{"limit":private-settings-sentinel}';

  it('unset, as on the desktop: an unreadable file is deleted and the next write replaces it', () => {
    const { dir, file, store } = createTempStore();
    try {
      fs.writeFileSync(file, malformed, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(fs.existsSync(file)).toBe(false);
      store.writePatch({ limit: 9 });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ limit: 9 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unset, as on the desktop: a non-object root reads as no overrides and is kept', () => {
    const { dir, file, store } = createTempStore();
    try {
      fs.writeFileSync(file, 'null', 'utf-8');
      expect(store.readState()).toMatchObject({ value: DEFAULTS, isCustomized: false });
      expect(fs.readFileSync(file, 'utf-8')).toBe('null');
      store.writePatch({ limit: 9 });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ limit: 9 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set: a store without its own option keeps the file, refuses writes, and reset still removes it', async () => {
    setPreserveUnreadableSettingsFilesByDefault(true);
    const { dir, file, store } = createTempStore();
    try {
      fs.writeFileSync(file, malformed, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(fs.readFileSync(file, 'utf-8')).toBe(malformed);
      expect(() => store.writePatch({ limit: 9 })).toThrow(/unreadable/);
      await expect(store.writePatchAtomic({ limit: 8 })).rejects.toThrow(/unreadable/);
      expect(fs.readFileSync(file, 'utf-8')).toBe(malformed);
      expect(store.reset()).toEqual(DEFAULTS);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set: it applies to stores created before it was set', () => {
    const { dir, file, store } = createTempStore();
    setPreserveUnreadableSettingsFilesByDefault(true);
    try {
      fs.writeFileSync(file, malformed, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(fs.readFileSync(file, 'utf-8')).toBe(malformed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a store's own option wins over the process default", () => {
    setPreserveUnreadableSettingsFilesByDefault(true);
    const { dir, file, store } = createTempStore(undefined, { preserveUnreadableFile: false });
    try {
      fs.writeFileSync(file, malformed, 'utf-8');
      expect(store.read()).toEqual(DEFAULTS);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
