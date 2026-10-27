import { i18n } from '@/i18n';
import { buildMobileImageAttachmentCandidate, type MobileImagePickerAssetLike } from './mobileImageAttachment';
import type { MobileLocalAttachmentUploadCandidate } from './mobileLocalAttachmentUpload';

interface PhotoSelection {
  id: string;
  name: string;
  previewUri: string;
  width?: number;
  height?: number;
}

interface DeferredPhotoPicker {
  pick(limit: number): Promise<PhotoSelection[]>;
  load(id: string): Promise<MobileImagePickerAssetLike>;
  cancel(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

function throwLocalizedPhotoError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  // Native/provider messages can use the OS language and contain internal file
  // paths. Only translate this boundary, preserving downstream conversion errors.
  throw new Error(i18n.t(code === 'ERR_PHOTO_CANCELLED'
    ? 'composer.upload.cancelled'
    : 'composer.upload.noImageRead'), { cause: error });
}

async function cleanupLocalUris(uris: readonly string[]): Promise<void> {
  const files = uris.filter((uri) => uri.startsWith('file://'));
  if (files.length === 0) return;
  const { deleteAsync } = await import('expo-file-system/legacy');
  await Promise.all(files.map((uri) => deleteAsync(uri, { idempotent: true })));
}

/** null means an older native binary; preserve its Expo picker as a fallback.
 * Selection returns before any original is downloaded. The existing upload
 * queue owns resolution, cancellation, retry, outbox handoff and file cleanup.
 */
export async function pickDeferredLibraryPhotos(
  limit: number,
): Promise<MobileLocalAttachmentUploadCandidate[] | null> {
  const { requireOptionalNativeModule } = await import('expo-modules-core');
  const native = requireOptionalNativeModule<DeferredPhotoPicker>('CindyPhotoPicker');
  if (!native) return null;
  const selected = await native.pick(limit).catch(throwLocalizedPhotoError);
  return selected.map((photo, index) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void native.release(photo.id).catch(() => undefined);
    };
    return {
      kind: 'image',
      uri: photo.previewUri,
      name: photo.name,
      size: 0,
      width: photo.width,
      height: photo.height,
      onAbandoned: release,
      onConsumed: release,
      cleanupLocalUris,
      resolve: async (signal?: AbortSignal) => {
        if (signal?.aborted || released) throw new Error(i18n.t('composer.upload.cancelled'));
        const cancel = () => { void native.cancel(photo.id).catch(() => undefined); };
        const loaded = native.load(photo.id).catch(throwLocalizedPhotoError);
        signal?.addEventListener('abort', cancel, { once: true });
        let uri: string | undefined;
        try {
          const asset = await loaded;
          uri = asset.uri ?? undefined;
          if (signal?.aborted || released) throw new Error(i18n.t('composer.upload.cancelled'));
          const candidate = buildMobileImageAttachmentCandidate({ ...photo, ...asset }, index);
          if (!candidate.resolve) return candidate;
          const converted = await candidate.resolve();
          // Conversion creates a second owned file; only it needs to enter the
          // controller's temporary-file set. Preserve the provider for retries.
          if (uri && converted.uri !== uri) void cleanupLocalUris([uri]).catch(() => undefined);
          return { ...candidate, ...converted };
        } catch (error) {
          if (uri) void cleanupLocalUris([uri]).catch(() => undefined);
          throw error;
        } finally {
          signal?.removeEventListener('abort', cancel);
        }
      },
    };
  });
}
