/**
 * 日志采集的本机文件适配层。
 *
 * 采集、来源白名单和脱敏规则仍由 collectLogs 统一负责；本模块只提供 main 侧的
 * 只读文件句柄和运行期路径，供日志上报与 issue 反馈共用同一条安全管道。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLogDir } from '../logger';
import { collectLogs, type CollectDeps, type CollectRequest } from './collect';
import type { RandomAccessFile } from './mainLogReader';
import type { CollectResult } from './types';

async function openReadOnly(
  filePath: string,
): Promise<(RandomAccessFile & { close(): Promise<void> }) | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return null;
  }
  return {
    async size() {
      const stat = await handle.stat();
      return stat.size;
    },
    async read(offset: number, length: number) {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    },
    async close() {
      await handle.close();
    },
  };
}

function collectDeps(): CollectDeps {
  const logDir = getLogDir();
  if (!logDir || !path.isAbsolute(logDir)) throw new Error('log directory unavailable');
  return {
    logDir,
    listDir: (dir) => fs.promises.readdir(dir),
    openFile: openReadOnly,
    now: () => Date.now(),
    homeDir: os.homedir(),
    yieldToEventLoop: () => new Promise<void>((resolve) => setImmediate(resolve)),
    joinPath: (...parts) => path.join(...parts),
  };
}

export function collectLogsFromDisk(request: CollectRequest): Promise<CollectResult> {
  return collectLogs(collectDeps(), request);
}
