/**
 * Electron wiring for the bounded workdir probe utility-process pool.
 */

import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { WorkdirProbeHostClient } from './WorkdirProbeHostClient.js';

const log = createLogger('workdir-probe-host');

function forkProbeHost(): ReturnType<typeof utilityProcess.fork> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'workdirProbeHostProcess.js'), [], {
    serviceName: 'xdt-workdir-probe-host',
    // 避免继承 token/API key；只保留进程启动和本地化所需的系统变量。
    env,
    // 不继承可能恰好位于断线网络盘上的宿主 cwd。
    cwd: os.tmpdir(),
  });
}

export const workdirProbeHostClient = new WorkdirProbeHostClient({
  fork: forkProbeHost,
  log,
});

/** Bounded filesystem identity probe for local cwd recovery; never expose paths to a controller. */
export async function statWorkingDirectory(dir: string): Promise<{ isDirectory(): boolean; dev?: number }> {
  const result = await workdirProbeHostClient.probe(dir, path.resolve(dir), 5_000);
  if (!result.ok) throw Object.assign(new Error('Working directory probe failed'), { code: result.code });
  return { isDirectory: () => result.isDirectory, dev: result.device };
}

// 真实 Electron app 一定有 once；条件注册让引用 guard 的纯 Node 单测仍可使用
// 只覆盖自身所需字段的窄 electron stub，而不必为未执行的生命周期补整套假实现。
if (typeof app.once === 'function') {
  app.once('before-quit', () => {
    workdirProbeHostClient.dispose();
  });
}
