/**
 * folderContextMenu — Windows 文件夹右键菜单 "通过 Cindy 打开" 自注册
 * ---------------------------------------------------------------------------
 * 设计目标:
 *   1. **存量用户也能用上**:不仅在 installer 跑时写一次注册表,app 启动时也尝试
 *      自注册(覆盖升级路径漂移、注册表被清理、第三方装机工具屏蔽 installer 等场景)。
 *   2. **绝对不影响启动**:任何 reg.exe 失败 / 超时 / 权限拒绝 → swallow + warn log,
 *      bootstrap 调用方用 `void registerFolderContextMenu()` fire-and-forget。
 *   3. **幂等**:启动时先 query 当前值,与期望值一致就 skip,避免反复 reg add 触发
 *      Windows shell 缓存失效。
 *
 * 注册表项:
 *   HKCU\Software\Classes\Directory\shell\cindy
 *     (Default) = "通过 Cindy 打开"          ; 菜单 label(BRAND_NAME 派生)
 *     Icon      = "<exe>,0"                  ; 从 exe 资源取
 *     \command
 *       (Default) = "\"<exe>\" --open-folder \"%V\""
 *
 *   HKCU\Software\Classes\Directory\Background\shell\cindy
 *     同上 (覆盖 "在此处右键空白区域" 场景, %V 取当前文件夹路径)
 *
 * 为什么用 HKCU 而不是 HKLM:
 *   - HKCU 不需要管理员权限,app 第一次启动 (普通用户态) 就能写
 *   - 多用户机器上每个用户首次启动 app 都会自注册到自己的 HKCU,语义正确
 *   - installer.nsh 也写 HKCU,与本路径一致
 *
 * 为什么 %V 而不是 %1:
 *   - Directory\shell 上 %V 和 %1 都是被右键的目录路径
 *   - Directory\Background\shell 上 %1 不可用 (没有被选目录),只能用 %V
 *   - 两个键统一用 %V,模板单源
 *
 * Win 11 限制:
 *   纯注册表方案的菜单在 Win 11 默认菜单里被折叠到 "显示更多选项 / Shift+右键",
 *   要原生显示需要写 IExplorerCommand COM (Sparse Package),复杂度高一个数量级,
 *   本期不做。Cursor / VS Code / Sublime Text 目前都是此行为,用户已习惯。
 *
 * dev 模式:
 *   process.execPath 指向 Electron 解释器而不是 Cindy.exe,即使写进去也无法
 *   正常启动 app。dev 模式直接跳过,只在 packaged 模式生效。
 */

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('folderContextMenu');

/**
 * 菜单显示文案。注册表存的是 UNICODE 字符串,Node spawn 在 Windows 上会把 utf8
 * argv 转 utf16 传给 reg.exe,无需额外编码处理。
 *
 * 文案故意全中文 / 不做 i18n:Windows 注册表 MUIVerb 多语言切换需要 .mui 资源
 * 文件,成本高。绝大多数用户是中文环境,英文用户能看懂品牌名即可。
 * 名字用区域 exe 基名(cn/global 'Cindy' / dev 'CindyDev'):dev 包菜单项
 * 文案与正式包可区分;与 installer.nsh customInstall 写入的文案保持一致,
 * 否则启动自愈会误判"值漂移"反复重写。
 */
const MENU_LABEL = `通过 ${brandExecutableName(CURRENT_CINDY_REGION)} 打开`;

/**
 * shell 子键名(2026-07-17 品牌翻转:xdt-maker → cindy;按区域 exe 基名
 * 派生,cn/global 'Cindy'——2026-07-26 显示名统一后两区同键,双装互写已被
 * owner 接受 / dev 'CindyDev' 仍独立)。必须与老 XDMaker 安装的
 * `...\shell\xdt-maker` 键**并存而不复用**。Windows 注册表键名大小写不敏感,
 * 'Cindy' 与历史写入的 'cindy' 是同一个键,存量用户行为零变化;与
 * installer.nsh 的 ${PRODUCT_FILENAME} 键名同源。
 */
const SHELL_KEY_NAME = brandExecutableName(CURRENT_CINDY_REGION);

const KEY_DIRECTORY = `HKCU\\Software\\Classes\\Directory\\shell\\${SHELL_KEY_NAME}`;
const KEY_DIRECTORY_BG = `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${SHELL_KEY_NAME}`;
const FILE_CONTEXT_EXTENSIONS = ['.cshare', '.xdtshare'] as const;

const REG_TIMEOUT_MS = 5000;

/**
 * 解析 `reg query <key> /ve` 输出里 (Default) 的 REG_SZ 值。
 * 输出形如:
 *   HKEY_CURRENT_USER\...
 *
 *       (Default)    REG_SZ    <value>
 *
 * 拿不到 / 键不存在 → null。
 */
function parseRegDefault(stdout: string): string | null {
  const match = /\(Default\)\s+REG_SZ\s+(.+?)(?:\r?\n|$)/.exec(stdout);
  if (!match) return null;
  return match[1]?.trim() ?? null;
}

async function regQueryDefault(keyPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', keyPath, '/ve'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: REG_TIMEOUT_MS,
    });
    return parseRegDefault(stdout);
  } catch {
    // 键不存在 / reg.exe 非 0 退出 → 当作未注册
    return null;
  }
}

async function regSetDefault(keyPath: string, value: string): Promise<void> {
  await execFileAsync('reg', ['add', keyPath, '/ve', '/d', value, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: REG_TIMEOUT_MS,
  });
}

async function regSetNamedValue(keyPath: string, name: string, value: string): Promise<void> {
  await execFileAsync('reg', ['add', keyPath, '/v', name, '/d', value, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: REG_TIMEOUT_MS,
  });
}

async function regDeleteKey(keyPath: string): Promise<void> {
  await execFileAsync('reg', ['delete', keyPath, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: REG_TIMEOUT_MS,
  });
}

/**
 * 确保一组键 (menu + command) 写入注册表为期望值。先 query 后判断:
 *   - command 值已等于期望 → skip (热路径)
 *   - 否则全部覆写
 *
 * 任何失败抛出,由顶层 registerFolderContextMenu try/catch 统一 swallow。
 */
async function ensureMenuEntry(
  keyPath: string,
  label: string,
  iconValue: string,
  command: string,
): Promise<boolean> {
  const cmdKey = `${keyPath}\\command`;
  const existingCmd = await regQueryDefault(cmdKey);
  if (existingCmd === command) {
    // command 一致时再校验一下 label,防止用户手改了 label
    const existingLabel = await regQueryDefault(keyPath);
    if (existingLabel === label) {
      return false; // 全部一致,幂等 skip
    }
  }
  await regSetDefault(keyPath, label);
  await regSetNamedValue(keyPath, 'Icon', iconValue);
  await regSetDefault(cmdKey, command);
  return true;
}

/**
 * 启动时自注册右键菜单。失败完全静默 (warn log),不抛出 / 不阻塞调用方。
 * 设计上调用方应该 `void registerFolderContextMenu()` fire-and-forget。
 *
 * 已经写过且值正确 → reg query 阶段就返回 skip,典型 < 200ms (两次 query)。
 * 首次写或值漂移 → 4~6 次 reg add,典型 < 600ms。
 */
export async function registerFolderContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return;
  // dev 模式 process.execPath 是 Electron 解释器,写进注册表也无法正常启动 app。
  // 端到端验证必须 packaged build,见模块头注释。
  if (!app.isPackaged) return;

  const exePath = process.execPath;
  const iconValue = `${exePath},0`;
  // 命令模板:argv 透传原始路径,绕开 URL 编解码。
  // %V 在 Directory\shell / Directory\Background\shell 两种上下文里都解析成
  // "用户右键所在的目录" 路径。
  const command = `"${exePath}" --open-folder "%V"`;

  try {
    const wroteDir = await ensureMenuEntry(KEY_DIRECTORY, MENU_LABEL, iconValue, command);
    const wroteBg = await ensureMenuEntry(KEY_DIRECTORY_BG, MENU_LABEL, iconValue, command);
    const fileUpdates: string[] = [];
    for (const ext of FILE_CONTEXT_EXTENSIONS) {
      const fileKey = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\${SHELL_KEY_NAME}`;
      const fileCommand = `"${exePath}" --open-share-file "%1"`;
      if (await ensureMenuEntry(fileKey, MENU_LABEL, iconValue, fileCommand)) {
        fileUpdates.push(ext);
      }
    }
    if (wroteDir || wroteBg || fileUpdates.length > 0) {
      log.info('folder context menu registered', {
        exePath,
        directoryUpdated: wroteDir,
        backgroundUpdated: wroteBg,
        fileExtensionsUpdated: fileUpdates,
      });
    } else {
      log.debug('folder context menu already up-to-date, skipping');
    }
  } catch (err) {
    // 任何 reg.exe 失败 (权限被组策略禁、reg.exe 不在 PATH、超时...) 都不算
    // 错误状态——右键菜单是 nice-to-have,缺了不影响 deep link / 命令行入口。
    log.warn('failed to register folder context menu (non-fatal)', err);
  }
}

/**
 * 显式删除注册表项。app 自身不调用 (升级 / 卸载场景由 installer.nsh 负责),
 * 仅作为命令行 / 测试入口保留。
 */
export async function unregisterFolderContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return;
  const fileKeys = FILE_CONTEXT_EXTENSIONS.map(
    (ext) => `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\${SHELL_KEY_NAME}`,
  );
  for (const key of [KEY_DIRECTORY, KEY_DIRECTORY_BG, ...fileKeys]) {
    try {
      await regDeleteKey(key);
      log.info('folder context menu key deleted', { key });
    } catch {
      // already gone — no-op
    }
  }
}

/** 仅给单测用,导出 parser 让 ut 不依赖真实 reg.exe。 */
export const __testing = { parseRegDefault };
