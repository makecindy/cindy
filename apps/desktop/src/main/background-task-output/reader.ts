/**
 * 后台命令输出尾部读取器(任务卡展开区的「最近输出」数据源)。
 *
 * 路径来自 SDK 的 output_file,经 renderer(或 device-link 控制端)回传,按不可信输入
 * 校验:绝对路径 + `.output` 扩展名 + 系统目录黑名单 + 普通文件。只读末尾一段,
 * 不读全文。
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
      // 截断起点可能落在行中间(甚至多字节字符中间),丢掉首行残片。
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return { ok: true, text, size: stat.size, mtimeMs: stat.mtimeMs, truncated };
  } catch {
    return { ok: false, reason: 'read_failed' };
  } finally {
    await handle.close().catch(() => {});
  }
}
