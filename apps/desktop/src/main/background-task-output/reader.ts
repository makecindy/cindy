/**
 * 后台命令输出尾部读取器(任务卡展开区的「最近输出」数据源)。
 *
 * 路径由主进程从会话的后台任务登记(SDK task_started 的 output_file)取得,调用方
 * 不能指定。这里再做一层纵深校验:绝对路径 + `.output` 扩展名 + 系统目录黑名单 +
 * 不跟随符号链接 + 普通文件。只读末尾一段,不读全文。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BACKGROUND_TASK_OUTPUT_EXTENSION,
  BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES,
  type BackgroundTaskOutputTailResult,
} from '../../shared/backgroundTaskOutput.js';
import { buildSystemPathBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';

const SYSTEM_PATH_BLOCKLIST = buildSystemPathBlocklist();

export async function readBackgroundTaskOutputTail(
  filePath: unknown,
  maxBytes = BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES,
): Promise<BackgroundTaskOutputTailResult> {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.extname(filePath) !== BACKGROUND_TASK_OUTPUT_EXTENSION ||
    !isPathAllowedAgainst(filePath, SYSTEM_PATH_BLOCKLIST)
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  let handle: fs.FileHandle;
  try {
    // 字符串校验管不到链接目标:符号链接一律拒绝,不跟随到允许范围外的文件。
    if ((await fs.lstat(filePath)).isSymbolicLink()) return { ok: false, reason: 'forbidden' };
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not_found' : 'read_failed',
    };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'forbidden' };
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } =
      length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      // 截断起点可能落在行中间(甚至多字节字符中间),丢掉首行残片。整段只有一条长行
      // (长进度行 / 单行 JSON)时残片就是全部可用输出,保留它,只去掉被切坏的字符。
      const firstNewline = text.indexOf('\n');
      const rest = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      text = rest.trim() ? rest : text.replace(/^\uFFFD+/, '');
    }
    return { ok: true, text, size: stat.size, mtimeMs: stat.mtimeMs, truncated };
  } catch {
    return { ok: false, reason: 'read_failed' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 会话侧的后台任务登记(活跃本地会话才有);SSH 远程工作区会话不提供。 */
export interface BackgroundTaskOutputSource {
  listBackgroundTasks(): ReadonlyArray<{ taskId: string; outputFile?: string }>;
}

/**
 * 按 (会话, 任务) 读取运行中后台命令的输出尾部。路径只取自会话的任务登记,调用方
 * 无法指定;会话不可用、任务已终态或没有登记输出文件 → unavailable。
 */
export async function readSessionBackgroundTaskOutputTail(
  source: BackgroundTaskOutputSource | undefined,
  taskId: unknown,
): Promise<BackgroundTaskOutputTailResult> {
  if (typeof taskId !== 'string' || !taskId) return { ok: false, reason: 'forbidden' };
  const outputFile = source
    ?.listBackgroundTasks()
    .find((task) => task.taskId === taskId)?.outputFile;
  if (!outputFile) return { ok: false, reason: 'unavailable' };
  return readBackgroundTaskOutputTail(outputFile);
}
