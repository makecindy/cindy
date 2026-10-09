import { useCallback, useEffect, useState } from 'react';

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
    const controller = new AbortController();
    // Only the local managed protocol has a known 404 = file missing contract.
    // Remote URLs can return 404 for expired transfers, so remain "unavailable".
    if (src?.startsWith('cindy-media://') || src?.startsWith('xdt-image://')) {
      void fetch(src, { signal: controller.signal })
        .then(async (response) => {
          await response.body?.cancel();
          if (!controller.signal.aborted && response.status === 404) {
            setFailure({ src, missing: true });
          }
        })
        .catch(() => {});
    }
    return () => {
      controller.abort();
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, [src, streaming, current !== null]);
  return {
    onError,
    status: !current ? null : streaming ? 'loading' : current.missing ? 'missing' : 'unavailable',
  } as const;
}
