import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSingleInstanceLockUserDataDir, shouldRequestSingleInstanceLock } from './devCliFlags';
import { getCindyVersionLockScope } from './cindy-make/versionRuntimeIdentity';
import { markDesktopDevStartupFailed } from './devStartupStatus';
import { findDeepLinkInArgv, redactConsumedDeepLinkInArgv } from './deepLinkArgv';
import { createWindowsDeepLinkHandoff, deepLinkRequestData } from './windowsDeepLinkHandoff';
import { loadPackagedWindowsShellNative } from './windowsTaskbarNative';
import { versionEntryArguments } from './cindy-make/versionLaunchArguments';
import { createLogger } from './logger';

const log = createLogger('deepLink:handoff');

type Launch = { kind: 'link'; url: string; source: string } | { kind: 'argv'; argv: string[] };
let handler: ((launch: Launch) => void) | undefined;
const pending: Launch[] = [];

function deliver(launch: Launch): void {
  if (handler) handler(launch);
  else pending.push(launch);
}

export function handleInstanceLaunches(callback: (launch: Launch) => void): void {
  handler = callback;
  for (const launch of pending.splice(0)) callback(launch);
}

// ── Single instance lock ─────────────────────────────────────────────────
// 正常 dev 与 packaged 一律启用。这是把 OS 因深链(cindy://focus 授权返回 /
// cindy://session 等)/ 右键 "通过 Cindy 打开" 而拉起的第二个进程 redirect 成
// "聚焦已运行窗口" 的机制。Windows 普通浏览器不能经 WM_COPYDATA 通知提权实例，
// 这种权限组合补走同用户、同锁域的有界深链管道，沿用同一解析与 pending 入口。
//
// 锁按 flavor 分域(resolveSingleInstanceLockUserDataDir):packaged 锁真实
// userData(release 之间单实例);dev 锁 `<userData>/dev-single-instance-lock`
// 子目录(dev 之间单实例、深链 redirect 保持有效)。因此 dev 与正式版可以共库
// 双开——这是明确支持的工作流,跨实例并发由 SQLite WAL + busy_timeout、scheduler
// DB 级原子认领、auth replacement-retry 等既有仲裁收敛(与 --passive 共库多开
// 同一套)。2026-07-19 曾让 dev 与 packaged 抢同一把锁(修 dev 深链冷启动重复
// 实例),误伤了 dev + release 双开,2026-07-20 按 flavor 分域恢复,两个目标同时保住。
//
// dev `--passive` 仍完全跳过锁:它的公开契约是与 primary 共享数据任意多开,一个
// primary 后可并行任意多个 preview。此模式没有 second-instance redirect,deep link
// 落到哪个实例由当前 OS 协议注册归属决定。localDb 首次开库时会只读核对
// schema_version、完整 migration history 与 SQL/companion TS runtime 指纹;
// pending / 超前 / drift 都拒绝启动。passive 自己不迁移/repair schema,并用多
// reader lease 阻止之后的 primary 抢跑 migration。
// 隔离数据实例走 `--isolated[=<名字>]`(独立 userData → 独立锁域,见 docs/dev-rules/desktop-development.md)。
export function acquireDesktopInstanceLock(): boolean {
  const versionScope = getCindyVersionLockScope();
  if (versionScope === null && !shouldRequestSingleInstanceLock({
    isPackaged: app.isPackaged,
    schedulerPassive: process.env.XDT_SCHEDULER_PASSIVE === '1',
  })) return true;
  const realUserDataDir = app.getPath('userData');
  const lockScopeDir =
    versionScope === 'profile'
      ? realUserDataDir
      : versionScope === 'dev'
        ? path.join(realUserDataDir, 'dev-single-instance-lock')
        : resolveSingleInstanceLockUserDataDir({
            isPackaged: app.isPackaged,
            userDataDir: realUserDataDir,
          });
  const startupUrl = process.platform === 'win32' ? findDeepLinkInArgv(process.argv) : null;
  // Chromium can reorder Windows switches ahead of the dev app path. Keep the
  // original file operands together on Electron's existing second-instance channel.
  // The native fallback remains restricted to deep links.
  const fileArgs = process.platform === 'win32' && process.defaultApp && !startupUrl
    ? versionEntryArguments(process.argv.slice(2))
    : [];
  const hasSeparateFileOperand = fileArgs.includes('--open-folder') || fileArgs.includes('--open-share-file');
  const startupRequest = startupUrl ? deepLinkRequestData()
    : hasSeparateFileOperand ? { cindyFileArgs: fileArgs } : undefined;
  let windowsHandoff: ReturnType<typeof createWindowsDeepLinkHandoff> | undefined;
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      const native = loadPackagedWindowsShellNative();
      if (native) {
        windowsHandoff = createWindowsDeepLinkHandoff({
          lockScopeDir,
          native,
          isDeepLink: (url) => findDeepLinkInArgv([url]) !== null,
          dispatch: (url, source) => deliver({ kind: 'link', url, source }),
          // Do not log native exceptions or incoming URLs: they may hold secrets.
          onFailure: (stage) => log.warn('Windows handoff failed', { stage }),
        });
      }
    } catch {
      log.warn('Windows handoff unavailable');
    }
  }
  let gotTheLock: boolean;
  if (lockScopeDir === realUserDataDir) {
    gotTheLock = app.requestSingleInstanceLock(startupRequest);
  } else {
    // Electron 没有自定义锁作用域的 API:锁文件 / socket 按调用时刻的 userData
    // 路径生成。这里在同步窗口内临时切换 userData 再还原——主进程单线程,中间
    // 不会有其它 JS 观察到临时值;锁建立后内部通道与 userData 后续取值无关。
    fs.mkdirSync(lockScopeDir, { recursive: true });
    app.setPath('userData', lockScopeDir);
    try {
      gotTheLock = app.requestSingleInstanceLock(startupRequest);
    } finally {
      app.setPath('userData', realUserDataDir);
    }
  }
  if (!gotTheLock) {
    // Synchronous, bounded send in the losing process, before app.quit(). The
    // owning process coalesces this with second-instance by the launch ID.
    if (startupUrl && windowsHandoff) {
      if (windowsHandoff.forward(startupUrl, startupRequest)) log.info('queued Windows handoff');
    }
    if (startupUrl) redactConsumedDeepLinkInArgv(process.argv, startupUrl);
    markDesktopDevStartupFailed(
      'SINGLE_INSTANCE_OWNED',
      'Another Cindy instance already owns this single-instance lock scope.',
      { userDataDir: realUserDataDir, lockScopeDir },
    );
    app.quit();
    return false;
  }
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const url = findDeepLinkInArgv(argv);
    if (url) {
      redactConsumedDeepLinkInArgv(argv, url);
      if (windowsHandoff) windowsHandoff.dispatch(url, additionalData, 'second-instance');
      else deliver({ kind: 'link', url, source: 'second-instance' });
    } else {
      const original = (additionalData as { cindyFileArgs?: unknown } | undefined)?.cindyFileArgs;
      const fileArgs = Array.isArray(original) && original.length <= 17 &&
        original.every((arg) => typeof arg === 'string' && arg.length <= 16_384)
        ? versionEntryArguments(original) : [];
      deliver({ kind: 'argv', argv: fileArgs.length ? [argv[0], ...fileArgs] : argv });
    }
  });
  windowsHandoff?.start();
  app.once('will-quit', () => windowsHandoff?.close());
  return true;
}
