/**
 * deviceLinkSettingsStore.test.ts —— 被控开关持久化的读/写健壮性。
 * 覆盖:文件缺失 → 默认;合法 JSON → normalize;**损坏 JSON → unlink + 回落默认(不崩)**;
 * 写入走写锁 + tmp+rename 原子写;mtime 缓存(文件未变化时第二次读不再碰盘)。
 * fs 用内存虚拟实现 mock(写路径依赖 statSync / openSync 锁文件语义,布尔桩不够用);
 * 模块级 cached 用 vi.resetModules + 动态 import 逐用例隔离。
 */
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  let clock = 1;
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    files,
    /** 直接放置文件内容(模拟磁盘既有文件),mtime 单调前进 */
    seed(path: string, content: string): void {
      files.set(path, { content, mtimeMs: ++clock });
    },
    reset(): void {
      files.clear();
      clock = 1;
    },
    statSync: vi.fn((p: string) => {
      const f = files.get(p);
      if (!f) throw enoent();
      return { mtimeMs: f.mtimeMs };
    }),
    readFileSync: vi.fn((p: string) => {
      const f = files.get(p);
      if (!f) throw enoent();
      return f.content;
    }),
    writeFileSync: vi.fn((p: string, data: unknown) => {
      files.set(p, { content: String(data), mtimeMs: ++clock });
    }),
    renameSync: vi.fn((a: string, b: string) => {
      const f = files.get(a);
      if (!f) throw enoent();
      files.delete(a);
      files.set(b, { content: f.content, mtimeMs: ++clock });
    }),
    unlinkSync: vi.fn((p: string) => {
      files.delete(p);
    }),
    openSync: vi.fn((p: string, flags: string) => {
      if (String(flags).includes('x') && files.has(p)) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      files.set(p, { content: '', mtimeMs: ++clock });
      return 3;
    }),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn((p: string) => files.has(p)),
  };
});

// store 用 path.join 拼路径,win32 下是反斜杠;测试的 seed / 断言 key 必须与之一致。
const SETTINGS_PATH = path.join('/tmp/userdata', 'device-link-settings.json');

const DEFAULT_SETTINGS = {
  remoteControlEnabled: false,
  keepAwake: false,
  revokedControllers: [],
  disabledControlDeviceIds: [],
  lastKnownDeviceNames: {},
};

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userdata' } }));
vi.mock('node:fs', () => ({
  default: {
    existsSync: h.existsSync,
    readFileSync: h.readFileSync,
    unlinkSync: h.unlinkSync,
    writeFileSync: h.writeFileSync,
    renameSync: h.renameSync,
    statSync: h.statSync,
    openSync: h.openSync,
    writeSync: h.writeSync,
    closeSync: h.closeSync,
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

async function load() {
  vi.resetModules(); // 清模块级 cached / writeChain
  return import('../device-link/settings-store.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe('readDeviceLinkSettings', () => {
  it('文件缺失 → 默认(remoteControlEnabled=false),不 unlink', async () => {
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.unlinkSync).not.toHaveBeenCalled();
  });

  it('合法 JSON → normalize(remoteControlEnabled 严格 === true)', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ remoteControlEnabled: true, junk: 1 }));
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      remoteControlEnabled: true,
    });
  });

  it('损坏 JSON → 捕获 + unlink + 回落默认(不抛)', async () => {
    h.seed(SETTINGS_PATH, '{not json');
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual(DEFAULT_SETTINGS);
    expect(h.unlinkSync).toHaveBeenCalledTimes(1); // 坏文件被清掉
  });

  it('normalize:revokedControllers 过滤非字符串项,缺失 → []', async () => {
    h.seed(
      SETTINGS_PATH,
      JSON.stringify({ remoteControlEnabled: true, revokedControllers: ['dev-1', 42, 'dev-2', null] }),
    );
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual({
      remoteControlEnabled: true,
      keepAwake: false,
      revokedControllers: ['dev-1', 'dev-2'],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
  });

  it('normalize:disabledControlDeviceIds 过滤空值 / 非字符串 / 重复项', async () => {
    h.seed(
      SETTINGS_PATH,
      JSON.stringify({ disabledControlDeviceIds: [' dev-1 ', 'dev-1', 42, '', 'dev-2'] }),
    );
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      disabledControlDeviceIds: ['dev-1', 'dev-2'],
    });
  });

  it('normalize:lastKnownDeviceNames 过滤非法项并 trim', async () => {
    h.seed(
      SETTINGS_PATH,
      JSON.stringify({
        lastKnownDeviceNames: {
          'dev-1': ' MacBook ',
          'dev-2': '',
          'dev-3': 42,
          '': 'No Id',
          'dev-4': 'unknown',
          'dev-5': 'no',
        },
      }),
    );
    const { readDeviceLinkSettings } = await load();
    expect(readDeviceLinkSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      lastKnownDeviceNames: { 'dev-1': 'MacBook' },
    });
  });

  it('mtime 缓存:文件未变化时第二次读不再碰盘', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ remoteControlEnabled: true }));
    const { readDeviceLinkSettings } = await load();
    readDeviceLinkSettings();
    readDeviceLinkSettings();
    expect(h.readFileSync).toHaveBeenCalledTimes(1); // 第二次走缓存(stat 每次仍会查)
  });
});

describe('writeDeviceLinkSetting', () => {
  it('写锁 + tmp+rename 原子写;写后回读盘上新值,锁文件已清理', async () => {
    const { readDeviceLinkSettings, writeDeviceLinkSetting } = await load();

    await writeDeviceLinkSetting('remoteControlEnabled', true);
    // 先写 tmp 再 rename(原子);renameSync 的目标即正式文件。
    expect(h.writeFileSync).toHaveBeenCalledTimes(1);
    const [tmpPath] = h.writeFileSync.mock.calls[0] as unknown as [string, string];
    expect(tmpPath.endsWith('.tmp')).toBe(true);
    expect(h.renameSync).toHaveBeenCalledTimes(1);
    // 写锁走 O_EXCL 建 + 释放删
    expect(h.openSync).toHaveBeenCalledTimes(1);
    expect(h.files.has(`${SETTINGS_PATH}.lock`)).toBe(false);

    // 写后缓存失效(多实例语义:不能把本进程内容缓存在别人的 mtime 之下),回读盘上新值
    expect(readDeviceLinkSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      remoteControlEnabled: true,
    });
  });

  it('writeLastKnownDeviceNames 持久化本地设备名缓存', async () => {
    const { readDeviceLinkSettings, writeLastKnownDeviceNames } = await load();

    await writeLastKnownDeviceNames({ 'dev-1': 'MacBook' });

    expect(h.writeFileSync).toHaveBeenCalledTimes(1);
    const [, json] = h.writeFileSync.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(json)).toEqual({
      ...DEFAULT_SETTINGS,
      lastKnownDeviceNames: { 'dev-1': 'MacBook' },
    });
    expect(readDeviceLinkSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      lastKnownDeviceNames: { 'dev-1': 'MacBook' },
    });
  });

  it('rememberLastKnownDeviceName 忽略占位名/空名,有效名才写缓存', async () => {
    const { readDeviceLinkSettings, rememberLastKnownDeviceName } = await load();

    await expect(rememberLastKnownDeviceName('dev-1', 'unknown')).resolves.toBe(false);
    await expect(rememberLastKnownDeviceName('dev-1', 'no')).resolves.toBe(false);
    await expect(rememberLastKnownDeviceName('dev-1', '   ')).resolves.toBe(false);
    expect(h.writeFileSync).not.toHaveBeenCalled();

    await expect(rememberLastKnownDeviceName('dev-1', ' MacBook ')).resolves.toBe(true);
    expect(readDeviceLinkSettings().lastKnownDeviceNames).toEqual({ 'dev-1': 'MacBook' });
  });

  it('rememberLastKnownDeviceName 名字未变化时不重复写盘', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ lastKnownDeviceNames: { 'dev-1': 'MacBook' } }));
    const { rememberLastKnownDeviceName } = await load();

    await expect(rememberLastKnownDeviceName('dev-1', 'MacBook')).resolves.toBe(false);
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });

  it('forgetLastKnownDeviceName 删除已清空的数据库展示名缓存', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ lastKnownDeviceNames: { 'dev-1': 'MacBook' } }));
    const { forgetLastKnownDeviceName, readDeviceLinkSettings } = await load();

    await expect(forgetLastKnownDeviceName('dev-1')).resolves.toBe(true);
    expect(readDeviceLinkSettings().lastKnownDeviceNames).toEqual({});
  });

  it('空名删除排在尚未完成的旧名称写入之后，最终不残留旧缓存', async () => {
    const {
      forgetLastKnownDeviceName,
      readDeviceLinkSettings,
      rememberLastKnownDeviceName,
    } = await load();

    const remember = rememberLastKnownDeviceName('dev-1', '旧名称');
    const forget = forgetLastKnownDeviceName('dev-1');
    await expect(Promise.all([remember, forget])).resolves.toEqual([true, true]);
    expect(readDeviceLinkSettings().lastKnownDeviceNames).toEqual({});
  });

  it('空名删除尚未完成时，同名有效名称恢复会排在删除后重新写回', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ lastKnownDeviceNames: { 'dev-1': 'MacBook' } }));
    const {
      forgetLastKnownDeviceName,
      readDeviceLinkSettings,
      rememberLastKnownDeviceName,
    } = await load();

    const forget = forgetLastKnownDeviceName('dev-1');
    const remember = rememberLastKnownDeviceName('dev-1', 'MacBook');
    await expect(Promise.all([forget, remember])).resolves.toEqual([true, true]);
    expect(readDeviceLinkSettings().lastKnownDeviceNames).toEqual({ 'dev-1': 'MacBook' });
  });

  it('remember/forget 待落盘时，同步读取先合并最新内存意图供重连 seed 使用', async () => {
    h.seed(SETTINGS_PATH, JSON.stringify({ lastKnownDeviceNames: { 'dev-1': '旧名称' } }));
    const {
      forgetLastKnownDeviceName,
      readLastKnownDeviceNames,
      rememberLastKnownDeviceName,
    } = await load();

    const remember = rememberLastKnownDeviceName('dev-1', '新名称');
    expect(readLastKnownDeviceNames()).toEqual({ 'dev-1': '新名称' });
    await expect(remember).resolves.toBe(true);

    const forget = forgetLastKnownDeviceName('dev-1');
    expect(readLastKnownDeviceNames()).toEqual({});
    await expect(forget).resolves.toBe(true);
  });

  it('rememberLastKnownDeviceName 写缓存失败时不影响调用方', async () => {
    h.writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { readDeviceLinkSettings, rememberLastKnownDeviceName } = await load();

    await expect(rememberLastKnownDeviceName('dev-1', 'MacBook')).resolves.toBe(false);
    expect(readDeviceLinkSettings().lastKnownDeviceNames).toEqual({});
    // 写失败后锁必须被释放,后续写不受影响
    expect(h.files.has(`${SETTINGS_PATH}.lock`)).toBe(false);
    await expect(rememberLastKnownDeviceName('dev-1', 'MacBook')).resolves.toBe(true);
  });

  it('setDeviceControlEnabled 维护本机关闭控制的目标设备列表', async () => {
    const { readDeviceLinkSettings, setDeviceControlEnabled } = await load();

    await expect(setDeviceControlEnabled(' dev-1 ', false)).resolves.toEqual(['dev-1']);
    expect(readDeviceLinkSettings().disabledControlDeviceIds).toEqual(['dev-1']);

    await expect(setDeviceControlEnabled('dev-1', false)).resolves.toEqual(['dev-1']);
    await expect(setDeviceControlEnabled('dev-1', true)).resolves.toEqual([]);
    expect(readDeviceLinkSettings().disabledControlDeviceIds).toEqual([]);
  });
});
