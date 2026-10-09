import { useCallback, useEffect, useState } from 'react';
import { extractIpcError } from '../../utils/ipcError';

/** An img error alone cannot distinguish a missing file from a transport/decode failure. */
export function useImageLoadFailure(src: string | undefined, streaming = false) {
  const [failure, setFailure] = useState<{ src: string | undefined; missing: boolean } | null>(
    null,
  );
  const current = failure?.src === src ? failure : null;
  const onError = useCallback(() => setFailure({ src, missing: false }), [src]);
  useEffect(() => {
    if (!current || streaming) return;
    const retry = () => setFailure(null);
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    let cancelled = false;
    // These protocols intentionally disallow renderer fetch (CORS). Reuse the
    // existing preload reader; only Main's confirmed ENOENT means "missing".
    if (src?.startsWith('cindy-media://') || src?.startsWith('xdt-image://')) {
      void window.electronAPI?.readCachedImageAsBase64({ url: src }).catch((error: unknown) => {
        if (!cancelled && extractIpcError(error)?.code === 'NOT_FOUND') {
          setFailure({ src, missing: true });
        }
      });
    }
    return () => {
      cancelled = true;
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, [src, streaming, current !== null]);
  return {
    onError,
    status: !current ? null : streaming ? 'loading' : current.missing ? 'missing' : 'unavailable',
  } as const;
}
