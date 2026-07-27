import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app } from 'electron';

import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import { CINDY_MIME_TYPE, SHARE_MIME_TYPE } from '../../shared/fileTypes.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { createLogger } from '../logger.js';

/**
 * Windows 自有文件类型自注册:.cindy 文件关联(双击装入的
 * Windows 半边)+ .cindy / .cshare 的 MIME 媒体类型(注册表 Content Type)。
 *
 * 口径完全对齐 folderContextMenu.ts 的先例:
 * - HKCU(无需管理员,首次启动即写;多用户各自注册,与 installer.nsh 同路);
 * - best-effort:reg.exe 失败 / 超时一律 swallow + warn,绝不影响启动;
 * - 仅 packaged 构建注册 —— dev 的 electron.exe 路径写进注册表只会指向
 *   某个 checkout 的临时二进制,污染用户机器;
 * - 幂等:先查关键值,已是目标值就跳过(免得每次启动都写注册表)。
 *
 * .cshare(会话分享)只登记 MIME,不注册打开命令 —— 双击导入链路尚未实现,
 * 半吊子的 open command 只会把 app 拉起来然后没反应;导入入口仍是拖入窗口 /
 * 设置页按钮。macOS 的关联与 MIME 走 forge.config.ts 的 CFBundleDocumentTypes
 * + UTExportedTypeDeclarations(打包期声明,运行时无事可做);Finder 双击
 * .cindy 经 open-file 事件进 handleIncomingCindyFile。
 */

const log = createLogger('ghosts:file-assoc');
const execFileAsync = promisify(execFile);
const REG_TIMEOUT_MS = 5_000;

/**
 * 新身份 ProgId(2026-07-17 品牌翻转:XDMaker.CindyGhost → Cindy.CindyGhost;
 * 按区域 exe 基名派生,cn/global 'Cindy.CindyGhost'——2026-07-26 显示名统一
 * 后两区同 ProgId,双装时后启动方改写 open command 已被 owner 接受 / dev
 * 'CindyDev.CindyGhost' 仍独立)。与并存的老 XDMaker 安装写的
 * `XDMaker.CindyGhost` ProgId 各自独立,互不覆盖;`.cindy` 扩展名的默认
 * handler 归后启动的那个 app(它把 KEY_EXT 默认值改写成自己的 ProgId),
 * 可接受——各 app 双击 .cindy 的行为语义一致。
 */
const PROG_ID = `${brandExecutableName(CURRENT_CINDY_REGION)}.CindyGhost`;
const KEY_EXT = 'HKCU\\Software\\Classes\\.cindy';
const KEY_PROG = `HKCU\\Software\\Classes\\${PROG_ID}`;
const KEY_EXT_SHARE = 'HKCU\\Software\\Classes\\.cshare';

/** 自有格式的 MIME 类型,与 renderer 的拖拽识别共用一份定义(shared/fileTypes.ts)。 */
const CINDY_MIME = CINDY_MIME_TYPE;
const SHARE_MIME = SHARE_MIME_TYPE;

async function regQueryDefault(keyPath: string): Promise<string | null> {
  return regQuery(keyPath, ['/ve']);
}

/** 查命名值(如 Content Type);键或值不存在 → null。 */
async function regQueryNamed(keyPath: string, valueName: string): Promise<string | null> {
  return regQuery(keyPath, ['/v', valueName]);
}

async function regQuery(keyPath: string, selector: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', keyPath, ...selector], {
      timeout: REG_TIMEOUT_MS,
    });
    const match = stdout.match(/REG_SZ\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null; // 键不存在 / reg.exe 非 0 退出 → 当作未注册
  }
}

async function regSetDefault(keyPath: string, value: string): Promise<void> {
  await execFileAsync('reg', ['add', keyPath, '/ve', '/d', value, '/f'], { timeout: REG_TIMEOUT_MS });
}

async function regSetNamed(keyPath: string, valueName: string, value: string): Promise<void> {
  await execFileAsync('reg', ['add', keyPath, '/v', valueName, '/d', value, '/f'], {
    timeout: REG_TIMEOUT_MS,
  });
}

/** 启动时调用:fire-and-forget,内部吞掉一切失败。 */
export function registerCindyFileAssociation(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  void (async () => {
    try {
      const exe = process.execPath;
      const command = `"${exe}" "%1"`;
      const commandKey = `${KEY_PROG}\\shell\\open\\command`;
      const upToDate =
        (await regQueryDefault(KEY_EXT)) === PROG_ID &&
        (await regQueryDefault(commandKey)) === command &&
        (await regQueryNamed(KEY_EXT, 'Content Type')) === CINDY_MIME &&
        (await regQueryNamed(KEY_EXT_SHARE, 'Content Type')) === SHARE_MIME;
      if (upToDate) return; // 已注册、扩展名归属自己且指向当前 exe

      await regSetDefault(KEY_EXT, PROG_ID);
      await regSetNamed(KEY_EXT, 'Content Type', CINDY_MIME);
      await regSetDefault(KEY_PROG, 'Cindy Ghost');
      await regSetDefault(`${KEY_PROG}\\DefaultIcon`, `"${exe}",0`);
      await regSetDefault(commandKey, command);
      await regSetNamed(KEY_EXT_SHARE, 'Content Type', SHARE_MIME);
      log.info('registered .cindy file association and MIME types', { exe });
    } catch (err) {
      log.warn('register file association / MIME failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
