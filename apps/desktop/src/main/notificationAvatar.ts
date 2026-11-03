import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { NOTIFY_AVATAR_JPEG_MAX_LENGTH, type NotifySender } from '@cindy/device-link';
import { isManagedBotAvatarUrl, isSingleBotAvatarGrapheme, BOT_AVATAR_MAX_BYTES } from '../shared/botAvatarValue';
import { resolveSafe } from './cindy-media/blobStore';

/** No public avatar upload, remote URL, extra credential or persistent thumbnail cache. */
export async function notificationAvatar(value: string): Promise<NotifySender['avatar']> {
  const preset = /^cindy:\/\/avatar\/preset\/(cindy|dash|lizi)$/.exec(value.toLowerCase())?.[1];
  if (preset) return { kind: 'preset', value: preset };
  if (value.length <= 32 && isSingleBotAvatarGrapheme(value)) return { kind: 'symbol', value };
  if (!isManagedBotAvatarUrl(value)) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const bytes = await readFile(resolveSafe(value).absPath, { signal: controller.signal });
        if (controller.signal.aborted || bytes.length > BOT_AVATAR_MAX_BYTES) return undefined;
        return encodeNotificationAvatar(bytes, sharp, controller.signal);
      })(),
      // Never spend the transcript's entire preview deadline on optional artwork.
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 150);
      }),
    ]);
  } catch {
    // Identity enrichment must never suppress an otherwise deliverable reply.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function encodeNotificationAvatar(
  bytes: Buffer,
  sharp: typeof import('sharp').default,
  signal?: AbortSignal,
): Promise<NotifySender['avatar']> {
  for (const [size, quality] of [[72, 65], [56, 50], [40, 35]]) {
    if (signal?.aborted) return undefined;
    const jpeg = await sharp(bytes, { limitInputPixels: 16_777_216 })
      .rotate().resize(size, size, { fit: 'cover' }).jpeg({ quality }).toBuffer();
    const value = jpeg.toString('base64');
    if (value.length <= NOTIFY_AVATAR_JPEG_MAX_LENGTH) return { kind: 'jpeg', value };
  }
  return undefined;
}
