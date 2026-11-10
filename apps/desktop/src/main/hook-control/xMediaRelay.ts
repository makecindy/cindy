/**
 * X 视频分块转传（协议见 slack-hook-protocol 的 x.media.*）。
 *
 * 读一段发一段，等 server 确认后才发下一段，内存里最多一段。上传在回帖前完成，失败时
 * 调用方照常发正文并提示附件未发出。不做断点续传：中途断线就算这条视频失败。
 */
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';

import {
  makeXMediaAbort,
  makeXMediaAppend,
  makeXMediaFinalize,
  makeXMediaInit,
  X_MEDIA_SEGMENT_MAX_BYTES,
  type HookMessage,
  type XMediaResultPayload,
  type XMediaStep,
} from '@cindy/slack-hook-protocol';

const STEP_TIMEOUT_MS = 120_000;
/** server 等 X 处理视频：最多轮询 61 次，每次不超过 30 秒。 */
const FINALIZE_TIMEOUT_MS = 35 * 60_000;

export class XMediaRelayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'XMediaRelayError';
  }
}

export interface XMediaRelayUpload {
  connectionId: string;
  requestId: string;
  absPath: string;
  mimeType: string;
  signal?: AbortSignal;
  send(message: HookMessage): boolean;
}

interface PendingStep {
  connectionId: string;
  step: XMediaStep;
  segmentIndex: number | null;
  resolve(mediaId: string | null): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

export function createXMediaRelay(options: { stepTimeoutMs?: number; finalizeTimeoutMs?: number } = {}) {
  const stepTimeoutMs = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const finalizeTimeoutMs = options.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;
  const pending = new Map<string, PendingStep>();

  const settle = (uploadId: string): PendingStep | undefined => {
    const entry = pending.get(uploadId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    entry.cleanup();
    pending.delete(uploadId);
    return entry;
  };

  const failWhere = (matches: (entry: PendingStep) => boolean): void => {
    for (const [uploadId, entry] of pending) {
      if (!matches(entry)) continue;
      settle(uploadId);
      entry.reject(new XMediaRelayError('X_MEDIA_RELAY_DISCONNECTED', 'The connection closed during the upload.'));
    }
  };

  return {
    async upload({ connectionId, requestId, absPath, mimeType, signal, send }: XMediaRelayUpload): Promise<string> {
      const cancelled = new XMediaRelayError('X_MEDIA_RELAY_CANCELLED', 'The video upload was cancelled.');
      if (signal?.aborted) throw cancelled;
      const uploadId = randomUUID();
      const target = { uploadId, requestId };
      const request = (message: HookMessage, step: XMediaStep, segmentIndex: number | null, timeoutMs: number) =>
        new Promise<string | null>((resolve, reject) => {
          if (signal?.aborted) { reject(cancelled); return; }
          const onAbort = () => {
            settle(uploadId);
            reject(cancelled);
          };
          const timer = setTimeout(() => {
            settle(uploadId);
            reject(new XMediaRelayError('X_MEDIA_RELAY_TIMEOUT', `The server did not answer ${step} in time.`));
          }, timeoutMs);
          timer.unref?.();
          pending.set(uploadId, { connectionId, step, segmentIndex, resolve, reject, timer,
            cleanup: () => signal?.removeEventListener('abort', onAbort),
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          if (send(message)) return;
          settle(uploadId);
          reject(new XMediaRelayError('X_MEDIA_RELAY_OFFLINE', 'The server connection is not available.'));
        });

      const file = await open(absPath, 'r');
      try {
        const { size } = await file.stat();
        await request(makeXMediaInit({ ...target, mimeType, totalBytes: size }), 'init', null, stepTimeoutMs);
        const buffer = Buffer.allocUnsafe(X_MEDIA_SEGMENT_MAX_BYTES);
        for (let offset = 0, segmentIndex = 0; offset < size; segmentIndex += 1) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (bytesRead === 0) throw new XMediaRelayError('X_MEDIA_RELAY_FILE_CHANGED', 'The file changed during the upload.');
          const dataBase64 = buffer.subarray(0, bytesRead).toString('base64');
          await request(makeXMediaAppend({ ...target, segmentIndex, dataBase64 }), 'append', segmentIndex, stepTimeoutMs);
          offset += bytesRead;
        }
        const mediaId = await request(makeXMediaFinalize(target), 'finalize', null, finalizeTimeoutMs);
        if (!mediaId) throw new XMediaRelayError('X_MEDIA_RELAY_INVALID', 'The server did not return a media id.');
        return mediaId;
      } catch (error) {
        send(makeXMediaAbort(target));
        throw error;
      } finally {
        await file.close();
      }
    },

    handleResult(connectionId: string, payload: XMediaResultPayload): void {
      const entry = pending.get(payload.uploadId);
      if (!entry || entry.connectionId !== connectionId || entry.step !== payload.step
        || entry.segmentIndex !== payload.segmentIndex) return;
      settle(payload.uploadId);
      if (payload.error) entry.reject(new XMediaRelayError(payload.error.code, payload.error.message));
      else entry.resolve(payload.mediaId);
    },

    failConnection(connectionId: string): void {
      failWhere((entry) => entry.connectionId === connectionId);
    },

    failAll(): void {
      failWhere(() => true);
    },
  };
}
