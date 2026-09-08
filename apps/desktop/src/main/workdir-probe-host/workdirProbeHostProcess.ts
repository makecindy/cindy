/**
 * Dedicated Electron utility-process entry for directory probes.
 *
 * The main process assigns at most one request at a time to each host. A stuck
 * UNC/SMB stat is cancelled by terminating this process, never by accumulating
 * uncancellable libuv work in Electron's main process.
 */

import { stat, mkdir, realpath, readdir } from 'node:fs/promises';
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

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

export async function runDirectoryOperation(request: WorkdirProbeRequest): Promise<WorkdirProbeResult> {
  try {
    if (request.kind === 'mkdir') {
      await mkdir(request.dir, { recursive: true });
      return { ok: true, isDirectory: true };
    }
    if (request.kind === 'realpath') {
      return { ok: true, isDirectory: true, path: await realpath(request.dir) };
    }
    if (request.kind === 'similar') {
      const parent = path.dirname(request.dir);
      const target = path.basename(request.dir);
      if (!target || parent === request.dir) return { ok: true, isDirectory: false, path: null };
      const entries = await readdir(parent);
      const match = entries.find((n) => n !== target && n.trim() === target.trim()) ??
        entries.find((n) => n !== target && n.toLowerCase() === target.toLowerCase());
      return { ok: true, isDirectory: false, path: match ? path.join(parent, match) : null };
    }
    const entry = await stat(request.dir);
    return { ok: true, isDirectory: entry.isDirectory(), device: entry.dev };
  } catch (error) {
    return { ok: false, code: filesystemErrorCode(error) };
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as Partial<WorkdirProbeRequest>;
    if (
      !['probe', 'mkdir', 'realpath', 'similar'].includes(request.kind ?? '') ||
      typeof request.id !== 'number' ||
      typeof request.dir !== 'string' ||
      request.dir.length === 0
    ) {
      return;
    }
    void runDirectoryOperation(request as WorkdirProbeRequest)
      .then((result) => {
        const response: WorkdirProbeResponse = {
          kind: 'result',
          id: request.id!,
          result,
        };
        parentPort.postMessage(response);
      });
  });
}
