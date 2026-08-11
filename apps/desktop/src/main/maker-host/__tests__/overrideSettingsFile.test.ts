import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOverrideSettingsFile } from '../override-settings-file.js';

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
  });

  return { dir, file, store, log };
}

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
      expect(statSync).toHaveBeenCalledWith(file);
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
