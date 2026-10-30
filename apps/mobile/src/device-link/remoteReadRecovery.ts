import { connectionRecoverySyncRetryDelayMs, isAutoRecoveringRemoteError } from './remoteStatus';

/** Retry failed reads only while their owning page/connection is current. Never replay writes. */
export function createRemoteReadRecovery(retry: () => void, current: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    failed(error: unknown) {
      if (disposed || !current() || timer || !isAutoRecoveringRemoteError(error)) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && current()) retry();
      }, connectionRecoverySyncRetryDelayMs(attempt++));
    },
    succeeded() { cancel(); attempt = 0; },
    dispose() { disposed = true; cancel(); },
  };
}
