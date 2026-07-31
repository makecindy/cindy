/**
 * installCliCommand — 把 `cindy` 命令装到 shell PATH(macOS)
 * ---------------------------------------------------------------------------
 * 类比 VS Code 的 "Install 'code' command in PATH",且**完全对齐其实现方式**:
 * 不往 PATH 里写一份生成的脚本,而是在 `/usr/local/bin/cindy` 建一个 **symlink**,
 * 指向随 app 分发的启动器脚本 `<Cindy.app>/Contents/Resources/cli/cindy`
 * (forge.config.ts 的 extraResource 注入,见 resources/cli/cindy)。之后终端里
 * `cindy .` 就能把当前工作目录作为工作目录在 Cindy 里打开。
 *
 * symlink 而非写脚本的好处(与 VS Code 一致):升级 app 后无需重装,symlink 始终
 * 指向包内最新脚本;卸载只需删 symlink。启动器脚本自身会跟随 symlink 反推 .app 根,
 * 因此 app 移动位置后仍可用。
 *
 * 接收侧不需要新代码:app 已声明 `public.folder` 文档类型
 * (forge.config.ts CFBundleDocumentTypes),macOS 上 `open -a Cindy <目录>` 会通过
 * `open-file` 事件进入 bootstrap-electron 的 handleIncomingOpenFolder,落成
 * 「新建对话 + 预填工作目录」。
 *
 * 权限策略(对齐 VS Code nativeHostMainService):
 *   - 安装:**一律**通过 osascript「以管理员身份」执行
 *     `mkdir -p /usr/local/bin && ln -sf '<target>' '<source>'`。不先尝试直接写——
 *     /usr/local/bin 常属 root,直接建 symlink 多半 EACCES,直接弹一次系统授权更干净。
 *     弹系统口令前先弹一个应用内确认框(warnEscalation),取消则不动手。
 *   - 卸载:先直接 `unlink`,只有 EACCES 才升级到 osascript `rm`;ENOENT 视为已卸载。
 *
 * 平台 / 构建门:
 *   - 仅 macOS(原生应用菜单本身就只在 darwin 装,见 installApplicationMenu)。
 *   - 仅 packaged:dev 模式下 process.resourcesPath 指向 Electron 自带 resources,
 *     包内 cli/cindy 不存在且 `open -a` 找不到 Cindy.app;dev 下给出说明弹窗而不动手。
 *
 * 卸载:导出 uninstallCindyCliCommand 作为命令行/测试入口,不挂菜单
 * (与 folderContextMenu.ts 的 unregisterFolderContextMenu 同一取舍)。
 */

import { app, BrowserWindow, dialog } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { brandExecutableName } from '@cindy/maker-shared/brand-identity';

import { createLogger } from './logger';
import {
  APPLICATION_MENU_LABELS,
  type ApplicationMenuLabels,
  type ApplicationMenuLocale,
} from './applicationMenuLabels.js';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';

const execFileAsync = promisify(execFile);
const log = createLogger('installCliCommand');

/**
 * 装进 PATH 的命令名,**跟随本构建 edition 品牌**:由区域可执行名小写化而来
 * (global/cn 展示名统一为 Cindy → `cindy`;内部 dev 构建 → `cindydev`)。
 * *nix 命令惯例用小写,与 forge 给 linux 包名用 `CINDY_EXE.toLowerCase()` 同一处理;
 * 未注入区域默认 global(见 brandRegion / region-and-editions.md §2.2)。
 */
export const CLI_COMMAND_NAME = brandExecutableName(CURRENT_CINDY_REGION).toLowerCase();

/** PATH 里的 symlink 位置(命令名随 edition 品牌)。与 VS Code 的 `code` 同目录。 */
export const CLI_LINK_PATH = `/usr/local/bin/${CLI_COMMAND_NAME}`;

/** osascript 超时。管理员授权弹窗需要用户输入,给足时间。 */
const INSTALL_TIMEOUT_MS = 60_000;

/**
 * symlink 指向的目标:包内启动器脚本 `<Resources>/cli/cindy`。
 * 与 forge.config.ts extraResource 的 `resources/cli` 落点一致。
 */
export function resolveBundledCliPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'cli', 'cindy');
}

/** POSIX shell 单引号转义:把值安全地包进 '...'。 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 安装用 shell 命令:先确保 /usr/local/bin 存在,再强制建 symlink(-f 覆盖旧的/坏的)。
 * 交给 osascript「以管理员身份」执行。与 VS Code 的命令串一致。
 */
export function buildInstallShellCommand(target: string, source: string): string {
  const dir = path.dirname(source);
  return `mkdir -p ${shellSingleQuote(dir)} && ln -sf ${shellSingleQuote(target)} ${shellSingleQuote(
    source,
  )}`;
}

/** 卸载用 shell 命令(仅在直接 unlink 遇 EACCES 时才走管理员分支)。 */
export function buildUninstallShellCommand(source: string): string {
  return `rm ${shellSingleQuote(source)}`;
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/** osascript 授权弹窗被用户取消时的错误特征(errAEEventNotHandled -128 / "User canceled")。 */
function isUserCancelledAdmin(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | undefined;
  const text = `${typeof e?.stderr === 'string' ? e.stderr : ''} ${
    typeof e?.message === 'string' ? e.message : ''
  }`;
  return text.includes('-128') || /User can(?:c|)elled|User canceled/i.test(text);
}

/**
 * 在 AppleScript 双引号字符串里安全嵌入一段 shell 命令:转义反斜杠与双引号。
 * 命令里的路径已用单引号包裹,不含裸双引号,这里主要兜底路径中的反斜杠。
 */
function escapeForAppleScriptString(command: string): string {
  return command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runWithAdmin(shellCommand: string): Promise<void> {
  const appleScript = `do shell script "${escapeForAppleScriptString(
    shellCommand,
  )}" with administrator privileges`;
  await execFileAsync('osascript', ['-e', appleScript], {
    timeout: INSTALL_TIMEOUT_MS,
  });
}

/**
 * source(PATH 里的 symlink)是否已正确指向 target(包内脚本)。
 * 对齐 VS Code:仅当 source 是 symlink 且其真实路径等于 target 真实路径时算「已装」。
 * 非 symlink 或指向别处,都返回 false 让安装流程用 `ln -sf` 覆盖。
 */
async function isAlreadyLinked(source: string, target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(source);
    if (!stat.isSymbolicLink()) return false;
    const [sourceReal, targetReal] = await Promise.all([
      fs.promises.realpath(source),
      fs.promises.realpath(target),
    ]);
    return sourceReal === targetReal;
  } catch {
    // ENOENT / 悬空 symlink / target 不存在等 → 视为未安装,交给后续流程处理。
    return false;
  }
}

function labelsFor(locale: ApplicationMenuLocale): ApplicationMenuLabels {
  return APPLICATION_MENU_LABELS[locale];
}

/** 展开标签占位符:`{{path}}` → symlink 路径,`{{cmd}}` → 品牌命令名(全部出现处)。 */
function fmt(template: string, linkPath: string): string {
  return template.split('{{path}}').join(linkPath).split('{{cmd}}').join(CLI_COMMAND_NAME);
}

async function showMessage(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  if (window && !window.isDestroyed()) {
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

/**
 * 「安装到命令行」菜单动作。整段在 main 进程执行(菜单 click 回调本就在 main),
 * 不新增 IPC / preload 面。失败只弹窗 + warn,不抛;用户取消静默返回。
 */
export async function installCindyCliCommand(
  window: BrowserWindow | null,
  locale: ApplicationMenuLocale,
): Promise<void> {
  const labels = labelsFor(locale);

  if (process.platform !== 'darwin') {
    await showMessage(window, {
      type: 'info',
      message: labels.installCliUnsupportedTitle,
      detail: labels.installCliUnsupportedDetail,
    });
    return;
  }

  if (!app.isPackaged) {
    await showMessage(window, {
      type: 'info',
      message: labels.installCliDevOnlyTitle,
      detail: labels.installCliDevOnlyDetail,
    });
    return;
  }

  const source = CLI_LINK_PATH;
  const target = resolveBundledCliPath(process.resourcesPath);

  // 包内启动器脚本缺失(打包异常)→ 明确报错,不尝试建指向空的 symlink。
  if (!fs.existsSync(target)) {
    log.warn('bundled cindy launcher missing; cannot install', { target });
    await showMessage(window, {
      type: 'error',
      message: labels.installCliErrorTitle,
      detail: `${fmt(labels.installCliErrorDetail, source)}\n\n${target}`,
    });
    return;
  }

  // 已正确安装:直接告知成功,不重复弹管理员授权。
  if (await isAlreadyLinked(source, target)) {
    log.info('cindy CLI command already installed', { source, target });
    await showMessage(window, {
      type: 'info',
      message: fmt(labels.installCliSuccessTitle, source),
      detail: fmt(labels.installCliSuccessDetail, source),
    });
    return;
  }

  const confirm = await showMessage(window, {
    type: 'question',
    buttons: [labels.installCliConfirmOk, labels.installCliCancel],
    defaultId: 0,
    cancelId: 1,
    message: fmt(labels.installCliConfirmTitle, source),
    detail: fmt(labels.installCliConfirmDetail, source),
  });
  if (confirm.response !== 0) return;

  try {
    await runWithAdmin(buildInstallShellCommand(target, source));
    log.info('cindy CLI command installed', { source, target });
    await showMessage(window, {
      type: 'info',
      message: fmt(labels.installCliSuccessTitle, source),
      detail: fmt(labels.installCliSuccessDetail, source),
    });
  } catch (err) {
    if (isUserCancelledAdmin(err)) {
      log.info('cindy CLI install cancelled by user at admin prompt');
      return;
    }
    log.warn('failed to install cindy CLI command', err);
    await showMessage(window, {
      type: 'error',
      message: labels.installCliErrorTitle,
      detail: `${fmt(labels.installCliErrorDetail, source)}\n\n${(err as Error)?.message ?? String(err)}`,
    });
  }
}

/**
 * 卸载入口(命令行 / 测试用,不挂菜单)。先直接 unlink,EACCES 才升级到管理员 rm,
 * ENOENT 视为已卸载。对齐 VS Code uninstallShellCommand。
 */
export async function uninstallCindyCliCommand(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const source = CLI_LINK_PATH;
  try {
    await fs.promises.unlink(source);
    log.info('cindy CLI command uninstalled', { source });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    if (!isPermissionError(err)) {
      log.warn('failed to uninstall cindy CLI command (non-fatal)', err);
      return;
    }
  }
  try {
    await runWithAdmin(buildUninstallShellCommand(source));
    log.info('cindy CLI command uninstalled (elevated)', { source });
  } catch (err) {
    log.warn('failed to uninstall cindy CLI command with privileges (non-fatal)', err);
  }
}

/** 仅给单测:导出纯函数,不依赖 Electron / 真实文件系统。 */
export const __testing = {
  shellSingleQuote,
  escapeForAppleScriptString,
  isPermissionError,
  isUserCancelledAdmin,
};
