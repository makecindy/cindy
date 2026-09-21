import { realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WorkdirAvailabilityResult, WorkdirValidateResult } from './protocol';

export interface ChannelWorkdirProbeFs {
  stat(dir: string): Promise<{ isDirectory(): boolean }>;
  realpath(dir: string): Promise<string>;
  writeFile(file: string, data: string, options: { flag: 'wx' }): Promise<void>;
  rm(file: string, options: { force: true }): Promise<void>;
}

const defaultFs: ChannelWorkdirProbeFs = {
  realpath: (dir) => realpath(dir),
  stat: (dir) => stat(dir),
  rm: (file, options) => rm(file, options),
  writeFile: (file, data, options) => writeFile(file, data, options),
};
const assertUnbounded = () => {};

function filesystemErrorCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

/** Only remove a file this invocation exclusively created; never scan or retry. */
export async function runWriteProbe(
  candidate: string,
  fs: ChannelWorkdirProbeFs = defaultFs,
  assertActive: () => void = assertUnbounded,
): Promise<boolean> {
  const probe = path.join(candidate, `.cindy-workdir-probe-${randomUUID()}`);
  let created = false;
  try {
    assertActive();
    if (!(await fs.stat(candidate)).isDirectory()) return false;
    // A late stat must not start a write after timeout/disposal.
    assertActive();
    await fs.writeFile(probe, '', { flag: 'wx' });
    created = true;
    return true;
  } catch {
    assertActive();
    return false;
  } finally {
    if (created) {
      try {
        // Even a late successful write owns this file and must attempt cleanup.
        await fs.rm(probe, { force: true });
      } catch {
        // Accept zero-byte residue if cleanup fails; no deferred retry.
      }
    }
  }
}

export async function runValidateJob(
  dir: string,
  fs: ChannelWorkdirProbeFs = defaultFs,
  assertActive: () => void = assertUnbounded,
): Promise<WorkdirValidateResult> {
  let realPath: string;
  try {
    assertActive();
    realPath = await fs.realpath(dir);
  } catch (error) {
    assertActive();
    return { ok: false, code: filesystemErrorCode(error) };
  }
  assertActive();
  if (
    !(await fs.stat(realPath).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    return { ok: false, code: 'NOT_DIRECTORY' };
  }
  if (!(await runWriteProbe(realPath, fs, assertActive))) {
    return { ok: false, code: 'NOT_WRITABLE' };
  }
  return { ok: true, realPath };
}

export async function runAvailabilityJob(
  dir: string,
  fs: ChannelWorkdirProbeFs = defaultFs,
  assertActive: () => void = assertUnbounded,
): Promise<WorkdirAvailabilityResult> {
  assertActive();
  if (
    !(await fs.stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    return { ok: false, code: 'NOT_DIRECTORY' };
  }
  return { ok: true, usable: await runWriteProbe(dir, fs, assertActive) };
}
