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
import os from 'node:os';
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
    return { kind: recovered ? 'recovered' : 'lost', error: error as Error };
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
    const copied = await copyCodexAuthSnapshot(systemAuth, myAuth, platform, execFileImpl);
    return copied.kind === 'copied';
  }
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
 * - `expectTargetMtimeMs`: 发布前复核目标代次 —— 目标在本机 Codex 手里刚被原子
 *   刷新过时,不能用过期快照覆盖它(会丢掉新的 refresh token)。不匹配就不动目标,
 *   返回 `target-changed`(#9316 review)。
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
  opts: { expectTargetMtimeMs?: number; expectTargetAbsent?: boolean } = {},
): Promise<CodexAuthSnapshotOutcome> {
  const sidecar = `${myAuth}.${process.pid}.${sidecarCounter++}.copytmp`;
  let sourceStat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    sourceStat = await fsp.stat(systemAuth);
    await fsp.copyFile(systemAuth, sidecar);
    await fsp.chmod(sidecar, Number(sourceStat.mode & 0o777)).catch(() => undefined);
    // 复制期间源换代 → 撕裂代次的字节作废,交给调用方重新对账。
    const sourceStatAfter = await fsp.stat(systemAuth);
    if (
      sourceStatAfter.ino !== sourceStat.ino ||
      sourceStatAfter.mtimeMs !== sourceStat.mtimeMs
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
  } else if (opts.expectTargetMtimeMs !== undefined) {
    try {
      const targetStat = await fsp.stat(myAuth);
      if (targetStat.mtimeMs !== opts.expectTargetMtimeMs) {
        // 目标已经换代: 不用过期快照盖掉它。
        await fsp.rm(sidecar, { force: true }).catch(() => undefined);
        return { kind: 'target-changed' };
      }
    } catch {
      // 目标已不存在 → 继续发布(重建)。
    }
  }

  try {
    if (platform === 'win32') {
      try {
        await fsp.rm(myAuth, { force: true });
      } catch (rmError) {
        if (!isWindowsAclDenied(rmError) || !(await healWindowsAuthAcl(myAuth, execFileImpl))) {
          throw rmError;
        }
        await fsp.rm(myAuth, { force: true });
      }
    }
    // 时间戳打在 sidecar 上:随 rename 原子生效,发布后不再按路径改时间
    // (本机 Codex 在 rename 之后刷新的话,按路径改会把新凭证盖上旧代次时间戳)。
    await fsp.utimes(sidecar, sourceStat.atime, sourceStat.mtime).catch(() => undefined);
    await fsp.rename(sidecar, myAuth);
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { kind: 'copied' };
  } catch (error) {
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    if (await pathEntryExists(myAuth)) {
      return { kind: 'swap-failed-intact', error: error as Error };
    }
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
  opts: { expectTargetMtimeMs?: number; expectTargetAbsent?: boolean } = {},
): Promise<CodexAuthSnapshotOutcome> {
  let last: CodexAuthSnapshotOutcome = { kind: 'source-changed' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await copyCodexAuthSnapshot(systemAuth, myAuth, platform, execFileImpl, opts);
    if (last.kind !== 'source-changed') return last;
  }
  return last;
}

/** 系统凭证当前的硬链数(读不到时返回 undefined)。 */
export async function systemCodexAuthLinkCount(systemAuth: string): Promise<number | undefined> {
  try {
    const stat = await fsp.stat(systemAuth, { bigint: true });
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
  const outcome = await breakResidualSystemCodexHardlinksDetailed(
    systemAuth,
    platform,
    execFileImpl,
  );
  return outcome.broke;
}

/** 代次是否仍与读到内容时一致(inode / mtime / 大小都没变)。 */
async function sameCodexAuthGeneration(
  file: string,
  stat: { ino: number | bigint; mtimeMs: number | bigint; size: number | bigint },
): Promise<boolean> {
  try {
    const now = await fsp.stat(file, { bigint: true });
    return now.ino === stat.ino && now.mtimeMs === stat.mtimeMs && now.size === stat.size;
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
  /** 是否真的换到了新 inode(系统路径 nlink 回到 1)。 */
  broke: boolean;
  /** 读内容之后源换代了:这次的字节作废, 调用方应重新对账。 */
  generationChanged: boolean;
}

async function breakResidualSystemCodexHardlinksDetailed(
  systemAuth: string,
  platform: NodeJS.Platform,
  execFileImpl: typeof execFileP,
): Promise<CodexAuthHardlinkBreakOutcome> {
  let stat: Awaited<ReturnType<typeof fsp.stat>> & { nlink: bigint };
  try {
    stat = await fsp.stat(systemAuth, { bigint: true });
  } catch {
    return { broke: false, generationChanged: false };
  }
  if (stat.nlink <= 1n) return { broke: false, generationChanged: false };
  let content: Buffer;
  try {
    content = await fsp.readFile(systemAuth);
  } catch {
    return { broke: false, generationChanged: false };
  }
  const mode = Number(stat.mode & 0o777n);
  const mtime = new Date(Number(stat.mtimeMs));
  const sidecar = `${systemAuth}.${process.pid}.${sidecarCounter++}.copytmp`;
  try {
    await fsp.writeFile(sidecar, content, { mode });
    // 读到内容之后、替换之前, 本机 Codex 可能刚原子刷新过系统凭证(Cindy 与本机
    // Codex 是两个 writer)。复核代次: 变了就作废这次副本, 绝不把旧字节发布回
    // 系统路径(那会盖掉刚刷新的 refresh token), 交给调用方重新对账。
    if (!(await sameCodexAuthGeneration(systemAuth, stat))) {
      await fsp.rm(sidecar, { force: true }).catch(() => undefined);
      return { broke: false, generationChanged: true };
    }
    if (platform === 'win32') {
      try {
        await fsp.rm(systemAuth, { force: true });
      } catch (rmError) {
        if (!isWindowsAclDenied(rmError) || !(await healWindowsAuthAcl(systemAuth, execFileImpl))) {
          throw rmError;
        }
        await fsp.rm(systemAuth, { force: true });
      }
    }
    // 换 inode 不应让凭证看起来更新: 保留原修改时间, 对账仍按同一代次判断。
    // 时间戳打在 sidecar 上, 随 rename 原子生效 —— 发布后按路径 utimes 的话,
    // 本机 Codex 在 rename 之后刷新的凭证会被盖上旧代次的时间戳(#9316 review)。
    await fsp.utimes(sidecar, mtime, mtime).catch(() => undefined);
    await fsp.rename(sidecar, systemAuth);
    return { broke: true, generationChanged: false };
  } catch {
    // 换失败: 只有系统路径真的没了才把内存里的内容写回去 —— 目标若已被本机
    // Codex 原子重建, 覆盖它会截断新 token(#9316 review)。
    if (!(await pathEntryExists(systemAuth))) {
      await fsp.writeFile(systemAuth, content, { mode }).catch(() => undefined);
    }
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { broke: false, generationChanged: false };
  }
}

export type CodexAuthCopySyncKind =
  | 'copied-from-system'
  | 'copied-from-local'
  | 'unchanged'
  | 'skipped'
  | 'failed';

export interface CodexAuthCopySyncOutcome {
  kind: CodexAuthCopySyncKind;
  error?: Error;
  /** 目标在发布途中换代了(调用方应重新对账)。 */
  conflict?: boolean;
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
    expectTargetMtimeMs?: number,
  ): Promise<CodexAuthCopySyncOutcome> => {
    const copied = await copyCodexAuthSnapshot(from, to, platform, execFileImpl, { expectTargetMtimeMs });
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

  // 目标在途可能被本机 Codex 原子刷新(Cindy 与本机 Codex 是两个 writer):方向判定
  // 后、发布前再核一次目标代次, 变了就重新对账, 不用过期 mtime 决策。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      local = await fsp.lstat(myAuth);
    } catch {
      local = null;
    }
    if (local?.isSymbolicLink()) return { kind: 'skipped' };
    const systemStat = await fsp.stat(systemAuth);
    if (!local || await sameCodexAuthInode(systemAuth, myAuth)) {
      // 存量 hardlink: 复制一份到 myAuth 会拆掉本沙箱这一端的链接。系统路径上还
      // 挂着别的 profile 的硬链时 nlink 仍 > 1,Codex 照样拒绝写 —— 一并换到新 inode。
      const published = await publish(systemAuth, myAuth, 'copied-from-system', systemStat.mtimeMs);
      if (published.conflict) continue;
      const residual = await breakResidualSystemCodexHardlinksDetailed(
        systemAuth,
        platform,
        execFileImpl,
      );
      // 拆硬链时发现系统凭证刚换代: 这次不发布旧字节, 重新对账。
      if (residual.generationChanged) continue;
      return published;
    }
    // 内容一致就停:copy 不保留 mtime 时,只比 mtime 会两侧来回覆盖。
    // 但系统凭证上可能还挂着别的 profile 的旧硬链(nlink>1,Codex 拒绝写它):
    // 内容一致不代表系统路径已经干净,残留硬链要在这里一并清掉(#9316 review)。
    if (await sameCodexAuthContent(systemAuth, myAuth)) {
      const residual = await breakResidualSystemCodexHardlinksDetailed(
        systemAuth,
        platform,
        execFileImpl,
      );
      if (residual.generationChanged) continue;
      return { kind: 'unchanged' };
    }

    const localStat = await fsp.stat(myAuth);
    // 两侧 mtime 相同但内容不同(备份恢复、时间精度)不是「未变化」:必须挑一个确定
    // 的权威端,否则 reconcile 会把旧 token/旧账号当成已对齐,永不自愈。
    // 权威端由调用方授权决定:允许回写且本地不比系统旧 → 本地赢;否则系统凭证获胜。
    const localWins = opts.allowLocalToSystem === true;
    if (localWins && localStat.mtimeMs >= systemStat.mtimeMs) {
      // 写回前重新核对账号:先前读到的账号结论可能已过期(本机 Codex 换号),
      // 过期的结论会授权旧账号覆盖新登录(#9316 review)。
      const confirmed = opts.confirmLocalToSystem ? await opts.confirmLocalToSystem() : true;
      if (!confirmed) {
        // 账号不再一致 → 不写回系统,系统凭证单向获胜。
        const published = await publish(systemAuth, myAuth, 'copied-from-system', localStat.mtimeMs);
        if (published.conflict) continue;
        return published;
      }
      const published = await publish(myAuth, systemAuth, 'copied-from-local', systemStat.mtimeMs);
      if (published.conflict) continue;
      return published;
    }
    // 账号未证明一致、或系统更新:系统凭证单向获胜,只把系统内容刷到本地。
    const published = await publish(systemAuth, myAuth, 'copied-from-system', localStat.mtimeMs);
    if (published.conflict) continue;
    const residual = await breakResidualSystemCodexHardlinksDetailed(
      systemAuth,
      platform,
      execFileImpl,
    );
    // 拆硬链时发现系统凭证刚换代: 这次不发布旧字节, 重新对账。
    if (residual.generationChanged) continue;
    return published;
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
