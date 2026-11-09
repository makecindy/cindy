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
 *   2. rename 失败且 myAuth 已不在时, 尽力用 link / copy 把 myAuth 从 systemAuth 重建回来 ——
 *      只要 systemAuth 有效, 用户永远不会凭空丢失 auth.json。
 *
 * 注意: 本模块只管"安全替换"这一件事, 不做账号比对 / inode 短路 / suppress 标记等判定 ——
 * 那些仍由 auth-adapters 的 reconcile 主流程负责。
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

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
 *   - link-unsupported    连 sidecar 共享链接都建不出 → myAuth 一字未动
 *   - swap-failed-intact  替换失败但 myAuth 仍在 (多半是并发的另一次 reconcile 已抢先放好)
 *   - recovered           替换中途 myAuth 一度丢失, 已从 systemAuth 重建共享链接
 *   - lost                替换失败且无法重建 (systemAuth 也读不了) → 需要用户重新登录
 */
export type RelinkResultKind =
  'linked' | 'link-unsupported' | 'swap-failed-intact' | 'recovered' | 'lost';

export interface RelinkOutcome {
  kind: RelinkResultKind;
  linkType?: 'symlink' | 'hardlink';
  /** 失败路径上的底层错误, 供调用方打日志; linked 时为 undefined。 */
  error?: Error;
}

export type CodexAuthSnapshotKind =
  | 'copied'
  | 'copy-unsupported'
  | 'swap-failed-intact'
  | 'swap-pending'
  | 'target-changed'
  | 'source-changed'
  | 'lost';

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
  // hardlink(那会把 Codex 登录再次卡死),交给 syncIndependentCodexAuth 做独立副本。
  try {
    await fsp.stat(systemAuth);
    await fsp.symlink(systemAuth, sidecar, 'file');
  } catch (error) {
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
    await fsp.rename(sidecar, myAuth);
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
  } catch {
    return false;
  }
  try {
    await fsp.symlink(systemAuth, myAuth, 'file');
    return true;
  } catch {
    // POSIX 失败不复制:可写副本会变成 refresh-token 孤岛。Windows 不能再退回
    // hardlink(nlink>1 会让 Codex 0.165+ 拒绝写入),只能留一份独立副本(#9277)。
    if (platform !== 'win32') return false;
    // 重建的前提是目标此刻仍然不存在。若本机 Codex 在这段空窗里把目标重建出来
    // (新一代凭证),覆盖它就等于丢掉刚刷新的 refresh token —— 按「目标仍在」
    // 交回调用方,不覆盖(#9316 review)。
    const copied = await copyCodexAuthSnapshot(systemAuth, myAuth, platform, execFileImpl, {
      expectTargetAbsent: true,
    });
    return copied.kind === 'copied';
  }
}

/**
 * 一份凭证文件的完整代次(dev/ino/mtimeNs/size)。比对必须用 bigint:NTFS 的 file id
 * 可能超出安全整数范围,四舍五入后两个不同的 inode 会比较成相等(#9316 review)。
 */
export interface CodexAuthFileGeneration {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

/** 从 bigint stat 取完整代次。 */
export function codexAuthFileGenerationOf(stat: BigIntStats): CodexAuthFileGeneration {
  return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size };
}

function sameCodexAuthFileGeneration(
  stat: BigIntStats,
  generation: CodexAuthFileGeneration,
): boolean {
  return (
    stat.dev === generation.dev &&
    stat.ino === generation.ino &&
    stat.mtimeNs === generation.mtimeNs &&
    stat.size === generation.size
  );
}

/**
 * Publish a read-only Dev snapshot without sharing the source inode.
 *
 * A symlink/hardlink is intentionally not used here: the Codex child may
 * refresh auth.json in place, and a shared inode would let that write mutate
 * the Release/native credential. The source is copied to a sibling staging
 * file and then atomically published as the local auth.json.
 *
 * 发布时用的是**复制那一刻**的源代次:
 * - `expectTargetGeneration`: 发布前复核目标代次 —— 目标在本机 Codex 手里刚被原子
 *   刷新过时,不能用过期快照覆盖它(会丢掉新的 refresh token)。比对的是**完整代次**
 *   (dev/ino/mtimeNs/size,与源代次同一份口径):这套协议故意给 sidecar 盖源 mtime,
 *   等 mtime 但内容不同的两代是常态(同账号轮换 token),只比 mtimeMs 会把「换了
 *   inode 的新一代」当成「还是那一代」而覆盖它(#9316 review)。不匹配就不动目标,
 *   返回 `target-changed`。
 * - `expectTargetAbsent`: 只在目标**仍然不存在**时发布(丢文件后的重建路径)。
 *   目标被本机 Codex 重新建出来时返回 `target-changed`,不覆盖它(#9316 review)。
 * - 复制期间源换代(本机 Codex 在 copyFile 前后刷新)→ 返回 `source-changed`,
 *   撕裂代次的字节绝不发布(#9316 review)。
 * - 发布的文件带的是**复制时捕获**的源 mtime,且时间戳打在 sidecar 上、随 rename
 *   一起原子生效:若改成发布后再按路径 utimes,本机 Codex 在 rename 之后刷新的
 *   新凭证会被盖上旧代次的时间戳,下一次对账就会让旧副本反向覆盖它
 *   (#9316 review)。
 */
export async function copyCodexAuthSnapshot(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
  opts: {
    expectTargetGeneration?: CodexAuthFileGeneration;
    expectTargetAbsent?: boolean;
    /**
     * 目标是**系统凭证**(`~/.codex/auth.json`)时:发布前先把旧目标挪到可恢复的
     * 备份名, 发布成功后再删备份。Windows 上「删目标 → rename 发布」两步之间有一个
     * 「目标不存在」的窗口, 进程在这个窗口里崩掉, 系统凭证就彻底没了 —— 下次启动
     * 看到系统路径缺失就直接返回, 用户看到的是 Codex 凭空掉登录(#9316 review)。
     * 备份与 sidecar 共用同一个 token:崩在窗口里时两者都在, 启动对账认这对。
     */
    backupTarget?: boolean;
  } = {},
): Promise<CodexAuthSnapshotOutcome> {
  const token = `${process.pid}.${sidecarCounter++}`;
  const sidecar = `${myAuth}.${token}.copytmp`;
  let sourceStat: BigIntStats;
  try {
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

  if (opts.expectTargetAbsent === true) {
    // 重建路径:目标若已被本机 Codex 重新建出来,就不是「丢了」,不能覆盖它。
    if (await pathEntryExists(myAuth)) {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      return { kind: 'target-changed' };
    }
  } else if (opts.expectTargetGeneration !== undefined) {
    try {
      const targetStat = await fsp.stat(myAuth, { bigint: true });
      if (!sameCodexAuthFileGeneration(targetStat, opts.expectTargetGeneration)) {
        // 目标已经换代: 不用过期快照盖掉它。等 mtime 不算同一代 —— 这套协议故意给
        // sidecar 盖源 mtime,同账号轮换 token 的两代 mtime 相同是常态(#9316 review)。
        await fsp.rm(sidecar, { force: true }).catch(() => undefined);
        return { kind: 'target-changed' };
      }
    } catch {
      // 目标在复制途中消失: 本机 Codex 刚刚把它删了(登出)。拿旧快照把它重建回来
      // 等于撤销那次登出 —— 按冲突处理, 不重建。「目标本来就不存在、就是要重建」
      // 走 expectTargetAbsent 那条路(#9316 review)。
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      return { kind: 'target-changed' };
    }
  }

  // 备份与 sidecar 共用同一个 token:启动对账只认配对文件，恢复实际取得的备份。
  // 发布或恢复完成后清掉配对；缺少 sidecar 的孤儿备份不再代表未完成的替换。
  let backupPath: string | null = null;
  try {
    // 时间戳在发布前打在 sidecar 上，发布后不再按目标路径改时间，
    // 避免给本机 Codex 刚刷新的凭证盖上旧代次时间戳。
    await fsp
      .utimes(
        sidecar,
        codexAuthTimestampSeconds(sourceStat.atimeNs),
        codexAuthTimestampSeconds(sourceStat.mtimeNs),
      )
      .catch(() => undefined);
    if (platform === 'win32') {
      if (opts.backupTarget === true) {
        // 目标是系统凭证: 先把旧目标挪到可恢复的备份名, 发布成功后再删备份。
        // 崩在「挪走之后、发布之前」时备份还在, 下次启动对账按它恢复 —— 否则
        // ~/.codex/auth.json 就此消失, 本机 Codex 凭空掉登录(#9316 review)。
        const backup = `${myAuth}.${token}.swapbak`;
        try {
          await fsp.rename(myAuth, backup);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
            await fsp.rm(sidecar, { force: true }).catch(() => undefined);
            return { kind: 'target-changed' };
          }
          if (
            !isWindowsAclDenied(renameError) ||
            !(await healWindowsAuthAcl(myAuth, execFileImpl))
          ) {
            throw renameError;
          }
          await fsp.rename(myAuth, backup);
        }
        backupPath = backup;
        if (
          opts.expectTargetGeneration &&
          !(await sameCodexAuthGeneration(backup, opts.expectTargetGeneration))
        ) {
          // 校验实际取得的文件，而不只是 rename 之前的路径快照。
          // 恢复使用独占 link，不能覆盖在缺口里新建的登录凭证。
          if (await restoreCodexAuthBackup(backup, myAuth)) {
            await fsp.rm(sidecar, { force: true }).catch(() => undefined);
          }
          return { kind: 'target-changed' };
        }
      } else {
        try {
          await fsp.rm(myAuth, { force: true });
        } catch (rmError) {
          if (!isWindowsAclDenied(rmError) || !(await healWindowsAuthAcl(myAuth, execFileImpl))) {
            throw rmError;
          }
          await fsp.rm(myAuth, { force: true });
        }
      }
    }
    if (backupPath) {
      // 备份挪走后本机 Codex 仍可能重新登录。独占发布不覆盖这个新目标。
      await fsp.link(sidecar, myAuth);
      await fsp.rm(backupPath, { force: true });
    } else {
      await fsp.rename(sidecar, myAuth);
    }
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { kind: 'copied' };
  } catch (error) {
    if (backupPath) {
      // 不递归生成另一份副本。恢复失败时原配对仍在，下次启动可恢复。
      const restored = await restoreCodexAuthBackup(backupPath, myAuth);
      if (restored) await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    } else {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    }
    if (await pathEntryExists(myAuth)) {
      return { kind: 'swap-failed-intact', error: error as Error };
    }
    // 已保留备份配对时，不让同步器的 lost 兜底重新复制旧源。
    if (backupPath) return { kind: 'swap-pending', error: error as Error };
    return { kind: 'lost', error: error as Error };
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
  opts: { expectTargetGeneration?: CodexAuthFileGeneration; expectTargetAbsent?: boolean } = {},
): Promise<CodexAuthSnapshotOutcome> {
  let last: CodexAuthSnapshotOutcome = { kind: 'source-changed' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await copyCodexAuthSnapshot(systemAuth, myAuth, platform, execFileImpl, opts);
    if (last.kind !== 'source-changed') return last;
  }
  return last;
}

/**
 * 登录路径对「本地凭证是否可用」的判定结果:
 *   - accept-shared  本地凭证已经共享系统凭证(按最终身份判断),直接认账
 *   - fallback-copy  共享链接建不出来,退回独立副本路径(仅 Windows)
 *   - reject         判失败
 */
export type CodexAuthLinkAcceptance = 'accept-shared' | 'fallback-copy' | 'reject';

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
  if (relinkKind !== 'linked') return platform === 'win32' ? 'fallback-copy' : 'reject';
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

/** 系统凭证当前的硬链数(读不到时返回 undefined)。 */
export async function codexAuthLinkCount(file: string): Promise<number | undefined> {
  try {
    const stat = await fsp.stat(file, { bigint: true });
    return Number(stat.nlink);
  } catch {
    return undefined;
  }
}

/**
 * 系统凭证上还挂着别的硬链时(同机另一个升级前的 profile 也建过硬链),系统路径的
 * nlink 仍 > 1,Codex 0.165+ 照样拒绝写它 —— 拆掉当前这一份并不够。
 * 把系统凭证复制到新 inode 再原子替换系统路径: 系统路径的 nlink 回到 1,
 * 其余 profile 的旧链接落在旧 inode 上(内容相同, 但不再共享)。
 * 内容先读进内存, 换 inode 失败也能原样写回, 绝不让凭证消失。
 */
export async function breakResidualSystemCodexHardlinks(
  systemAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
): Promise<boolean> {
  const outcome = await breakResidualCodexHardlinksDetailed(systemAuth, platform, execFileImpl);
  return outcome.broke;
}

/** 恢复实际取得的目标；目标被另一写者重建时保留它，不做覆盖式 rename。 */
async function restoreCodexAuthBackup(backup: string, target: string): Promise<boolean> {
  try {
    await fsp.link(backup, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  await fsp.rm(backup, { force: true }).catch(() => undefined);
  return true;
}

/** 代次是否仍与读到内容时一致(dev / inode / mtime / 大小都没变)。 */
async function sameCodexAuthGeneration(
  file: string,
  stat: CodexAuthFileGeneration,
): Promise<boolean> {
  try {
    const now = await fsp.stat(file, { bigint: true });
    // 身份比较必须用 bigint:NTFS 的 file id 可能超出安全整数范围,四舍五入后
    // 两个不同的 inode 会比较成相等 —— 撕裂代次的字节会被当成稳定代次。
    // mtime 用 ns 精确值:ms 精度的比较漏掉「同一毫秒内被重写」的换代。
    return (
      now.dev === stat.dev &&
      now.ino === stat.ino &&
      now.mtimeNs === stat.mtimeNs &&
      now.size === stat.size
    );
  } catch {
    // 文件没了 → 代次已经变了。
    return false;
  }
}

/**
 * `breakResidualSystemCodexHardlinks` 的详细结果:区分「本来就没有残余硬链」
 * 与「读到内容后代次变了, 得重新对账」——后者必须让调用方重试, 不能当成成功。
 */
export interface CodexAuthHardlinkBreakOutcome {
  /** 是否真的换到了新 inode(该路径 nlink 回到 1)。 */
  broke: boolean;
  /** 读内容之后源换代了:这次的字节作废, 调用方应重新对账。 */
  generationChanged: boolean;
}

/**
 * 把某个凭证路径上残留的硬链换到新 inode。系统路径和本地副本都要用:
 * Codex 0.165+ 拒绝写 nlink>1 的文件 —— 只拆系统那份, 本地这份照样写不进去。
 */
async function breakResidualCodexHardlinksDetailed(
  file: string,
  platform: NodeJS.Platform,
  execFileImpl: typeof execFileP,
): Promise<CodexAuthHardlinkBreakOutcome> {
  let stat: BigIntStats;
  try {
    stat = await fsp.stat(file, { bigint: true });
  } catch {
    return { broke: false, generationChanged: false };
  }
  if (stat.nlink <= 1n) return { broke: false, generationChanged: false };
  let content: Buffer;
  try {
    content = await fsp.readFile(file);
  } catch {
    return { broke: false, generationChanged: false };
  }
  const mode = Number(stat.mode & 0o777n);
  const mtime = codexAuthTimestampSeconds(stat.mtimeNs);
  // sidecar 与备份共用同一个 token:恢复时只有「备份 + 同一次调用留下的 sidecar」
  // 同时在才算崩在发布之前 —— 发布成功后 sidecar 已经被 rename 成目标,备份即使
  // 没删掉也不再可恢复(#9316 review)。
  const token = `${process.pid}.${sidecarCounter++}`;
  const sidecar = `${file}.${token}.copytmp`;
  // 旧目标在替换发布之前不能被销毁。Windows 上原来走「删掉目标 → rename 发布」两步:
  // 两步之间有一个「目标不存在」的窗口, 进程在这个窗口里崩掉, 系统凭证就彻底没了 ——
  // 下次启动看到系统路径缺失就直接返回, 既不回灌本机副本也不看 sidecar, 用户看到的是
  // Codex 凭空掉登录(#9316 review)。改成先把旧目标挪到可恢复的备份名, 新凭证发布成功
  // 之后再删备份; 崩在窗口里时备份还在, 启动对账按它恢复。
  const backup = `${file}.${token}.swapbak`;
  let backupPath: string | null = null;
  try {
    await fsp.writeFile(sidecar, content, { mode });
    // 读到内容之后、替换之前, 本机 Codex 可能刚原子刷新过凭证(Cindy 与本机
    // Codex 是两个 writer)。复核代次: 变了就作废这次副本, 绝不把旧字节发布回
    // 系统路径(那会盖掉刚刷新的 refresh token), 交给调用方重新对账。
    if (!(await sameCodexAuthGeneration(file, stat))) {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      return { broke: false, generationChanged: true };
    }
    // 时间戳打在 sidecar 上, 随 rename 原子生效 —— 发布后按路径 utimes 的话,
    // 本机 Codex 在 rename 之后刷新的凭证会被盖上旧代次的时间戳(#9316 review)。
    // 必须在**挪走旧目标之前**打好: 崩在窗口里时 sidecar 会被启动对账按它恢复,
    // 那时它必须已经带着原来的代次时间戳。
    await fsp.utimes(sidecar, mtime, mtime).catch(() => undefined);
    if (platform === 'win32') {
      try {
        await fsp.rename(file, backup);
        backupPath = backup;
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
          await fsp.rm(sidecar, { force: true }).catch(() => undefined);
          return { broke: false, generationChanged: true };
        }
        if (!isWindowsAclDenied(renameError) || !(await healWindowsAuthAcl(file, execFileImpl))) {
          throw renameError;
        }
        await fsp.rename(file, backup);
        backupPath = backup;
      }
      if (!(await sameCodexAuthGeneration(backup, stat))) {
        if (await restoreCodexAuthBackup(backup, file)) {
          await fsp.rm(sidecar, { force: true }).catch(() => undefined);
        }
        return { broke: false, generationChanged: true };
      }
    }
    // 换 inode 不应让凭证看起来更新: 保留原修改时间, 对账仍按同一代次判断。
    if (backupPath) {
      await fsp.link(sidecar, file);
      await fsp.rm(backupPath, { force: true });
      await fsp.rm(sidecar, { force: true });
    } else {
      await fsp.rename(sidecar, file);
    }
    return { broke: true, generationChanged: false };
  } catch {
    if (backupPath) {
      if (await restoreCodexAuthBackup(backupPath, file)) {
        await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      }
    } else {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    }
    return { broke: false, generationChanged: false };
  }
}

/**
 * 上一次替换崩在「旧目标已挪走、新凭证还没发布」的窗口里时, 目标路径会缺失, 而备份
 * (`<basename>.<pid>.<n>.swapbak`)与同一次调用的 sidecar 还在。启动对账时按备份把凭证
 * 放回原位 —— 否则这里直接返回, 用户看到的是 Codex 凭空掉登录。
 *
 * 两条边界(都是 #9316 review):
 *   · 只认**配对**的备份(同 token 的 `.copytmp` 还在 = 崩在发布之前)。发布成功后
 *     sidecar 已经被 rename 成目标, 备份即使删除失败也只是孤儿 —— 恢复它, 会在本机
 *     Codex 之后登出时把旧账号凭证倒回来, 等于撤销登出。
 *   · 目标可能在我们检查之后被本机 Codex 重建出来:用 link 做原子占位, 目标已存在时
 *     报 EEXIST 直接放弃, 绝不拿备份盖掉刚轮换的 refresh token。
 */
export async function recoverInterruptedCodexAuthSwap(file: string): Promise<boolean> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = `${base}.`;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return false;
  }
  const backups = names.filter((name) => name.startsWith(prefix) && name.endsWith('.swapbak'));
  const sidecars = new Set(
    names.filter((name) => name.startsWith(prefix) && name.endsWith('.copytmp')),
  );
  const paired = backups.filter((name) =>
    sidecars.has(`${prefix}${name.slice(prefix.length, -'.swapbak'.length)}.copytmp`),
  );

  if (paired.length > 0 && !(await pathEntryExists(file))) {
    const stamped = await Promise.all(
      paired.map(async (name) => ({
        name,
        mtimeMs: await fsp
          .stat(path.join(dir, name))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const chosenName = stamped[0].name;
    const chosen = path.join(dir, chosenName);
    const token = chosenName.slice(prefix.length, -'.swapbak'.length);
    const sidecar = path.join(dir, `${prefix}${token}.copytmp`);
    // 恢复实际取得的目标，而不是发布前准备的旧 sidecar：rename 取得目标后、
    // 代次复核前也可能中断。复制备份到独立 inode，既保住那一代，也不恢复旧硬链。
    const recovery = `${file}.${process.pid}.${sidecarCounter++}.recoverytmp`;
    const copied = await copyCodexAuthSnapshot(chosen, recovery);
    if (copied.kind !== 'copied') return false;
    let published = false;
    let conflict = false;
    try {
      await fsp.link(recovery, file);
      published = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        conflict = true;
      }
    } finally {
      await fsp.rm(recovery, { force: true }).catch(() => undefined);
    }
    if (published) {
      // recovery 临时名字已去掉，目标是独立 inode；清掉原备份与配对标记。
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      await fsp.rm(chosen, { force: true }).catch(() => undefined);
      await retireSwaps(dir, prefix, backups, chosenName);
      return true;
    }
    if (!conflict) {
      // 发布因为瞬时原因失败(ACL / 占用):备份与 sidecar 都留着, 下次对账再试。
      return false;
    }
    // 本机 Codex 在缺口里重建了凭证:备份是旧代次, 作废。
  }

  // 走到这里:目标在(不需要恢复), 或没有可恢复的配对。发布完成后的孤儿备份必须清掉 ——
  // 留着它, 本机 Codex 之后登出时会被当成交断替换把旧账号凭证倒回来(#9316 review)。
  await retireSwaps(dir, prefix, backups);
  return false;
}

/** 清掉同名前缀下的残留备份(以及它们配对的 sidecar), 不动别的文件。 */
async function retireSwaps(
  dir: string,
  prefix: string,
  backups: readonly string[],
  keep?: string,
): Promise<void> {
  for (const name of backups) {
    if (name === keep) continue;
    const token = name.slice(prefix.length, -'.swapbak'.length);
    await fsp
      .rm(path.join(dir, `${prefix}${token}.copytmp`), { force: true })
      .catch(() => undefined);
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * 路径瞬时消失时的重试间隔。同机另一个 Cindy profile(或本机 Codex)原子替换凭证时
 * 会经历 rm → rename 的空窗, 窗口很短但不是零:立刻重试大概率还在空窗里。
 */
const TRANSIENT_PATH_RETRY_DELAY_MS = 50;

async function waitBeforePathRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_PATH_RETRY_DELAY_MS));
}

export type CodexAuthCopySyncKind =
  'copied-from-system' | 'copied-from-local' | 'unchanged' | 'skipped' | 'failed';

export interface CodexAuthCopySyncOutcome {
  kind: CodexAuthCopySyncKind;
  error?: Error;
  /** 目标在发布途中换代了(调用方应重新对账)。 */
  conflict?: boolean;
  /**
   * 系统凭证上还残留的硬链数(>1 → Codex 0.165+ 拒绝写它)。
   * 拆不掉时不能当成功:凭证在但写不进去,调用方要留警告并等下一次对账。
   */
  residualSystemHardlinks?: number;
  /** 本地副本上还残留的硬链数(>1 → Codex 0.165+ 拒绝写它)。 */
  residualLocalHardlinks?: number;
}

/** 只在确实有残余时带上字段,避免 undefined 混进结果对象。 */
function residualFields(residual: { system?: number; local?: number }): {
  residualSystemHardlinks?: number;
  residualLocalHardlinks?: number;
} {
  return {
    ...(residual.system !== undefined ? { residualSystemHardlinks: residual.system } : {}),
    ...(residual.local !== undefined ? { residualLocalHardlinks: residual.local } : {}),
  };
}

/**
 * 两个路径是否确证指向同一个 inode;ino 不可用时返回 undefined(无法确证)。
 */
async function codexAuthIdentityRelation(
  a: string,
  b: string,
): Promise<'same' | 'different' | 'unknown'> {
  try {
    const left = await fsp.stat(a, { bigint: true });
    const right = await fsp.stat(b, { bigint: true });
    if (left.ino === 0n || right.ino === 0n) return 'unknown';
    return left.dev === right.dev && left.ino === right.ino ? 'same' : 'different';
  } catch {
    return 'unknown';
  }
}

async function sameCodexAuthInode(a: string, b: string): Promise<boolean> {
  try {
    const left = await fsp.stat(a, { bigint: true });
    const right = await fsp.stat(b, { bigint: true });
    return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

async function sameCodexAuthContent(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

/**
 * Windows 建不出文件 symlink 时的降级(#9277):两侧各持独立副本,按较新 mtime 对齐;
 * mtime 相同但内容不同时按 `allowLocalToSystem` 挑确定权威端(不是「未变化」)。
 * 存量 hardlink(nlink>1)会被拆开,系统 auth.json 恢复为单一链接,Codex 才能原子写入。
 * 不创建 hardlink。已是 symlink 的路径跳过,避免把活链接拍成副本。
 *
 * `allowLocalToSystem` 默认 false:本地副本绝不写回 `~/.codex/auth.json`。只有调用方
 * 已证明两侧是同一账号时才允许,避免旧账号覆盖系统登录。
 * `confirmLocalToSystem`:写回前再核对一次两侧账号(调用方按当前文件内容重新读)。
 * 先前读到的账号结论可能已经过期 —— 本机 Codex 若在这期间把系统凭证换成另一个
 * 账号,过期的结论会授权旧账号覆盖新登录(#9316 review)。
 * 两端各自刷新时较旧的 refresh token 可能已失效。
 */
export async function syncIndependentCodexAuth(
  systemAuth: string,
  myAuth: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFileP = execFileP,
  opts: {
    allowLocalToSystem?: boolean;
    confirmLocalToSystem?: () => Promise<boolean>;
  } = {},
): Promise<CodexAuthCopySyncOutcome> {
  let local: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
  try {
    local = await fsp.lstat(myAuth);
  } catch {
    local = null;
  }
  if (local?.isSymbolicLink()) return { kind: 'skipped' };
  try {
    await fsp.stat(systemAuth);
  } catch (error) {
    return { kind: 'failed', error: error as Error };
  }

  const publish = async (
    from: string,
    to: string,
    successKind: CodexAuthCopySyncKind,
    target: {
      expectTargetGeneration?: CodexAuthFileGeneration;
      expectTargetAbsent?: boolean;
      backupTarget?: boolean;
    } = {},
  ): Promise<CodexAuthCopySyncOutcome> => {
    const copied = await copyCodexAuthSnapshot(from, to, platform, execFileImpl, target);
    if (copied.kind === 'copied') {
      // mtime 由 copyCodexAuthSnapshot 用「复制那一刻捕获的源代次」盖好:
      // 发布后再读源路径拿到的可能是新代次的 mtime, 旧字节会被贴上新时间戳,
      // 下一次对账的等 mtime 判定就会让旧副本反向覆盖新 refresh token(#9316 review)。
      return { kind: successKind };
    }
    if (copied.kind === 'target-changed') {
      // 目标在本机 Codex 手里刚换代: 不用过期快照盖掉它, 交给调用方重新对账。
      return {
        kind: 'failed',
        error: new Error('Codex auth target changed during sync'),
        conflict: true,
      };
    }
    if (copied.kind === 'source-changed') {
      // 复制途中源换代: 撕裂代次的字节一律不发布, 重新对账。
      return {
        kind: 'failed',
        error: new Error('Codex auth source changed during sync'),
        conflict: true,
      };
    }
    if (copied.kind === 'lost') {
      // Windows 先删目标再 rename:删除成功后 rename 失败会把 to 弄丢。
      // 源还在,立刻重建,绝不能让 ~/.codex/auth.json 空窗留存。
      // 重建只在目标仍然不存在时进行:目标若已被本机 Codex 重新建出来,
      // 那是新的一代, 不能用旧字节覆盖它(#9316 review)。
      const restore = await copyCodexAuthSnapshot(from, to, platform, execFileImpl, {
        expectTargetAbsent: true,
      });
      if (restore.kind === 'copied') {
        return { kind: successKind };
      }
      if (restore.kind === 'source-changed' || restore.kind === 'target-changed') {
        return {
          kind: 'failed',
          error:
            restore.kind === 'source-changed'
              ? new Error('Codex auth source changed during sync')
              : new Error('Codex auth target changed during sync'),
          conflict: true,
        };
      }
      return { kind: 'failed', error: copied.error };
    }
    return { kind: 'failed', error: copied.error };
  };

  // 拆完硬链后再数一次链接数:「本来就没有残余硬链」和「拆失败」在
  // breakResidual 的返回值里长得一样(都没 broke),只有 nlink 能区分。
  const residualHardlinks = async (file: string): Promise<number | undefined> => {
    const nlink = await codexAuthLinkCount(file);
    return nlink !== undefined && nlink > 1 ? nlink : undefined;
  };

  /**
   * 把某个凭证路径上残留的硬链换到新 inode,并回报是否还有残余。
   */
  const detachHardlinks = async (
    file: string,
  ): Promise<{ generationChanged: boolean; residual?: number }> => {
    const outcome = await breakResidualCodexHardlinksDetailed(file, platform, execFileImpl);
    if (outcome.generationChanged) return { generationChanged: true };
    return { generationChanged: false, residual: await residualHardlinks(file) };
  };

  /**
   * 拆本地这份上残留的硬链:同机另一个升级前的 profile 可能和它共用同一个 inode。
   * Codex 0.165+ 拒绝写 nlink>1 的文件 —— 只拆系统那份, 本地这份照样写不进去。
   * 只有能确证两侧不是同一个 inode 时才动本地这份:ino 读不出来(某些网络/容器
   * 文件系统)时,贸然换 inode 会把「共享」拆成两份互相看不见的独立副本。
   */
  const detachLocalHardlinks = async (): Promise<{
    generationChanged: boolean;
    residual?: number;
  }> => {
    const relation = await codexAuthIdentityRelation(systemAuth, myAuth);
    if (relation !== 'different') {
      return { generationChanged: false, residual: await residualHardlinks(myAuth) };
    }
    return detachHardlinks(myAuth);
  };

  // 目标在途可能被本机 Codex 原子刷新(Cindy 与本机 Codex 是两个 writer):方向判定
  // 后、发布前再核一次目标代次, 变了就重新对账, 不用过期 mtime 决策。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      local = await fsp.lstat(myAuth);
    } catch {
      local = null;
    }
    if (local?.isSymbolicLink()) return { kind: 'skipped' };
    // 路径可能在同机另一个 Cindy profile 的 rm → rename 空窗里瞬时消失:这一代
    // stat 读不到就是「再对一次账」,不是终态失败。抛出去会让 getState() 整个
    // 拒绝, 登录路径还会写下断线标记 —— 文件其实可能已经回来了(#9316 review)。
    let systemStat: BigIntStats;
    try {
      // 代次比对用 bigint stat:发布前复核的是完整代次(dev/ino/mtimeNs/size),
      // 只比 mtimeMs 会把「等 mtime 但换了 inode 的新一代」当成同一代(#9316 review)。
      systemStat = await fsp.stat(systemAuth, { bigint: true });
    } catch {
      await waitBeforePathRetry();
      continue;
    }
    if (!local || (await sameCodexAuthInode(systemAuth, myAuth))) {
      // 存量 hardlink: 复制一份到 myAuth 会拆掉本沙箱这一端的链接。系统路径上还
      // 挂着别的 profile 的硬链时 nlink 仍 > 1,Codex 照样拒绝写 —— 一并换到新 inode。
      //
      // 本地副本整个不在时: 重建的前提是「目标仍然不存在」(本机 Codex 刚建出来的
      // 那份是新的一代, 不能覆盖) —— 走 expectTargetAbsent, 不走代次比对。
      // 共享 inode 时系统那份的代次就是本地这份的代次。
      const published = await publish(
        systemAuth,
        myAuth,
        'copied-from-system',
        local
          ? { expectTargetGeneration: codexAuthFileGenerationOf(systemStat) }
          : { expectTargetAbsent: true },
      );
      if (published.conflict) continue;
      const residual = await detachHardlinks(systemAuth);
      // 拆硬链时发现系统凭证刚换代: 这次不发布旧字节, 重新对账。
      if (residual.generationChanged) continue;
      const localResidual = await detachLocalHardlinks();
      if (localResidual.generationChanged) continue;
      return {
        ...published,
        ...residualFields({ system: residual.residual, local: localResidual.residual }),
      };
    }
    // 内容一致就停:copy 不保留 mtime 时,只比 mtime 会两侧来回覆盖。
    // 但系统凭证上可能还挂着别的 profile 的旧硬链(nlink>1,Codex 拒绝写它):
    // 内容一致不代表系统路径已经干净,残留硬链要在这里一并清掉(#9316 review)。
    // 本地这份同样可能和别的 profile 的旧副本共用 inode:内容一致也不代表
    // 本地路径干净 —— 残留硬链会让 Codex 0.165+ 拒绝写本地凭证(#9316 review)。
    if (await sameCodexAuthContent(systemAuth, myAuth)) {
      const residual = await detachHardlinks(systemAuth);
      if (residual.generationChanged) continue;
      const localResidual = await detachLocalHardlinks();
      if (localResidual.generationChanged) continue;
      return {
        kind: 'unchanged',
        ...residualFields({ system: residual.residual, local: localResidual.residual }),
      };
    }

    // 本地凭证同样可能在对账途中被本机 Codex 换掉(原子替换的 rm → rename 空窗):
    // 读不到就重新对账, 不要让整个同步失败(#9316 review)。
    let localStat: BigIntStats;
    try {
      localStat = await fsp.stat(myAuth, { bigint: true });
    } catch {
      await waitBeforePathRetry();
      continue;
    }
    // 两侧 mtime 相同但内容不同(备份恢复、时间精度)不是「未变化」:必须挑一个确定
    // 的权威端,否则 reconcile 会把旧 token/旧账号当成已对齐,永不自愈。
    // 权威端由调用方授权决定:允许回写且本地不比系统旧 → 本地赢;否则系统凭证获胜。
    const localWins = opts.allowLocalToSystem === true;
    if (localWins && localStat.mtimeNs >= systemStat.mtimeNs) {
      // 写回前重新核对账号:先前读到的账号结论可能已过期(本机 Codex 换号),
      // 过期的结论会授权旧账号覆盖新登录(#9316 review)。
      const confirmed = opts.confirmLocalToSystem ? await opts.confirmLocalToSystem() : true;
      if (!confirmed) {
        // 账号不再一致 → 不写回系统,系统凭证单向获胜。
        const published = await publish(systemAuth, myAuth, 'copied-from-system', {
          expectTargetGeneration: codexAuthFileGenerationOf(localStat),
        });
        if (published.conflict) continue;
        const residual = await detachHardlinks(systemAuth);
        if (residual.generationChanged) continue;
        const localResidual = await detachLocalHardlinks();
        if (localResidual.generationChanged) continue;
        return {
          ...published,
          ...residualFields({ system: residual.residual, local: localResidual.residual }),
        };
      }
      // 目标是**系统凭证**: 用带备份的发布 —— Windows 上「删目标 → rename 发布」
      // 之间有一个「目标不存在」的窗口, 进程在这个窗口里崩掉, ~/.codex/auth.json 就此
      // 消失, 本机 Codex 凭空掉登录(本地那份还在, 用户却已经登出)。备份让崩溃窗口
      // 里的凭证可恢复(#9316 review)。
      const published = await publish(myAuth, systemAuth, 'copied-from-local', {
        expectTargetGeneration: codexAuthFileGenerationOf(systemStat),
        backupTarget: true,
      });
      if (published.conflict) continue;
      // 系统路径刚换到新 inode(nlink 回到 1);本地这份还可能和别的 profile
      // 的旧副本共用 inode —— 一并拆掉,否则 Codex 仍写不进本地凭证。
      const localResidual = await detachLocalHardlinks();
      if (localResidual.generationChanged) continue;
      return {
        ...published,
        ...residualFields({ local: localResidual.residual }),
      };
    }
    // 账号未证明一致、或系统更新:系统凭证单向获胜,只把系统内容刷到本地。
    const published = await publish(systemAuth, myAuth, 'copied-from-system', {
      expectTargetGeneration: codexAuthFileGenerationOf(localStat),
    });
    if (published.conflict) continue;
    const residual = await detachHardlinks(systemAuth);
    // 拆硬链时发现系统凭证刚换代: 这次不发布旧字节, 重新对账。
    if (residual.generationChanged) continue;
    const localResidual = await detachLocalHardlinks();
    if (localResidual.generationChanged) continue;
    return {
      ...published,
      ...residualFields({ system: residual.residual, local: localResidual.residual }),
    };
  }
  return {
    kind: 'failed',
    error: new Error('Codex auth kept changing during sync'),
    conflict: true,
  };
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
