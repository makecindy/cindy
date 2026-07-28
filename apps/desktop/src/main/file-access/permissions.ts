import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { shell } from 'electron';

import { createLogger } from '../logger.js';

const log = createLogger('file-access-permissions');

export type ProtectedFolderKind = 'Desktop' | 'Documents' | 'Downloads';

const PROTECTED_PATHS: Record<ProtectedFolderKind, string> = {
  Desktop: path.join(homedir(), 'Desktop'),
  Documents: path.join(homedir(), 'Documents'),
  Downloads: path.join(homedir(), 'Downloads'),
};

const TCC_SETTINGS_URLS: Record<ProtectedFolderKind, string> = {
  Desktop:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder',
  Documents:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder',
  Downloads:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_DownloadsFolder',
};

const EPERM_PATTERN_SOURCE = 'operation not permitted|eperm';

/**
 * 拒绝短语与受保护路径必须靠得足够近才算同一次失败。真实报错形如
 * `EPERM: operation not permitted, scandir '/Users/me/Desktop'`,两者间隔几十个字符;
 * 放开距离限制时,一段长文本里第 3 行的 "EPERM" 与第 900 行无关的路径会被凑成误报——
 * agent 读一份**内容里写着 EPERM 的源码**就足以触发。
 */
const EPERM_PROXIMITY_CHARS = 200;

function findEpermPhraseIndices(text: string): number[] {
  // 每次新建实例:全局正则的 lastIndex 是可变状态,复用会让相邻调用互相干扰。
  const pattern = new RegExp(EPERM_PATTERN_SOURCE, 'gi');
  const indices: number[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) indices.push(match.index);
  }
  return indices;
}

function findPathOrDescendantIndices(text: string, folderPath: string): number[] {
  const indices: number[] = [];
  let index = text.indexOf(folderPath);
  while (index !== -1) {
    const nextCharacter = text[index + folderPath.length];
    if (
      nextCharacter === undefined ||
      nextCharacter === '/' ||
      nextCharacter === '\\' ||
      nextCharacter === "'" ||
      nextCharacter === '"'
    ) {
      indices.push(index);
    }
    index = text.indexOf(folderPath, index + folderPath.length);
  }
  return indices;
}

/**
 * 双指针取代嵌套遍历:两个下标数组都是升序,O(n+m) 就能判断有没有一对足够近。
 * 逐个配对是 O(n×m)——agent 跑一次 `grep -rn EPERM ~/Documents/...` 就能让两边各有
 * 上万个下标,在 Main 的事件循环上跑上亿次比较。
 */
function hasNearbyIndex(ascendingA: number[], ascendingB: number[], maxDistance: number): boolean {
  let a = 0;
  let b = 0;
  while (a < ascendingA.length && b < ascendingB.length) {
    const delta = ascendingA[a]! - ascendingB[b]!;
    if (Math.abs(delta) <= maxDistance) return true;
    if (delta < 0) a += 1;
    else b += 1;
  }
  return false;
}

/**
 * Returns the folder kind if a macOS tool result looks like a protected-folder denial.
 *
 * 这只是**粗筛**:文本匹配无法区分「这是报错」和「这段文字里恰好写着 EPERM」。命中后
 * 必须用 {@link probeProtectedFolderAccess} 向系统核实,不要直接据此提示用户。
 */
export function detectProtectedFolderEperm(
  text: string,
  platform: NodeJS.Platform = process.platform,
): ProtectedFolderKind | null {
  if (platform !== 'darwin') return null;
  const phraseIndices = findEpermPhraseIndices(text);
  if (phraseIndices.length === 0) return null;
  for (const [kind, folderPath] of Object.entries(PROTECTED_PATHS) as [ProtectedFolderKind, string][]) {
    const pathIndices = findPathOrDescendantIndices(text, folderPath);
    if (hasNearbyIndex(phraseIndices, pathIndices, EPERM_PROXIMITY_CHARS)) return kind;
  }
  return null;
}

export type ProtectedFolderAccess = 'granted' | 'denied' | 'unknown';

/**
 * 由 Main 进程亲自读一次受保护目录,替代「从 agent 输出里推测」。两个作用:
 *
 * 1. **事实而非猜测**:读得动就说明权限没问题,agent 那条 EPERM 与 TCC 无关(通常是
 *    文本里恰好出现了这个词),不该打扰用户。
 * 2. **给系统授权弹窗一次机会**:TCC 按责任进程决定要不要弹窗,而 agent 的文件访问
 *    发自 Cindy → agent → shell 链末端的非 bundle 二进制,macOS 只会静默拒绝(见
 *    issue #198)。同一次访问改由 Cindy.app 自己发起时归因正确,配合 Info.plist 里的
 *    NSDesktop/Documents/DownloadsFolderUsageDescription,系统才可能弹出自己的授权窗。
 *
 * 调用方需自行串行化:并发探测同一目录会叠出多个系统弹窗。
 */
export async function probeProtectedFolderAccess(
  kind: ProtectedFolderKind,
  platform: NodeJS.Platform = process.platform,
): Promise<ProtectedFolderAccess> {
  if (platform !== 'darwin') return 'granted';
  try {
    // readdir 是 TCC 实际拦截的读操作;stat 一类元数据访问不会触发授权判定。
    // 未授权时这里会阻塞到用户回应系统弹窗,因此必须走异步 API。
    await readdir(PROTECTED_PATHS[kind]);
    return 'granted';
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'EPERM' || code === 'EACCES') return 'denied';
    // 目录不存在等情况与 TCC 无关,按「无法判定」处理:不提示,也不消耗提醒名额。
    log.warn('protected folder access probe failed', { kind, code });
    return 'unknown';
  }
}

// Shared across agent sessions for this app process. Restarting the app resets it.
const guidanceShownFor = new Set<ProtectedFolderKind>();
/**
 * 全进程同时只允许一次探测(不是每个目录一次)。未授权时 readdir 会一直卡到用户回应
 * 系统弹窗:并发探测既会同时叠出多个系统弹窗,又会占满 libuv 的默认 4 线程文件池,
 * 拖慢 Main 里其它所有文件操作。被挡掉的目录等下一条命中事件重试即可。
 */
let checkInFlightKind: ProtectedFolderKind | null = null;

/** Opens the matching macOS System Settings panel. Does nothing on other platforms. */
export async function openFolderPrivacySettings(
  kind: ProtectedFolderKind,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return;
  const url = TCC_SETTINGS_URLS[kind];
  log.info('opening folder privacy settings', { kind, url });
  await shell.openExternal(url);
}

/**
 * Reserves the right to run one probe-then-guide flow for a folder kind.
 *
 * 名额只在真的提示过用户之后才算用掉({@link markEpermGuidanceShown});探测发现权限
 * 其实正常时不占用,否则一次误报就会把这个目录的提醒名额永久吃掉,之后真被拒也不再提示。
 */
export function beginProtectedFolderCheck(kind: ProtectedFolderKind): boolean {
  if (guidanceShownFor.has(kind) || checkInFlightKind !== null) return false;
  checkInFlightKind = kind;
  return true;
}

export function endProtectedFolderCheck(kind: ProtectedFolderKind): void {
  if (checkInFlightKind === kind) checkInFlightKind = null;
}

/** Consumes the process-lifetime guidance slot for a folder kind. */
export function markEpermGuidanceShown(kind: ProtectedFolderKind): void {
  guidanceShownFor.add(kind);
}

/** Allows a retry when the native dialog failed before it could be shown. */
export function releaseEpermGuidance(kind: ProtectedFolderKind): void {
  guidanceShownFor.delete(kind);
}

export function resetEpermGuidanceForTest(): void {
  guidanceShownFor.clear();
  checkInFlightKind = null;
}
