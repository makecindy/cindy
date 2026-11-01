import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createLogger } from './logger';
import { shouldSkipSystemIntegration } from './startupMode';

const log = createLogger('legacyDevShortcut');

/**
 * 清理 Start Menu 里指向 dev `node_modules\electron\dist\electron.exe` 的残留 .lnk。
 *
 * 背景：这类 .lnk 的 target 是裸 dev electron.exe、Arguments 为空，被 Windows 注册
 * 成 AUMID 后（如 `XdtMaker.Dev`、`electron.app.xdt-maker`），一旦 toast 点击触发
 * AUMID 激活机制，就会启动一个没有 app 参数的 electron.exe，弹出 Electron 默认
 * 欢迎页 —— 用户视角看就是"通知点了之后跳到一个空白 Electron 页"。
 *
 * 已知来源：
 *   - 老版本 SnoreToast `-install` 留下的 `XdtMakerDev.lnk`（AUMID `XdtMaker.Dev`）
 *   - Electron 自身按 productName 自动注册的 `Electron.lnk`（AUMID `electron.app.xdt-maker`），
 *     dev 第一次启动后偶现
 *
 * 策略：
 *   1. 快路径：按已知文件名（XdtMakerDev.lnk）直删
 *   2. 防御扫描：枚举 Start Menu Programs 下所有 .lnk，凡是 target 指向
 *      `node_modules\electron\dist\electron.exe` 且 Arguments 为空的一律删除
 *
 * 静默 try/catch：用户手动删过 / 没装过 / 权限问题 / PowerShell 异常都不影响主流程。
 */
export function cleanupLegacyDevShortcut(): Promise<void> {
  if (process.platform !== 'win32' || shouldSkipSystemIntegration()) return Promise.resolve();
  const appData = process.env.APPDATA;
  if (!appData) return Promise.resolve();
  const startMenuDir = path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

  // 快路径
  const knownLnk = path.win32.join(startMenuDir, 'XdtMakerDev.lnk');
  try {
    if (existsSync(knownLnk)) {
      unlinkSync(knownLnk);
      log.info('cleaned up legacy dev shortcut', knownLnk);
    }
  } catch (err) {
    log.warn('failed to remove legacy dev shortcut', err);
  }

  // 防御扫描：解析 .lnk target 必须走 WScript.Shell COM，所以走 PowerShell。
  // 单引号包路径并把内部 `'` 转成 `''`（PS 单引号字符串转义）。
  const psRoot = startMenuDir.replace(/'/g, "''");
  const ps =
    `$sh = New-Object -ComObject WScript.Shell; ` +
    `$root = '${psRoot}'; ` +
    `if (Test-Path $root) { ` +
    `Get-ChildItem -Path $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `try { ` +
    `$lnk = $sh.CreateShortcut($_.FullName); ` +
    `if ($lnk.TargetPath -match '(?i)node_modules\\\\electron\\\\dist\\\\electron\\.exe$' -and -not $lnk.Arguments) { ` +
    `Remove-Item -LiteralPath $_.FullName -Force; ` +
    `Write-Output ('removed: ' + $_.FullName) ` +
    `} ` +
    `} catch {} ` +
    `} ` +
    `}`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log.warn('dev shortcut scan failed', err.message);
        } else if (stdout.trim()) {
          for (const line of stdout.trim().split(/\r?\n/)) {
            log.info(line);
          }
        }
        resolve();
      },
    );
  });
}
