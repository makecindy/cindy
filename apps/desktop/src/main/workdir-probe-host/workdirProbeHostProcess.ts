/**
 * Dedicated Electron utility-process entry for directory probes.
 *
 * The main process assigns at most one request at a time to each host. A stuck
 * UNC/SMB stat/realpath/write is cancelled by terminating this process, never
 * by accumulating uncancellable libuv work in Electron's main process.
 *
 * 'validate' / 'availability' carry the IM channel working-directory probe
 * discipline (six-round review rulings) — the ownership rules travel with the
 * job into the child:
 *   - probe file is created exclusively ('wx'); a collision means the path
 *     belongs to someone else and is left untouched;
 *   - only a file this invocation confirmed creating is ever removed;
 *   - no prefix scans, no delayed retries; a killed/late probe accepts 0-byte
 *     UUID residue.
 * The worker functions are exported pure so vitest can exercise the discipline
 * in-process (same pattern as cindy-brain/ghostSnapshotWorkerProcess).
 */

import { realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  WorkdirProbeRequest,
  WorkdirProbeResponse,
  WorkdirProbeResult,
} from './protocol';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

const WORKDIR_PROBE_PREFIX = '.cindy-workdir-probe-';

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

/**
 * 'wx' 独占创建 + 删除一次性 0 字节探针 — 只删除本次调用确认创建的文件;
 * 任何失败按 false 收口(父进程据此判定不可用/不可写)。
 */
export async function runWriteProbe(candidate: string): Promise<boolean> {
  const probe = path.join(candidate, `${WORKDIR_PROBE_PREFIX}${randomUUID()}`);
  let created = false;
  try {
    if (!(await stat(candidate)).isDirectory()) return false;
    await writeFile(probe, '', { flag: 'wx' });
    created = true;
    return true;
  } catch {
    return false;
  } finally {
    if (created) {
      try {
        await rm(probe, { force: true });
      } catch {
        // 锁挡住删除: 接受 0 字节残留 — 不记住路径, 不重试, 不扫描。
      }
    }
  }
}

/** validate: realpath → stat → 'wx' 写探针 → 清理;成功回传解析后的真实路径。 */
export async function runValidateJob(dir: string): Promise<WorkdirProbeResult> {
  let realPath: string;
  try {
    realPath = await realpath(dir);
  } catch (error) {
    return { ok: false, code: filesystemErrorCode(error) };
  }
  if (!(await stat(realPath).then((s) => s.isDirectory(), () => false))) {
    return { ok: false, code: 'NOT_DIRECTORY' };
  }
  if (!(await runWriteProbe(realPath))) {
    return { ok: false, code: 'NOT_WRITABLE' };
  }
  return { ok: true, realPath };
}

/** availability: stat → 'wx' 写探针 → 清理;失败宽大收口为不可用。 */
export async function runAvailabilityJob(dir: string): Promise<WorkdirProbeResult> {
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
    return { ok: false, code: 'NOT_DIRECTORY' };
  }
  return { ok: true, usable: await runWriteProbe(dir) };
}

export async function runProbeJob(dir: string): Promise<WorkdirProbeResult> {
  return stat(dir).then<WorkdirProbeResult, WorkdirProbeResult>(
    (entry) => ({ ok: true, isDirectory: entry.isDirectory() }),
    (error) => ({ ok: false, code: filesystemErrorCode(error) }),
  );
}

export function runRequestJob(request: WorkdirProbeRequest): Promise<WorkdirProbeResult> {
  switch (request.kind) {
    case 'probe':
      return runProbeJob(request.dir);
    case 'validate':
      return runValidateJob(request.dir);
    case 'availability':
      return runAvailabilityJob(request.dir);
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    const message = event.data as Partial<WorkdirProbeRequest>;
    if (
      (message.kind !== 'probe' &&
        message.kind !== 'validate' &&
        message.kind !== 'availability') ||
      typeof message.id !== 'number' ||
      typeof message.dir !== 'string' ||
      message.dir.length === 0
    ) {
      return;
    }
    const request: WorkdirProbeRequest = { kind: message.kind, id: message.id, dir: message.dir };
    void runRequestJob(request).then((result) => {
      const response: WorkdirProbeResponse = {
        kind: 'result',
        id: request.id,
        result,
      };
      parentPort.postMessage(response);
    });
  });
}
