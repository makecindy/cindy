import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => root.path } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

const tempDirs: string[] = [];

function makeRoot(): string {
  root.path = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-live-compact-'));
  tempDirs.push(root.path);
  return path.join(root.path, 'live-compact-settings.json');
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('live compact settings', () => {
  it('defaults to off when absent and persists toggles', async () => {
    const file = makeRoot();
    const store = await import('../live-compact-store.js');

    expect(store.readLiveCompactSettings().enabled).toBe(false);

    store.writeLiveCompactEnabled(true);
    expect(store.readLiveCompactSettings().enabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabled: true });

    store.writeLiveCompactEnabled(false);
    expect(store.readLiveCompactSettings().enabled).toBe(false);
  });

  it('falls back to off for a corrupt file without deleting it', async () => {
    const file = makeRoot();
    fs.writeFileSync(file, '{ not json');
    // reset-modules: 模块级 cache 是待测对象 —— 损坏值只在首次读取时归一化,复用上一用例的 cache 会测不到该分支。
    vi.resetModules();
    const store = await import('../live-compact-store.js');

    expect(store.readLiveCompactSettings().enabled).toBe(false);
    // 损坏文件是用户唯一的现场:读失败回落默认,但不静默删除。
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('rewrites a corrupt file instead of locking the toggle forever', async () => {
    const file = makeRoot();
    fs.writeFileSync(file, '{ not json');
    // reset-modules: 读入的缓存决定 readStatus,必须让本用例拿到自己那份损坏文件。
    vi.resetModules();
    const store = await import('../live-compact-store.js');

    // 坏文件拒写是共享 helper 的既定契约;开关必须能自救,否则用户永远关不掉也打不开。
    store.writeLiveCompactEnabled(true);
    expect(store.readLiveCompactSettings().enabled).toBe(true);

    const parked = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.unreadable-'));
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), parked[0]), 'utf8')).toBe('{ not json');
  });

  it('picks up a hand-edited file on the next read', async () => {
    const file = makeRoot();
    const store = await import('../live-compact-store.js');
    expect(store.readLiveCompactSettings().enabled).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ enabled: true }));
    // 显式把 mtime 推后:同一毫秒内的读改写会让 mtime 守卫失效。
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(file, future, future);

    expect(store.readLiveCompactSettings().enabled).toBe(true);
  });

  it('ignores a non-boolean enabled value', async () => {
    const file = makeRoot();
    fs.writeFileSync(file, JSON.stringify({ enabled: 'yes' }));
    // reset-modules: 同上,非布尔值的归一化只在首次读取时发生。
    vi.resetModules();
    const store = await import('../live-compact-store.js');

    expect(store.readLiveCompactSettings().enabled).toBe(false);
  });
});
