/**
 * windowsShortcutSelfHeal 单测:内存假体全覆盖,不起 Electron。
 * 口径:只动 target 是本 exe 的旧名快捷方式;桌面/开始菜单改名、任务栏原地刷;
 * 全程 best-effort,失败不抛。
 * 路径一律用 path.join 构造 —— 与被测模块同源,保证 Linux CI 上分隔符一致。
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => { throw new Error('not used in tests'); } },
  shell: {},
}));
vi.mock('../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { healWindowsShortcuts, type ShortcutSelfHealDeps } from '../windowsShortcutSelfHeal';
import { brandAppId, brandExecutableName } from '@cindy/maker-shared/brand-identity';

// 本文件专测 CN 产物的历史快捷方式修复，显式固定区域，避免继承宿主环境。
const EXPECTED_APP_ID = brandAppId('cn');
// 重建目标 .lnk 基名(与实现的 SHORTCUT_BASENAME 同源;cn = 'Cindy')。
const NEW_SHORTCUT_NAME = brandExecutableName('cn');

const EXE = 'C:\\Program Files\\xdt-maker\\xdt-maker.exe';
const DESKTOP = 'C:\\Users\\u\\Desktop';
const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';
const START_MENU = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const TASKBAR = path.join(APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
const at = (dir: string, name: string) => path.join(dir, `${name}.lnk`);

/** 内存 .lnk 文件系统:path → ShortcutDetails。 */
function makeHarness(initial: Record<string, Electron.ShortcutDetails>) {
  const files = new Map<string, Electron.ShortcutDetails>(Object.entries(initial));
  const writes: Array<{ path: string; op: string; details: Electron.ShortcutDetails }> = [];
  const deps: ShortcutSelfHealDeps = {
    platform: 'win32',
    isPackaged: true,
    execPath: EXE,
    desktopDir: () => DESKTOP,
    appDataDir: () => APPDATA,
    exists: async (p) => files.has(p),
    unlink: async (p) => {
      if (!files.delete(p)) throw new Error(`ENOENT ${p}`);
    },
    readShortcut: (p) => {
      const d = files.get(p);
      if (!d) throw new Error(`ENOENT ${p}`);
      return d;
    },
    writeShortcut: (p, op, details) => {
      writes.push({ path: p, op, details });
      files.set(p, details);
      return true;
    },
  };
  return { files, writes, deps };
}

const lnk = (target: string, extra?: Partial<Electron.ShortcutDetails>): Electron.ShortcutDetails => ({
  target,
  ...extra,
});

describe('healWindowsShortcuts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('桌面旧名 XDMaker.lnk → 以 NEW_SHORTCUT_NAME 重建并删除旧文件,AUMID/icon 强制刷新', async () => {
    const { files, writes, deps } = makeHarness({
      [at(DESKTOP, 'XDMaker')]: lnk(EXE, { args: '', appUserModelId: EXPECTED_APP_ID }),
    });
    await healWindowsShortcuts(deps);

    expect(files.has(at(DESKTOP, 'XDMaker'))).toBe(false);
    const created = files.get(at(DESKTOP, NEW_SHORTCUT_NAME));
    expect(created).toBeDefined();
    expect(created?.target).toBe(EXE);
    expect(created?.icon).toBe(EXE);
    expect(created?.iconIndex).toBe(0);
    expect(created?.appUserModelId).toBe(EXPECTED_APP_ID);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.op).toBe('create');
  });

  it('更早一代 xdt-maker.lnk 同样被换名;开始菜单目录也覆盖', async () => {
    const { files, deps } = makeHarness({
      [at(START_MENU, 'xdt-maker')]: lnk(EXE),
    });
    await healWindowsShortcuts(deps);
    expect(files.has(at(START_MENU, 'xdt-maker'))).toBe(false);
    expect(files.has(at(START_MENU, NEW_SHORTCUT_NAME))).toBe(true);
  });

  it('target 指向其它安装目录的旧名快捷方式不碰(多版本共存)', async () => {
    const other = lnk('D:\\other\\xdt-maker.exe');
    const { files, writes, deps } = makeHarness({
      [at(DESKTOP, 'XDMaker')]: other,
    });
    await healWindowsShortcuts(deps);
    expect(files.get(at(DESKTOP, 'XDMaker'))).toEqual(other);
    expect(writes).toHaveLength(0);
  });

  it('新名 .lnk 已存在时只删旧重复项,不覆盖用户现有快捷方式', async () => {
    const userOwned = lnk(EXE, { args: '--my-flag' });
    const { files, writes, deps } = makeHarness({
      [at(DESKTOP, NEW_SHORTCUT_NAME)]: userOwned,
      [at(DESKTOP, 'XDMaker')]: lnk(EXE),
    });
    await healWindowsShortcuts(deps);
    expect(files.has(at(DESKTOP, 'XDMaker'))).toBe(false);
    expect(files.get(at(DESKTOP, NEW_SHORTCUT_NAME))).toEqual(userOwned);
    expect(writes).toHaveLength(0);
  });

  it('任务栏固定项原地 update:文件名不变,icon/AUMID 刷新;已正确则幂等跳过', async () => {
    const pinned = at(TASKBAR, 'XDMaker');
    const { files, writes, deps } = makeHarness({
      [pinned]: lnk(EXE, { icon: 'C:\\old\\old.ico', iconIndex: 3 }),
    });
    await healWindowsShortcuts(deps);
    expect(files.has(pinned)).toBe(true); // 不改名
    expect(files.get(pinned)?.icon).toBe(EXE);
    expect(files.get(pinned)?.appUserModelId).toBe(EXPECTED_APP_ID);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.op).toBe('update');

    // 第二次运行:属性已正确,不再写盘。
    await healWindowsShortcuts(deps);
    expect(writes).toHaveLength(1);
  });

  it('大小写不同的 target 路径视为同一 exe(Windows 大小写不敏感)', async () => {
    const { files, deps } = makeHarness({
      [at(DESKTOP, 'XDMaker')]: lnk(EXE.toUpperCase()),
    });
    await healWindowsShortcuts(deps);
    expect(files.has(at(DESKTOP, NEW_SHORTCUT_NAME))).toBe(true);
  });

  it('非 win32 / 非 packaged 直接 no-op', async () => {
    const a = makeHarness({ [at(DESKTOP, 'XDMaker')]: lnk(EXE) });
    await healWindowsShortcuts({ ...a.deps, platform: 'darwin' });
    expect(a.files.has(at(DESKTOP, 'XDMaker'))).toBe(true);

    const b = makeHarness({ [at(DESKTOP, 'XDMaker')]: lnk(EXE) });
    await healWindowsShortcuts({ ...b.deps, isPackaged: false });
    expect(b.files.has(at(DESKTOP, 'XDMaker'))).toBe(true);
  });

  it('写新名失败时保留旧快捷方式(下次启动重试),且不抛出', async () => {
    const { files, deps } = makeHarness({
      [at(DESKTOP, 'XDMaker')]: lnk(EXE),
    });
    deps.writeShortcut = () => false;
    await expect(healWindowsShortcuts(deps)).resolves.toBeUndefined();
    expect(files.has(at(DESKTOP, 'XDMaker'))).toBe(true);
    expect(files.has(at(DESKTOP, NEW_SHORTCUT_NAME))).toBe(false);
  });

  it('读取快捷方式抛错时跳过该文件且整体不抛', async () => {
    const { deps, files } = makeHarness({
      [at(DESKTOP, 'XDMaker')]: lnk(EXE),
    });
    deps.readShortcut = () => {
      throw new Error('corrupted lnk');
    };
    await expect(healWindowsShortcuts(deps)).resolves.toBeUndefined();
    expect(files.has(at(DESKTOP, 'XDMaker'))).toBe(true);
  });
});
