import { setTimeout as delay } from 'node:timers/promises';
import { REMOTE_AGENT_READ_MAX_BYTES, type RemoteAgentRequest } from '@cindy/device-link';
import { sniffMediaMime } from './sniffMediaMime.js';

type ImageRequest = Extract<RemoteAgentRequest, { op: 'shared-image' }>;
export type SharedImageStart = Extract<ImageRequest, { action: 'start' }>;
type Invoke = (request: ImageRequest) => Promise<unknown>;

export async function generateSharedImage(
  invoke: Invoke,
  request: SharedImageStart,
  signal: AbortSignal,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { requestId } = request;
  signal.throwIfAborted();
  try {
    const start = await invoke(request);
    if (!start || typeof start !== 'object' || (start as { accepted?: unknown }).accepted !== true) {
      throw new Error('SHARED_IMAGE_UNAVAILABLE');
    }
    let offset = 0;
    let image: Buffer | undefined;
    let mimeType: string | undefined;
    while (true) {
      signal.throwIfAborted();
      const reply = await invoke({ op: 'shared-image', action: 'read', requestId, offset });
      signal.throwIfAborted();
      if (!reply || typeof reply !== 'object') throw new Error('SHARED_IMAGE_UNAVAILABLE');
      const { state, size, mimeType: nextMime, data } = reply as Record<string, unknown>;
      if (state === 'pending' && !image) {
        await delay(700, undefined, { signal });
        continue;
      }
      if (state !== 'complete' || typeof data !== 'string' || typeof nextMime !== 'string'
        || !Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > 32 * 1024 * 1024
        || data.length > Math.ceil(REMOTE_AGENT_READ_MAX_BYTES / 3) * 4) {
        throw new Error('SHARED_IMAGE_UNAVAILABLE');
      }
      image ??= Buffer.alloc(size as number);
      mimeType ??= nextMime;
      const bytes = Buffer.from(data, 'base64');
      if (size !== image.length || nextMime !== mimeType || bytes.toString('base64') !== data
        || bytes.length !== Math.min(REMOTE_AGENT_READ_MAX_BYTES, image.length - offset)) {
        throw new Error('SHARED_IMAGE_INVALID');
      }
      bytes.copy(image, offset);
      offset += bytes.length;
      if (offset === image.length) {
        if (sniffMediaMime(image) !== mimeType || !mimeType.startsWith('image/')) throw new Error('SHARED_IMAGE_INVALID');
        return { buffer: image, mimeType };
      }
    }
  } finally {
    void Promise.resolve()
      .then(() => invoke({ op: 'shared-image', action: 'release', requestId }))
      .catch(() => undefined);
  }
}
