/**
 * host-daemons/exec —— 适配器执行外部命令的统一入口。
 *
 * 用 execFile 不过 shell：参数原样传，不需要自己拼引号，也不会有注入面。
 * 非 0 退出码不抛出，交给调用方按场景判断（「没有 crontab」「单元没加载」都是
 * 正常业务分支，不是异常）。
 */

import { execFile } from 'node:child_process';

import type { ExecResult } from './target.js';

export type RunCommand = (
  file: string,
  args: string[],
  options?: { input?: string },
) => Promise<ExecResult>;

export const runCommand: RunCommand = (file, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, failed: false });
          return;
        }
        // ENOENT 等启动失败：命令本身不存在（例如没有 systemctl），交给调用方降级。
        if (error.code === 'ENOENT') {
          resolve({ stdout: '', stderr: '', failed: true });
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code: typeof error.code === 'number' ? error.code : undefined,
          failed: true,
        });
      },
    ).stdin?.end(options?.input ?? undefined);
  });
