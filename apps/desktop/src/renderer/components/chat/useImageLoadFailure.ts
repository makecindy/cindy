import { useCallback, useEffect, useState } from 'react';
import { extractIpcError } from '../../utils/ipcError';

/** An img error alone cannot distinguish a missing file from a transport/decode failure. */
export function useImageLoadFailure(src: string | undefined, streaming = false) {
  const [failure, setFailure] = useState<{
    src: string | undefined;
    missing: boolean;
    readable?: boolean;
  } | null>(null);
  const current = failure?.src === src ? failure : null;
  const onError = useCallback(() => setFailure({ src, missing: false }), [src]);
  const retry = useCallback(() => setFailure(null), []);
  // Stream completion is a natural retry boundary: the producer may just have
  // finished writing the image. Successful byte probes alone must not retry,
  // since readable but undecodable bytes would otherwise cause an error loop.
  useEffect(() => {
    if (!streaming) setFailure(null);
  }, [src, streaming]);
  useEffect(() => {
    if (!current || streaming) return;
    const retry = () => setFailure(null);
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    let cancelled = false;
    // These protocols intentionally disallow renderer fetch (CORS). Reuse the
    // existing preload reader; only Main's confirmed ENOENT means "missing".
    if (src?.startsWith('cindy-media://') || src?.startsWith('xdt-image://')) {
      void window.electronAPI?.readCachedImageAsBase64({ url: src }).then(
        () => {
          if (!cancelled) {
            // Readable bytes permit a user-requested remount, not an automatic
            // retry: a corrupt but readable image must not create a load loop.
            setFailure((previous) => previous?.src === src ? { ...previous, readable: true } : previous);
          }
        },
        (error: unknown) => {
          if (!cancelled && extractIpcError(error)?.code === 'NOT_FOUND') {
            setFailure({ src, missing: true });
          }
        },
      );
    }
    return () => {
      cancelled = true;
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, [src, streaming, current !== null]);
  return {
    onError,
    retry,
    canRetry: !streaming && current?.readable === true && !current.missing,
    status: !current ? null : streaming ? 'loading' : current.missing ? 'missing' : 'unavailable',
  } as const;
}
