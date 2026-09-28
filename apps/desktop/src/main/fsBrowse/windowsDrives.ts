/**
 * Windows 盘符枚举 —— 目录浏览(`fs:list-dir`)的「切换盘符」用。
 *
 * Windows 没有能导航到其它盘的上级目录:`C:\` 的上级就是它自己,只靠逐级浏览永远到不了
 * `D:\`。这里列出本机逻辑驱动器,随 list-dir 结果回给控制端直接切换。
 *
 * 只读盘符表(Win32 GetLogicalDrives),不访问任何磁盘:断线的网络映射盘、空光驱都不会让
 * 探测卡住(逐个 stat `A:`~`Z:` 会在断线网络盘上长时间占住 libuv 线程池)。Node 没有该 API,
 * 借 PowerShell 调 .NET;结果短缓存,失败按空列表降级(控制端不显示盘符切换)。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '../logger.js';

const log = createLogger('fsBrowse/windowsDrives');
const execFileAsync = promisify(execFile);

export interface FsBrowseDrive {
  /** 显示名:盘符为 `C:`;UNC 共享为根路径去掉末尾分隔符。 */
  name: string;
  /** host-native 根路径(如 `C:\`),控制端直接拿它调 fs:list-dir。 */
  path: string;
  /** 当前浏览路径是否位于该根下。 */
  current: boolean;
}

type DriveCommand = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

/** 插拔 U 盘等变化不频繁;缓存只为避免逐级浏览时每层都起一次 PowerShell。 */
const DRIVE_CACHE_TTL_MS = 30_000;
/** 忙碌主机上 PowerShell 冷启动可能数秒;超时只影响盘符列表,不影响目录列表本身。 */
const DRIVE_COMMAND_TIMEOUT_MS = 5_000;

/** 解析 GetLogicalDrives 输出(每行一个 `C:\`),去重、统一大写并按盘符排序。 */
export function parseLogicalDriveRoots(stdout: string): string[] {
  const roots = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Za-z]):\\?$/.exec(line.trim());
    if (match) roots.add(`${match[1]!.toUpperCase()}:\\`);
  }
  return [...roots].sort();
}

function driveLetterRoot(root: string): string | null {
  const match = /^([A-Za-z]):[\\/]?$/.exec(root);
  return match ? `${match[1]!.toUpperCase()}:\\` : null;
}

/**
 * 盘符列表 + 标出当前所在盘。当前路径位于未列出的根(枚举后新挂的盘、UNC 共享)时补进去,
 * 保证控制端总能看到「当前盘」。路径语义固定按 Windows 解析(只在 win32 被控端调用)。
 */
export function buildDriveOptions(roots: readonly string[], resolvedPath: string): FsBrowseDrive[] {
  const currentRoot = path.win32.parse(resolvedPath).root;
  const currentDrive = driveLetterRoot(currentRoot);
  const driveRoots = new Set(roots);
  if (currentDrive) driveRoots.add(currentDrive);
  const drives: FsBrowseDrive[] = [...driveRoots].sort().map((root) => ({
    name: root.slice(0, 2),
    path: root,
    current: root === currentDrive,
  }));
  if (!currentDrive && currentRoot.startsWith('\\\\')) {
    drives.push({ name: currentRoot.replace(/[\\/]+$/, ''), path: currentRoot, current: true });
  }
  return drives;
}

async function queryLogicalDriveRoots(run: DriveCommand): Promise<string[]> {
  const powershell = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const { stdout } = await run(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[System.IO.Directory]::GetLogicalDrives()'],
      { encoding: 'utf8', timeout: DRIVE_COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024, windowsHide: true },
    );
    return parseLogicalDriveRoots(stdout);
  } catch (err) {
    log.warn('list logical drives failed; drive switching hidden', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * 带缓存与并发合并的盘符枚举;永不 reject,失败返回空列表(同样缓存,避免反复起进程)。
 * 缓存过期后先返回旧值并在后台刷新,只有首次枚举需要等 PowerShell。
 */
export function createWindowsDriveRootLister(
  options: { run?: DriveCommand; now?: () => number } = {},
): () => Promise<string[]> {
  const run = options.run ?? execFileAsync;
  const now = options.now ?? Date.now;
  let cached: { at: number; roots: string[] } | null = null;
  let inflight: Promise<string[]> | null = null;
  return () => {
    if (!cached || now() - cached.at >= DRIVE_CACHE_TTL_MS) {
      inflight ??= queryLogicalDriveRoots(run)
        .then((roots) => {
          cached = { at: now(), roots };
          return roots;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return cached ? Promise.resolve(cached.roots) : inflight!;
  };
}

export const listWindowsDriveRoots = createWindowsDriveRootLister();
