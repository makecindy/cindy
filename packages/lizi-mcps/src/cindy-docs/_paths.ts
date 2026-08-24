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

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
      | 'NOT_A_FILE'
      | 'SHEET_NOT_FOUND'
      | 'FILE_TOO_LARGE'
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
 * 校验并准备一个输出路径:边界钳制 → 覆盖判定 → 建目录。
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

  // 输出目录不存在时自动建(工具约定输出进 documents/ 这类子目录,不该让模型
  // 先手工 mkdir 一次)。recursive 对已存在目录是 no-op。
  await fs.mkdir(path.dirname(abs), { recursive: true });
  return abs;
}

/**
 * 在最终落盘处再次执行防覆盖判定，避免 prepareOutputPath 的 stat/write 竞态：
 * - 默认模式用 wx，目标在两次调用之间出现时也只会失败，不会截断它；
 * - 覆盖模式先写同目录临时文件，再用 rename 原子替换；Windows 不支持直接
 *   覆盖的文件系统走「旧文件备份 → 新文件提交 → 失败恢复」降级。
 */
async function revalidateOutputBoundary(root: string, abs: string): Promise<void> {
  try {
    await resolvePathInsideRoot(root, abs);
  } catch (err) {
    toPathError(err, abs);
  }
}

async function replaceOutputFile(
  root: string,
  stagingPath: string,
  abs: string,
): Promise<void> {
  await revalidateOutputBoundary(root, abs);
  try {
    await fs.rename(stagingPath, abs);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw err;
  }

  // Windows 的 exFAT / 共享盘可能不支持 rename 覆盖已存在目标。先把旧文件
  // 搬到同目录唯一备份，再提交新文件；提交失败就恢复旧文件，绝不先 unlink。
  const backupPath = path.join(
    path.dirname(abs),
    `.cindy-docs-backup-${randomUUID()}-${path.basename(abs)}`,
  );
  let movedExisting = false;
  try {
    try {
      await fs.rename(abs, backupPath);
      movedExisting = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }

    await revalidateOutputBoundary(root, abs);
    await fs.rename(stagingPath, abs);
    if (movedExisting) {
      // 新文件已经提交，备份清理失败不能把一次成功覆盖误报为失败；残留的唯一
      // 隐藏备份仍比删除用户旧文件安全，并可由用户手工恢复。
      movedExisting = false;
      await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    if (movedExisting) {
      try {
        await revalidateOutputBoundary(root, abs);
        await fs.rename(backupPath, abs);
        movedExisting = false;
      } catch (restoreError) {
        throw new AggregateError(
          [err, restoreError],
          `替换目标失败，旧文件保留在可恢复备份: ${backupPath}`,
        );
      }
    }
    throw err;
  }
}

export async function writeOutputFile(
  root: string,
  abs: string,
  data: Uint8Array | string,
  overwrite: boolean,
): Promise<void> {
  // prepareOutputPath 与真正落盘之间可能隔着一次耗时的文档构建。最终写入前
  // 必须重新解析 symlink 边界，防止父目录在这段时间被替换到工作目录外。
  await revalidateOutputBoundary(root, abs);
  if (!overwrite) {
    try {
      await fs.writeFile(abs, data, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new DocsPathError(
          'FILE_EXISTS',
          `目标文件已存在: ${abs}`,
          '同名文件已存在。确认要覆盖就再调一次并传 overwrite: true,否则换一个文件名(建议加日期或版本后缀)。',
        );
      }
      throw err;
    }
    return;
  }

  const dir = path.dirname(abs);
  const stagingDir = await fs.mkdtemp(path.join(dir, '.cindy-docs-staging-'));
  const stagingPath = path.join(stagingDir, path.basename(abs));
  try {
    await fs.writeFile(stagingPath, data, { flag: 'wx' });
    await replaceOutputFile(root, stagingPath, abs);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {
      /* 临时 staging 清理尽力而为 */
    });
  }
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
export async function readInputFileWithinLimit(
  abs: string,
  maxBytes: number,
  tooLarge: (bytes: number) => DocsPathError,
): Promise<Buffer> {
  const handle = await fs.open(abs, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw tooLarge(stat.size);

    // allocUnsafeSlow 保证底层 ArrayBuffer 只属于这一次读取；调用方可安全地把
    // 它 transfer 给受限 worker，而不会连带转移 Node Buffer pool。
    const data = Buffer.allocUnsafeSlow(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    // 文件在 stat 后增长时也 fail closed，避免把被截断的输入交给解析器。
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
    if (extraBytes > 0) throw tooLarge(Math.max(stat.size + extraBytes, maxBytes + 1));
    return offset === data.length ? data : data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** 落盘后统一的成功信息:相对路径更适合读给用户听,绝对路径供后续工具串联。 */
export async function describeOutput(
  root: string,
  abs: string,
): Promise<{ path: string; relativePath: string; bytes: number }> {
  const st = await fs.stat(abs);
  const rel = path.relative(path.resolve(root), abs);
  return {
    path: abs,
    relativePath: rel.length > 0 ? rel : path.basename(abs),
    bytes: st.size,
  };
}
