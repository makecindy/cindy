/**
 * user-prefs-store.test.ts —— overlay 用户开关(kill switch)的 per-owner 持久化
 * 单测。存储真身经 createOverrideSettingsFile 落 userData,依赖 electron 与
 * appSessionState 的 owner 数据目录解析;这里 mock 二者,用临时目录验证:
 *  - 默认开启;
 *  - owner 切换隔离(两个 owner 域互不影响);
 *  - 持久化重读(重置模块后从磁盘重载)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  ownerKey: 'owner-a',
}));

// electron 只为满足 createOverrideSettingsFile → crossProcessLock → logger 的
// 传递依赖;owner 数据目录由下面 appSessionState mock 直接接管。
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
}));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) =>
    [mocks.root, 'owners', mocks.ownerKey, ...parts].join('/'),
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

function ownerFilePath(): string {
  return path.join(mocks.root, 'owners', mocks.ownerKey, 'ghost-overlay-user-prefs.json');
}

beforeEach(() => {
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-overlay-user-prefs-'));
  mocks.ownerKey = 'owner-a';
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe('readOverlayUserEnabled / setOverlayUserEnabled', () => {
  it('defaults to enabled', async () => {
    const store = await import('../user-prefs-store.js');
    expect(store.readOverlayUserEnabled('ghost-a')).toBe(true);
    expect(fs.existsSync(ownerFilePath())).toBe(false);
  });

  it('persists per owner directory (owner switch isolation)', async () => {
    const store = await import('../user-prefs-store.js');

    store.setOverlayUserEnabled('ghost-a', false);
    expect(store.readOverlayUserEnabled('ghost-a')).toBe(false);

    // 切到 owner-b:另一个 owner 域,ghost-a 仍是默认开启。
    mocks.ownerKey = 'owner-b';
    expect(store.readOverlayUserEnabled('ghost-a')).toBe(true);

    // owner-b 关闭 ghost-b,不影响 owner-a 的 ghost-a 关闭态。
    store.setOverlayUserEnabled('ghost-b', false);
    mocks.ownerKey = 'owner-a';
    expect(store.readOverlayUserEnabled('ghost-a')).toBe(false);
    expect(store.readOverlayUserEnabled('ghost-b')).toBe(true);
  });

  it('persists across store reload', async () => {
    const store = await import('../user-prefs-store.js');
    store.setOverlayUserEnabled('ghost-a', false);
    expect(fs.existsSync(ownerFilePath())).toBe(true);

    vi.resetModules();
    const reloaded = await import('../user-prefs-store.js');
    expect(reloaded.readOverlayUserEnabled('ghost-a')).toBe(false);
  });

  it('re-enabling clears the persisted disable and keeps default-on', async () => {
    const store = await import('../user-prefs-store.js');
    store.setOverlayUserEnabled('ghost-a', false);
    store.setOverlayUserEnabled('ghost-a', true);

    expect(store.readOverlayUserEnabled('ghost-a')).toBe(true);
    // 重新开启清除关闭条目后,文件不再保留该 ghostId。
    expect(fs.existsSync(ownerFilePath())).toBe(false);

    vi.resetModules();
    const reloaded = await import('../user-prefs-store.js');
    expect(reloaded.readOverlayUserEnabled('ghost-a')).toBe(true);
  });
});

describe('normalize(坏形态清洗)', () => {
  it('只保留显式关闭的 false 条目,其它形态丢弃', async () => {
    const { __testing } = await import('../user-prefs-store.js');
    expect(
      __testing.normalize({
        disabled: { a: false, b: true, c: 'false', d: 0, e: null },
      }),
    ).toEqual({ disabled: { a: false } });
  });

  it('整体不是对象 / 缺 disabled → 空表(默认开启)', async () => {
    const { __testing } = await import('../user-prefs-store.js');
    expect(__testing.normalize(null)).toEqual({ disabled: {} });
    expect(__testing.normalize({ disabled: 42 })).toEqual({ disabled: {} });
    expect(__testing.normalize({ disabled: 'nope' })).toEqual({ disabled: {} });
  });
});
