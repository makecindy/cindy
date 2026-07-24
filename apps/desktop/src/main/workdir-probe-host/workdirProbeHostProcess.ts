/**
 * Dedicated Electron utility-process entry for directory probes.
 *
 * The main process assigns at most one request at a time to each host. A stuck
 * UNC/SMB stat is cancelled by terminating this process, never by accumulating
 * uncancellable libuv work in Electron's main process.
 */

import { stat } from 'node:fs/promises';

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

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as Partial<WorkdirProbeRequest>;
    if (
      request.kind !== 'probe' ||
      typeof request.id !== 'number' ||
      typeof request.dir !== 'string' ||
      request.dir.length === 0
    ) {
      return;
    }
    void stat(request.dir)
      .then<WorkdirProbeResult, WorkdirProbeResult>(
        (entry) => ({ ok: true, isDirectory: entry.isDirectory() }),
        (error) => ({ ok: false, code: filesystemErrorCode(error) }),
      )
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
