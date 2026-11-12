/**
 * apps/desktop/src/main/maker-host/codex-auth-link.ts
 *
 * Codex auth.json 共享链接的"安全替换"原语 —— 从 auth-adapters 的 reconcile 流程里拆出来,
 * 不依赖 Electron, 可单测。
 *
 * 背景 (2026-06-18 线上踩坑):
 *   reconcile 把 codex-home/auth.json 替换成指向 ~/.codex/auth.json 的硬链时, 原实现用**固定**
 *   sidecar 名 `auth.json.linktmp` + 「rm myAuth → rename tmp→myAuth」两步。而 reconcile 有多个
 *   调用点 (构造 / getState / getAuthEnv / getAccessToken / getAccountId / 登录成功) 且无串行化,
 *   并发跑时撞同一个 sidecar:
 *     - 两个并发 link 同名 tmp → 第二个 `EEXIST`
 *     - 一个已把 tmp rename 走 → 另一个 rename 同名 tmp → `ENOENT`
 *   更糟: rename 失败发生在 `rm(myAuth)` 之后, 原 catch 只清 tmp、不重建 myAuth, 会留下
 *   "myAuth 被删却没建回"的空窗 → 用户凭空丢失登录态、被迫重登, 且 reconcile 持续失败陷入循环。
 *
 * 这里的修复:
 *   1. 每次调用用**唯一** sidecar 名 (pid + 自增计数), 同进程内并发调用各用各的, 从根上消除撞名。
 *   2. rename 失败且 myAuth 已不在时, 尽力用 symlink 把 myAuth 从 systemAuth 重建回来 ——
 *      不能建共享链接时由调用方进入独立登录, 不复制 refresh token。
 *
 * 注意: 本模块只管"安全替换"这一件事, 不做账号比对 / inode 短路 / suppress 标记等判定 ——
 * 那些仍由 auth-adapters 的 reconcile 主流程负责。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { moveCodexAuthFile } from './codex-auth-file-move';

const execFileP = promisify(execFile);

/**
 * Compare directory entries, not target inodes. Stat only the parent so a
 * junction/directory symlink is recognized without conflating distinct hardlinks
 * or a replaceable file symlink with the native entry itself.
 * Missing parents cannot alias an existing entry; other lookup errors fail closed.
 */
export function codexAuthPathsShareEntry(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  if (path.basename(a) !== path.basename(b)) return false;
  try {
    const parentA = fs.statSync(path.dirname(a), { bigint: true });
    const parentB = fs.statSync(path.dirname(b), { bigint: true });
    if (parentA.ino === 0n || parentB.ino === 0n) {
      throw new Error('Cannot establish Codex auth parent directory identity');
    }
    return parentA.dev === parentB.dev && parentA.ino === parentB.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Windows: icacls 授权主体。域账户组合 `DOMAIN\\user`(缺域回退裸用户名);
 * username 自带 `\\` 或 `@`(UPN)时视为已限定,不再拼接。
 * 单源在本模块 —— auth-adapters 的 tightenAclWindows 同样消费(它 import 本模块,
 * 反向 import 会成环)。
 */
export function resolveWindowsAclPrincipal(
  env: Partial<Pick<NodeJS.ProcessEnv, 'USERDOMAIN' | 'USERNAME'>> = process.env,
  fallbackUsername = os.userInfo().username,
): string {
  const username = env.USERNAME?.trim() || fallbackUsername.trim();
  const domain = env.USERDOMAIN?.trim();
  if (!domain || username.includes('\\') || username.includes('@')) return username;
  return `${domain}\\${username}`;
}

/** unlink/rename 因 ACL 拒绝(而非文件缺席/占用等)失败。 */
function isWindowsAclDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * #3469: 迁移来的 auth.json 可能带着"死 SID"ACL —— 旧机器/旧账户的单条 ACE、
 * 无继承,当前账户连 unlink 都 EPERM。best-effort 自愈:
 *   1. `icacls /reset` 恢复父目录继承 —— codex-home 是 Cindy 在本机建的目录,
 *      当前用户可达,继承回来即可读写删;
 *   2. 兜底显式授当前主体 Full(reset 需要 WRITE_DAC,极端 ACL 下可能也被拒)。
 * 只在调用方确认 EPERM/EACCES 后调用;两步都失败返回 false,由调用方按原
 * 失败路径处理(行为不变),绝不把"修 ACL 失败"升级成新错误。
 */
async function healWindowsAuthAcl(
  file: string,
  execFileImpl: typeof execFileP = execFileP,
): Promise<boolean> {
  try {
    await execFileImpl('icacls', [file, '/reset']);
    return true;
  } catch {
    // fallthrough: reset 被拒时试显式授权。
  }
  try {
    await execFileImpl('icacls', [file, '/grant:r', `${resolveWindowsAclPrincipal()}:F`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * relinkSharedCodexAuth 的结果分类:
 *   - linked              成功:symlink 指向 systemAuth(含 Windows;不再建 hardlink,#9277)
 *   - same-entry          两个路径是同一目录项,无需迁移且不能删除其中一端
 *   - link-unsupported    建不了共享链接;Windows 仅移除仍共享系统 inode 的旧硬链接别名
 *   - swap-failed-intact  替换失败但 myAuth 仍在 (多半是并发的另一次 reconcile 已抢先放好)
 *   - recovered           替换中途 myAuth 一度丢失, 已从 systemAuth 重建共享链接
 *   - lost                替换失败且无法重建 (systemAuth 也读不了) → 需要用户重新登录
 */
export type RelinkResultKind =
  'linked' | 'same-entry' | 'link-unsupported' | 'swap-failed-intact' | 'recovered' | 'lost';

export interface RelinkOutcome {
  kind: RelinkResultKind;
  linkType?: 'symlink' | 'hardlink';
  /** 失败路径上的底层错误, 供调用方打日志; linked 时为 undefined。 */
  error?: Error;
}

export type CodexAuthSnapshotKind =
  'copied' | 'copy-unsupported' | 'swap-failed-intact' | 'source-changed' | 'lost';

export interface CodexAuthSnapshotOutcome {
  kind: CodexAuthSnapshotKind;
  error?: Error;
}

export interface CodexAuthLinkDiagnostics {
  linkType: 'symlink' | 'hardlink' | 'file' | 'missing' | 'dangling-symlink' | 'unknown';
  healthy: boolean;
  systemAuthMtimeMs?: number;
  systemAuthLinkCount?: number;
}

/** 同进程内自增, 保证并发调用拿到互不相同的 sidecar 路径。 */
let sidecarCounter = 0;

/**
 * 原子地把 myAuth 替换成指向 systemAuth 的共享链接。
 *
 * 调用方需自行保证 systemAuth 存在、且两边是同账号 (本函数不做账号比对)。
 * 并发安全: 每次调用使用唯一 sidecar, 不会和同进程内其它调用撞同名临时文件。
 */
export async function relinkSharedCodexAuth(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
): Promise<RelinkOutcome> {
  // 唯一 sidecar 名 (pid + 自增计数): 同进程内并发 reconcile 各用各的, 不再撞 EEXIST / ENOENT。
  const sidecar = `${myAuth}.${process.pid}.${sidecarCounter++}.linktmp`;

  // Codex 0.165+ 拒绝写入 nlink>1 的 auth.json(#9277)。文件 symlink 会被跟随,
  // 原子替换只落在单一目标上。Windows 无开发者模式时 symlink 会 EPERM:这里不退回
  // hardlink(那会把 Codex 登录再次卡死)。无权限时由调用方进入独立登录。
  try {
    await fsp.stat(systemAuth);
    if (codexAuthPathsShareEntry(systemAuth, myAuth)) return { kind: 'same-entry' };
    await fsp.symlink(systemAuth, sidecar, 'file');
  } catch (error) {
    if (platform === 'win32') removeLegacyCodexAuthAlias(systemAuth, myAuth);
    return { kind: 'link-unsupported', error: error as Error };
  }

  // POSIX rename 可原子覆盖旧文件，没有“先删后建”空窗。Windows 仍需先删目标。
  try {
    if (platform === 'win32') {
      try {
        await fsp.rm(myAuth, { force: true });
      } catch (rmError) {
        // #3469: 死 SID ACL 让 unlink EPERM → reconcile 永久 swap-failed-intact、
        // 登录卡在最后一步。先 best-effort 修 ACL 再重试一次;修不动按原失败
        // 路径返回,行为与修复前一致。
        if (!isWindowsAclDenied(rmError) || !(await healWindowsAuthAcl(myAuth, execFileImpl))) {
          throw rmError;
        }
        await fsp.rm(myAuth, { force: true });
      }
    }
    if (platform === 'win32') await moveCodexAuthFile(sidecar, myAuth);
    else await fsp.rename(sidecar, myAuth);
    // 顺手清掉可能残留的 sidecar，避免并发下 .linktmp 堆积。
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { kind: 'linked', linkType: 'symlink' };
  } catch (error) {
    // 替换失败: 先清掉 sidecar, 再判断 myAuth 是否还在。
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    if (await pathEntryExists(myAuth)) {
      // 危险窗口没真正发生 (myAuth 还在) —— 多半是并发的另一次替换已抢先放好, 无需补救。
      return { kind: 'swap-failed-intact', error: error as Error };
    }
    // myAuth 被删却没换上 → 绝不能让用户凭空丢登录态, 尽力从 systemAuth 重建。
    const recovered = await recoverCodexAuth(systemAuth, myAuth, platform);
    if (recovered) return { kind: 'recovered', error: error as Error };
    // 重建期间目标又被本机 Codex 建了出来(新一代凭证):目标现在是在的,
    // 不能报 lost 让用户重新登录(#9316 review)。
    if (await pathEntryExists(myAuth)) {
      return { kind: 'swap-failed-intact', error: error as Error };
    }
    return { kind: 'lost', error: error as Error };
  }
}

/**
 * myAuth 在替换中途丢失时的兜底重建。只重建共享链接，绝不复制 token。
 *
 * @returns 是否成功让 myAuth 重新存在
 */
export async function recoverCodexAuth(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
): Promise<boolean> {
  try {
    await fsp.stat(systemAuth);
    if (codexAuthPathsShareEntry(systemAuth, myAuth)) return true;
  } catch {
    return false;
  }
  try {
    await fsp.symlink(systemAuth, myAuth, 'file');
    return true;
  } catch {
    return false;
  }
}

/** Remove only this Cindy home's obsolete alias; the native credential is never rewritten.
 * No asynchronous work separates the identity check from unlink. Independent files and
 * symlinks are preserved, including a native credential that already rotated away.
 */
function removeLegacyCodexAuthAlias(systemAuth: string, myAuth: string): boolean {
  try {
    if (codexAuthPathsShareEntry(systemAuth, myAuth)) return false;
    const local = fs.lstatSync(myAuth, { bigint: true });
    const system = fs.statSync(systemAuth, { bigint: true });
    if (
      !local.isFile() ||
      local.nlink <= 1n ||
      local.ino === 0n ||
      local.ino !== system.ino ||
      local.dev !== system.dev
    )
      return false;
    fs.unlinkSync(myAuth);
    return true;
  } catch {
    return false;
  }
}

/** One-way snapshot for read-only Dev use. Never called to publish a system credential. */
export async function copyCodexAuthSnapshot(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
): Promise<CodexAuthSnapshotOutcome> {
  const token = `${process.pid}.${randomUUID()}`;
  const sidecar = `${myAuth}.${token}.copytmp`;
  let sourceStat: BigIntStats;
  try {
    if (codexAuthPathsShareEntry(systemAuth, myAuth)) {
      throw new Error('Cannot snapshot a Codex credential onto its own directory entry');
    }
    // 身份比较必须用 bigint:NTFS 的 file id 可能超出安全整数范围,四舍五入后
    // 两个不同的 inode 会比较成相等 —— 撕裂代次的字节会被当成稳定代次发布,
    // 随后的等 mtime 对账再把旧 refresh token 写回系统文件(#9316 review)。
    sourceStat = await fsp.stat(systemAuth, { bigint: true });
    await fsp.copyFile(systemAuth, sidecar);
    await fsp.chmod(sidecar, Number(sourceStat.mode & 0o777n)).catch(() => undefined);
    // 复制期间源换代 → 撕裂代次的字节作废,交给调用方重新对账。
    const sourceStatAfter = await fsp.stat(systemAuth, { bigint: true });
    if (
      sourceStatAfter.dev !== sourceStat.dev ||
      sourceStatAfter.ino !== sourceStat.ino ||
      sourceStatAfter.mtimeNs !== sourceStat.mtimeNs ||
      sourceStatAfter.size !== sourceStat.size
    ) {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      return { kind: 'source-changed' };
    }
  } catch (error) {
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { kind: 'copy-unsupported', error: error as Error };
  }

  try {
    await fsp
      .utimes(
        sidecar,
        codexAuthTimestampSeconds(sourceStat.atimeNs),
        codexAuthTimestampSeconds(sourceStat.mtimeNs),
      )
      .catch(() => undefined);
    if (platform === 'win32') {
      try {
        await fsp.rm(myAuth, { force: true });
      } catch (error) {
        if (!isWindowsAclDenied(error) || !(await healWindowsAuthAcl(myAuth, execFileImpl)))
          throw error;
        await fsp.rm(myAuth, { force: true });
      }
      await moveCodexAuthFile(sidecar, myAuth);
    } else {
      await fsp.rename(sidecar, myAuth);
    }
    return { kind: 'copied' };
  } catch (error) {
    return {
      kind: (await pathEntryExists(myAuth)) ? 'swap-failed-intact' : 'lost',
      error: error as Error,
    };
  } finally {
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
  }
}

/**
 * `copyCodexAuthSnapshot` 的重试版:源在复制途中换代(本机 Codex 原子刷新)时,
 * 撕裂代次的字节一律不发布 —— 但这是罕见竞态, 不该让整次对账或登录失败,
 * 重新抓一代再拷即可自愈。连续 3 次都换代才把 `source-changed` 交回调用方。
 */
export async function copyCodexAuthSnapshotWithRetry(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
): Promise<CodexAuthSnapshotOutcome> {
  let last: CodexAuthSnapshotOutcome = { kind: 'source-changed' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await copyCodexAuthSnapshot(systemAuth, myAuth, platform, execFileImpl);
    if (last.kind !== 'source-changed') return last;
  }
  return last;
}

/**
 * 登录路径对「本地凭证是否可用」的判定结果:
 *   - accept-shared  本地凭证已经共享系统凭证(按最终身份判断),直接认账
 *   - independent-login  共享链接建不出来,进入独立登录(仅 Windows)
 *   - reject         判失败
 */
export type CodexAuthLinkAcceptance = 'accept-shared' | 'independent-login' | 'reject';

/**
 * relink 的分类只是过程里的结论,不是最终状态:它可能以 recovered(重建出共享链接)
 * 或 swap-failed-intact(并发的另一次已抢先放好)收口 —— 这两种情况下本地凭证其实
 * 已经共享系统凭证。只看 relink 的分类就判失败,会把健康状态说成「本地凭证不可用」。
 */
export function codexAuthLinkAcceptanceFor(
  relinkKind: RelinkResultKind,
  sharesIdentity: boolean,
  platform: NodeJS.Platform,
): CodexAuthLinkAcceptance {
  if (sharesIdentity) return 'accept-shared';
  if (relinkKind !== 'linked') return platform === 'win32' ? 'independent-login' : 'reject';
  return 'reject';
}

/**
 * 两个路径是否指向同一份凭证。
 *
 * 符号链接按「链接目标路径」判定:本机 Codex 原子替换系统凭证时,两次 stat
 * 可能横跨替换窗口拿到不同代次(链接侧读到旧 inode,系统侧读到新 inode),
 * 按 inode 比会把健康的共享链接误判成「不是同一份」—— 登录路径据此判失败、
 * 写下断线标记(#9316 review)。链接指向系统凭证路径这件事与文件是否被替换无关。
 *
 * 不是符号链接时按 inode 判定,并先确认系统侧代次在读取期间没有变化:系统凭证
 * 被换成另一个 inode 时,两份确实已经不是同一份了。
 */
export async function codexAuthPathsShareIdentity(left: string, right: string): Promise<boolean> {
  let linkedToRight = false;
  try {
    const link = await fsp.readlink(left);
    linkedToRight = path.resolve(path.dirname(left), link) === path.resolve(right);
  } catch {
    // 不是符号链接(或读不到):走 inode 判定。
  }
  if (linkedToRight) {
    // 悬空链接不算共享 —— 系统凭证真的不在,凭证本身不可用。
    try {
      await fsp.stat(right);
      return true;
    } catch {
      return false;
    }
  }
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await fsp.stat(right, { bigint: true });
      const leftStat = await fsp.stat(left, { bigint: true });
      const after = await fsp.stat(right, { bigint: true });
      // 系统侧代次在读取期间变了 → 本机 Codex 正在原子替换凭证,再读一轮。
      if (before.dev !== after.dev || before.ino !== after.ino) continue;
      return (
        leftStat.ino !== 0n &&
        before.ino !== 0n &&
        leftStat.dev === before.dev &&
        leftStat.ino === before.ino
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 凭证代次的时间戳(秒,µs 精度)。Date 只有 ms 精度:number stat 的 Date 会把
 * X.999999ms 四舍五入成 X+1ms,bigint stat 的 Date 则截断成 X —— 两者都会让
 * 「发布的那份带着源那一代的时间戳」偏 1ms,下一次对账的等 mtime 判定就会把它
 * 当成另一代。这里直接用 ns 换算,保留源的真实代次。
 */
function codexAuthTimestampSeconds(ns: bigint): number {
  return Number(ns / 1000n) / 1e6;
}

async function pathEntryExists(file: string): Promise<boolean> {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

export async function inspectCodexAuthLink(
  systemAuth: string,
  myAuth: string,
): Promise<CodexAuthLinkDiagnostics> {
  let system;
  try {
    system = await fsp.stat(systemAuth, { bigint: true });
  } catch {
    system = null;
  }
  const base = system
    ? {
        systemAuthMtimeMs: Number(system.mtimeMs),
        systemAuthLinkCount: Number(system.nlink),
      }
    : {};
  let local;
  try {
    local = await fsp.lstat(myAuth, { bigint: true });
  } catch {
    return { ...base, linkType: 'missing', healthy: false };
  }
  if (!system) {
    return {
      linkType: local.isSymbolicLink() ? 'dangling-symlink' : local.isFile() ? 'file' : 'unknown',
      healthy: false,
    };
  }
  let resolved;
  try {
    resolved = await fsp.stat(myAuth, { bigint: true });
  } catch {
    return { ...base, linkType: 'dangling-symlink', healthy: false };
  }
  const same =
    resolved.ino !== 0n &&
    system.ino !== 0n &&
    resolved.dev === system.dev &&
    resolved.ino === system.ino;
  const linkType = local.isSymbolicLink()
    ? 'symlink'
    : same && local.nlink > 1n
      ? 'hardlink'
      : 'file';
  return { ...base, linkType, healthy: same };
}
