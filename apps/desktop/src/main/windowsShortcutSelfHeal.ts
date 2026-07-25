/**
 * windowsShortcutSelfHeal — Windows 快捷方式品牌改名启动自愈
 * ---------------------------------------------------------------------------
 * 背景:品牌显示名 XDMaker → Cindy 后,NSIS 的 shortcutName 只在「完整安装器」
 * 运行时生效;差量更新(cindy-updater 补丁)不重跑安装器,存量用户桌面 / 开始菜单
 * 上的旧名快捷方式(XDMaker.lnk / 更早的 xdt-maker.lnk)会永远留着旧名。
 * 本模块在 app 启动时做一次自愈,把指向本程序的旧名快捷方式换成新名。
 *
 * 设计目标(对齐 folderContextMenu.ts 的自注册三原则):
 *   1. 存量用户不用重装就能看到新名字;
 *   2. 绝对不影响启动 —— 任何 IO 失败 swallow + warn log,调用方 fire-and-forget;
 *   3. 幂等 —— 旧名 .lnk 清完后每次启动都是 no-op,不反复写盘惊动 shell 缓存。
 *
 * 行为分两类位置:
 *   - 桌面 / 开始菜单:旧名 .lnk 且 target 是本 exe → 以新名重建(继承原参数,
 *     icon 指回当前 exe 索引 0,AUMID 写 CURRENT_APP_ID)后删除旧文件。
 *     新名 .lnk 已存在时只删旧文件(重复项),不覆盖用户现有的新名快捷方式。
 *   - 任务栏固定(User Pinned\TaskBar):**只原地刷新属性,绝不改文件名**——
 *     重命名固定项会让图钉失效;文件名(悬停提示)保持旧名,等用户重新固定。
 *
 * ⚠️ AUMID 三位一体(NSIS appId = 运行时 setAppUserModelId = 快捷方式 AUMID,
 * 见 bootstrap-electron.ts AUMID 块):这里写入的 appUserModelId 必须与
 * CURRENT_APP_ID 逐字符一致,否则 Windows toast 通知被静默丢弃。
 *
 * 只校验 target 是本 exe 才动手:多版本共存 / 指向其它安装目录的快捷方式不碰。
 * dev 模式跳过(process.execPath 是 electron.exe,桌面上也不会有本产品快捷方式)。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_APP_ID, CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { createLogger } from './logger';

const log = createLogger('shortcutSelfHeal');

/** 历代快捷方式名(不含扩展名),按出现顺序:最早的 exe 名 → 上一代品牌名。 */
const LEGACY_SHORTCUT_BASENAMES = ['xdt-maker', 'XDMaker'] as const;

/**
 * 重建目标快捷方式名 = 本区域 NSIS shortcutName(cn/global 'Cindy' /
 * dev 'CindyDev',与 forge.config 同源;2026-07-26 起 cn/global 同名,
 * 双装 .lnk 互抢已被 owner 接受)。仍从 brandExecutableName 派生而不用共享的
 * BRAND_NAME:dev 包必须写自己的 CindyDev.lnk,不能抢正式包的 Cindy.lnk。
 */
const SHORTCUT_BASENAME = brandExecutableName(CURRENT_CINDY_REGION);

/** 依赖注入面(规则 14:测试用内存假体直接调用,不起 Electron)。 */
export interface ShortcutSelfHealDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** 当前程序 exe 绝对路径(target 校验 + 新 icon 指向)。 */
  execPath: string;
  /** 桌面目录;取不到(极少数受限环境)返回 null 则跳过该位置。 */
  desktopDir: () => string | null;
  /** Roaming AppData(开始菜单 / 任务栏固定目录的根)。 */
  appDataDir: () => string | null;
  exists: (p: string) => Promise<boolean>;
  unlink: (p: string) => Promise<void>;
  readShortcut: (p: string) => Electron.ShortcutDetails;
  writeShortcut: (p: string, op: 'create' | 'update', details: Electron.ShortcutDetails) => boolean;
  logger?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;
}

function defaultDeps(): ShortcutSelfHealDeps {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    desktopDir: () => {
      try {
        return app.getPath('desktop');
      } catch {
        return null;
      }
    },
    appDataDir: () => {
      try {
        return app.getPath('appData');
      } catch {
        return null;
      }
    },
    exists: async (p) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
    unlink: (p) => fs.unlink(p),
    readShortcut: (p) => shell.readShortcutLink(p),
    writeShortcut: (p, op, details) => shell.writeShortcutLink(p, op, details),
    logger: log,
  };
}

/** Windows 路径比较:大小写不敏感 + 归一分隔符。 */
function isSameWindowsPath(a: string, b: string): boolean {
  const norm = (p: string) => path.normalize(p).toLowerCase();
  return norm(a) === norm(b);
}

/** 旧名 .lnk 是否指向本程序(读失败 / 指向别处都返回 false,不动它)。 */
function targetsThisExe(deps: ShortcutSelfHealDeps, lnkPath: string): boolean {
  try {
    const details = deps.readShortcut(lnkPath);
    return typeof details.target === 'string' && isSameWindowsPath(details.target, deps.execPath);
  } catch {
    return false;
  }
}

/** 桌面 / 开始菜单:旧名 → 新名重建。返回是否发生了改动(日志用)。 */
async function healRenameable(deps: ShortcutSelfHealDeps, dir: string): Promise<boolean> {
  let changed = false;
  const newPath = path.join(dir, `${SHORTCUT_BASENAME}.lnk`);
  for (const base of LEGACY_SHORTCUT_BASENAMES) {
    const oldPath = path.join(dir, `${base}.lnk`);
    if (!(await deps.exists(oldPath))) continue;
    if (!targetsThisExe(deps, oldPath)) continue;
    if (!(await deps.exists(newPath))) {
      // 继承旧快捷方式的启动参数 / 工作目录,icon 与 AUMID 强制刷成当前值。
      const prev = deps.readShortcut(oldPath);
      const ok = deps.writeShortcut(newPath, 'create', {
        ...prev,
        target: deps.execPath,
        icon: deps.execPath,
        iconIndex: 0,
        appUserModelId: CURRENT_APP_ID,
      });
      // 新名写失败就保留旧快捷方式(用户至少还有入口),下次启动重试。
      if (!ok) continue;
    }
    await deps.unlink(oldPath);
    changed = true;
  }
  return changed;
}

/** 任务栏固定:原地刷属性(icon / AUMID),文件名不动。 */
async function healPinnedInPlace(deps: ShortcutSelfHealDeps, dir: string): Promise<boolean> {
  let changed = false;
  for (const base of LEGACY_SHORTCUT_BASENAMES) {
    const lnkPath = path.join(dir, `${base}.lnk`);
    if (!(await deps.exists(lnkPath))) continue;
    if (!targetsThisExe(deps, lnkPath)) continue;
    let prev: Electron.ShortcutDetails;
    try {
      prev = deps.readShortcut(lnkPath);
    } catch {
      continue;
    }
    // 幂等:icon 已指向当前 exe 且 AUMID 正确就不再写盘。
    const iconOk = typeof prev.icon === 'string' && isSameWindowsPath(prev.icon, deps.execPath);
    if (iconOk && prev.appUserModelId === CURRENT_APP_ID) continue;
    const ok = deps.writeShortcut(lnkPath, 'update', {
      ...prev,
      icon: deps.execPath,
      iconIndex: 0,
      appUserModelId: CURRENT_APP_ID,
    });
    if (ok) changed = true;
  }
  return changed;
}

/**
 * 启动自愈入口。win32 + packaged 才生效;所有异常吞掉只 warn,
 * bootstrap 用 `void healWindowsShortcuts()` fire-and-forget。
 */
export async function healWindowsShortcuts(
  overrides?: Partial<ShortcutSelfHealDeps>,
): Promise<void> {
  const deps: ShortcutSelfHealDeps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== 'win32' || !deps.isPackaged) return;
  try {
    const appData = deps.appDataDir();
    const dirs: Array<{ dir: string; pinned: boolean }> = [];
    const desktop = deps.desktopDir();
    if (desktop) dirs.push({ dir: desktop, pinned: false });
    if (appData) {
      dirs.push({
        dir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        pinned: false,
      });
      dirs.push({
        dir: path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
        pinned: true,
      });
    }
    let changed = false;
    for (const { dir, pinned } of dirs) {
      const did = pinned ? await healPinnedInPlace(deps, dir) : await healRenameable(deps, dir);
      changed = changed || did;
    }
    if (changed) deps.logger?.info('brand shortcut self-heal applied');
  } catch (err) {
    deps.logger?.warn('brand shortcut self-heal failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
