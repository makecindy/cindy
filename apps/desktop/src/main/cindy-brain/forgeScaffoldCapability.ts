import { utilityProcess } from 'electron';
import path from 'node:path';

import type {
  ForgeScaffoldWriteRequest,
  ForgeScaffoldWriteResult,
} from './forge.js';

/**
 * Consume a scaffold request from a utility process whose cwd is the already
 * validated parent directory. Relative mkdir/write/rename/rm operations then
 * stay bound to that directory even if an attacker swaps the path name after
 * the main process check. The worker also rechecks the parent identity before
 * and after consuming the request.
 */
export function writeForgeScaffoldWithStableParent(
  request: ForgeScaffoldWriteRequest,
): Promise<ForgeScaffoldWriteResult> {
  const entry = path.join(__dirname, 'forgeScaffoldWorkerProcess.js');
  const inheritedKeys = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = utilityProcess.fork(entry, [], {
    cwd: request.parentDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'cindy-forge-scaffold',
  });
  const maxStderrBytes = 16 * 1024;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    const remaining = maxStderrBytes - stderrBytes;
    if (remaining <= 0) return;
    const bounded = Buffer.from(chunk.subarray(0, remaining));
    stderrChunks.push(bounded);
    stderrBytes += bounded.length;
  });

  return new Promise((resolve) => {
    let settled = false;
    let ready = false;
    const finish = (result: ForgeScaffoldWriteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The worker is single-request by design. Always terminate it after a
      // result (including TARGET_EXISTS and INTERNAL) so repeated forge calls
      // cannot accumulate resident utility processes.
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, errorCode: 'INTERNAL', message: 'Forge scaffold worker timed out' });
    }, 30_000);
    timer.unref?.();

    child.on('message', (message: unknown) => {
      if (
        !ready &&
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        ready = true;
        child.postMessage({ type: 'scaffold', request: {
          expectedParent: request.expectedParent,
          targetName: request.targetName,
          files: request.files,
        } });
        return;
      }
      if (!message || typeof message !== 'object') return;
      const result = message as Partial<ForgeScaffoldWriteResult>;
      if (result.ok === true) {
        finish({ ok: true });
      } else if (result.ok === false && (result.errorCode === 'TARGET_EXISTS' || result.errorCode === 'INTERNAL')) {
        finish({ ok: false, errorCode: result.errorCode, message: String(result.message ?? 'Forge scaffold worker failed') });
      }
    });
    child.on('error', (error: unknown) => {
      finish({
        ok: false,
        errorCode: 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('exit', (code: number) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish({ ok: false, errorCode: 'INTERNAL', message: stderr || `Forge scaffold worker exited (${code})` });
    });
  });
}
