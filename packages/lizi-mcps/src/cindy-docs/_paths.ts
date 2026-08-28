/**
 * cindy-docs/_paths.ts —— 文档工具的路径边界与输出落盘前置。
 *
 * 归属判据与 cindy_slack 的 out_file 泄洪同款:**当前 tool-call 的 session ctx
 * 才是权威**(resolveLiziMcpSessionContext:Claude 走闭包、Codex/Pi 走
 * AsyncLocalStorage;解析不出归属时它会把 workingDir 抹成空串)。所有
 * 模型给的路径先经 resolvePathInsideRoot 做「.. 穿越 + symlink 逃逸 + 绝对路径
 * 越界」三重钳制,再决定能不能写。
 *
 * 为什么写类工具默认不覆盖:文档产出常常是用户手里唯一的一份(改了三轮的报告),
 * 模型重跑一次就静默盖掉是不可接受的。覆盖必须由模型显式 overwrite:true 表态。
 */

import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

import { resolveLiziMcpSessionContext } from '../session-context.js';
import { PathBoundaryError, resolvePathInsideRoot } from '../shared/assertInsidePath.js';
import type { DocsMcpSessionCtx } from './types.js';

/** 工具层可识别的路径类失败。code 直接进 payload 的 errorCode。 */
export class DocsPathError extends Error {
  constructor(
    readonly code:
      | 'NO_SESSION_CONTEXT'
      | 'REMOTE_SESSION_UNSUPPORTED'
      | 'PATH_NOT_ALLOWED'
      | 'FILE_EXISTS'
      | 'ATOMIC_PUBLISH_UNSUPPORTED'
      | 'INVALID_EXTENSION'
      | 'NOT_A_FILE'
      | 'SHEET_NOT_FOUND'
      | 'FILE_TOO_LARGE'
      | 'UNSUPPORTED_ENCODING'
      | 'READ_TIMEOUT',
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'DocsPathError';
  }
}

/**
 * 解析当前 tool-call 的会话根目录。空 workingDir(未绑定会话 / 归属无法确认)
 * 与 SSH 远程会话都 fail closed —— 后者的 workingDir 是远端机器上的路径字符串,
 * 拿它当本机根会与同名本地目录互串。
 */
export function resolveSessionRoot(sessionCtx: DocsMcpSessionCtx): string {
  const ctx = resolveLiziMcpSessionContext(sessionCtx);
  if (ctx.remoteHostId) {
    throw new DocsPathError(
      'REMOTE_SESSION_UNSUPPORTED',
      `远程会话(${ctx.remoteHostId})的工作目录不在本机`,
      '文档工具只能在本机会话里生成文件。请在本地会话中重试,或让用户把内容带回本机后再生成。',
    );
  }
  const root = typeof ctx.workingDir === 'string' ? ctx.workingDir.trim() : '';
  if (root.length === 0) {
    throw new DocsPathError(
      'NO_SESSION_CONTEXT',
      '当前调用无法确认所属会话的工作目录',
      '本次调用没有绑定会话工作目录,无法确定文件该落在哪里。请在一个已打开工作目录的任务里重试。',
    );
  }
  return root;
}

/** 把 PathBoundaryError 统一翻成工具层的 PATH_NOT_ALLOWED。 */
function toPathError(err: unknown, inputPath: string): never {
  if (err instanceof PathBoundaryError) {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      err.message,
      `路径 "${inputPath}" 不在本任务的工作目录内。请改用工作目录内的相对路径(例如 documents/report.pdf)。`,
    );
  }
  throw err;
}

/**
 * 校验并准备一个输出路径:边界钳制 → 覆盖判定。
 * 返回可直接写入的绝对路径。
 */
export async function prepareOutputPath(
  root: string,
  outPath: string,
  overwrite: boolean,
): Promise<string> {
  let abs: string;
  try {
    abs = await resolvePathInsideRoot(root, outPath);
  } catch (err) {
    toPathError(err, outPath);
  }

  let exists = true;
  try {
    await fs.stat(abs);
  } catch {
    exists = false;
  }
  if (exists && !overwrite) {
    throw new DocsPathError(
      'FILE_EXISTS',
      `目标文件已存在: ${abs}`,
      '同名文件已存在。确认要覆盖就再调一次并传 overwrite: true,否则换一个文件名(建议加日期或版本后缀)。',
    );
  }

  return abs;
}

/** 生成器只允许与实际字节格式一致的后缀，避免产出“内容是 Word、名字却是 PDF”的文件。 */
export function assertOutputExtension(outPath: string, expectedExtension: string): void {
  const expected = expectedExtension.toLowerCase();
  const actual = path.extname(outPath).toLowerCase();
  if (actual === expected) return;
  throw new DocsPathError(
    'INVALID_EXTENSION',
    `输出文件必须使用 ${expected} 扩展名，当前是 "${actual || '(无扩展名)'}"`,
    `请把 outPath 改成以 ${expected} 结尾的文件名。`,
  );
}

/** 校验一个读取路径:边界钳制 + 必须是普通文件。 */
export async function prepareInputPath(root: string, inPath: string): Promise<string> {
  let abs: string;
  try {
    abs = await resolvePathInsideRoot(root, inPath);
  } catch (err) {
    toPathError(err, inPath);
  }
  let isFile = false;
  try {
    const st = await fs.stat(abs);
    isFile = st.isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new DocsPathError(
      'NOT_A_FILE',
      `文件不存在或不是普通文件: ${abs}`,
      `找不到文件 "${inPath}"。先确认它在本任务的工作目录里,并检查文件名与扩展名。`,
    );
  }
  return abs;
}

/**
 * 在分配输入缓冲区前先从已打开的文件句柄读取大小，并且最多只读取该次 stat
 * 看到的字节数。这样即使文件很大，或在 stat 后继续增长，也不会让 readFile
 * 在主进程里无上限分配内存。
 */
function sameFileIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev !== 0n &&
    a.ino !== 0n &&
    b.dev !== 0n &&
    b.ino !== 0n &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function sameFileVersion(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameFileIdentity(a, b) &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function changedInputPath(abs: string): DocsPathError {
  return new DocsPathError(
    'PATH_NOT_ALLOWED',
    `输入文件在校验与读取之间发生变化: ${abs}`,
    '文件路径在读取时发生了变化，已为安全起见停止。请确认文件仍在本任务工作目录内后重试。',
  );
}

function isInsideRealRoot(realRoot: string, candidate: string): boolean {
  if (realRoot === candidate) return true;
  const relative = path.relative(realRoot, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function verifyOpenedInputStillInsideRoot(
  realRoot: string,
  canonicalPath: string,
  openedStat: BigIntStats,
): Promise<void> {
  try {
    const rebound = await fs.realpath(canonicalPath);
    if (!isInsideRealRoot(realRoot, rebound)) throw changedInputPath(canonicalPath);
    const reboundStat = await fs.stat(rebound, { bigint: true });
    if (!sameFileIdentity(openedStat, reboundStat)) throw changedInputPath(canonicalPath);
  } catch (err) {
    if (err instanceof DocsPathError) throw err;
    if (err instanceof PathBoundaryError) toPathError(err, canonicalPath);
    throw changedInputPath(canonicalPath);
  }
}

export async function readInputFileWithinLimit(
  root: string,
  abs: string,
  maxBytes: number,
  tooLarge: (bytes: number) => DocsPathError,
): Promise<Buffer> {
  // 校验与读取绑定到同一个已打开文件身份，封住路径检查后父目录被换成根外
  // symlink 的窗口；身份不可用的网络盘 fail closed，不拿 0 === 0 放行。
  let canonicalPath: string;
  let realRoot: string;
  try {
    [canonicalPath, realRoot] = await Promise.all([fs.realpath(abs), fs.realpath(root)]);
    if (!isInsideRealRoot(realRoot, canonicalPath)) throw changedInputPath(abs);
  } catch (err) {
    if (err instanceof DocsPathError) throw err;
    if (err instanceof PathBoundaryError) toPathError(err, abs);
    throw changedInputPath(abs);
  }
  const expectedStat = await fs.stat(canonicalPath, { bigint: true });
  const handle = await fs.open(
    canonicalPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFileIdentity(expectedStat, stat)) {
      throw changedInputPath(canonicalPath);
    }
    await verifyOpenedInputStillInsideRoot(realRoot, canonicalPath, stat);
    if (stat.size > BigInt(maxBytes)) throw tooLarge(Number(stat.size));
    const size = Number(stat.size);

    const data = Buffer.allocUnsafeSlow(size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
    if (extraBytes > 0) throw tooLarge(Math.max(size + extraBytes, maxBytes + 1));
    const after = await handle.stat({ bigint: true });
    if (offset !== data.length || !sameFileVersion(stat, after)) {
      throw changedInputPath(canonicalPath);
    }
    await verifyOpenedInputStillInsideRoot(realRoot, canonicalPath, after);
    return data;
  } finally {
    await handle.close();
  }
}

/** 落盘后统一的成功信息:相对路径更适合读给用户听,绝对路径供后续工具串联。 */
export function describeOutput(
  root: string,
  abs: string,
  bytes: number,
): { path: string; relativePath: string; bytes: number } {
  const rel = path.relative(path.resolve(root), abs);
  return {
    path: abs,
    relativePath: rel.length > 0 ? rel : path.basename(abs),
    bytes,
  };
}
