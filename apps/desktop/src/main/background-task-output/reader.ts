/**
 * 后台命令输出尾部读取器(任务卡展开区的「最近输出」数据源)。
 *
 * 路径由主进程从会话的后台任务登记(SDK task_started 的 output_file)取得,调用方
 * 不能指定。这里再做一层纵深校验(与 fileReadBytes 同一模型):
 *   - 规范化:先 realpath 解析掉所有符号链接(含上级目录),对真实路径检查绝对路径 +
 *     `.output` 扩展名 + 系统目录黑名单;
 *   - 不跟随打开:打开真实路径时带 O_NOFOLLOW(平台支持时),检查与打开之间末级被换成
 *     链接会直接失败;
 *   - 身份核对:打开后的描述符与检查时的真实路径必须是同一文件(bigint dev/ino,
 *     ino 为 0 视为无法核对、拒绝),且是普通文件。
 * 只读末尾一段,不读全文。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BACKGROUND_TASK_OUTPUT_EXTENSION,
  BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES,
  type BackgroundTaskOutputTailResult,
} from '../../shared/backgroundTaskOutput.js';
import { buildSystemPathBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';

const SYSTEM_PATH_BLOCKLIST = buildSystemPathBlocklist();
const OPEN_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function isAllowedOutputPath(filePath: string): boolean {
  return (
    path.isAbsolute(filePath) &&
    path.extname(filePath) === BACKGROUND_TASK_OUTPUT_EXTENSION &&
    isPathAllowedAgainst(filePath, SYSTEM_PATH_BLOCKLIST)
  );
}

function missingOr(error: unknown, fallback: 'forbidden' | 'read_failed') {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? ('not_found' as const) : fallback;
}

export async function readBackgroundTaskOutputTail(
  filePath: unknown,
  maxBytes = BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES,
): Promise<BackgroundTaskOutputTailResult> {
  if (typeof filePath !== 'string' || !isAllowedOutputPath(filePath)) {
    return { ok: false, reason: 'forbidden' };
  }
  let realPath: string;
  let handle: fs.FileHandle;
  let expected: { dev: bigint; ino: bigint };
  try {
    realPath = await fs.realpath(filePath);
    // 链接目标同样要是允许范围内的 .output 文件,不能借名字合规的链接读别的文件。
    if (!isAllowedOutputPath(realPath)) return { ok: false, reason: 'forbidden' };
    expected = await fs.stat(realPath, { bigint: true });
  } catch (error) {
    return { ok: false, reason: missingOr(error, 'read_failed') };
  }
  try {
    handle = await fs.open(realPath, OPEN_NO_FOLLOW);
  } catch (error) {
    // ELOOP 等:检查之后末级被换成了链接。
    return { ok: false, reason: missingOr(error, 'forbidden') };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      expected.ino === 0n ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      return { ok: false, reason: 'forbidden' };
    }
    const size = Number(stat.size);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
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
    const ageMs = Math.max(0, Date.now() - Number(stat.mtimeMs));
    return { ok: true, text, size, ageMs, truncated };
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
