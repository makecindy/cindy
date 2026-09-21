/** OS browser launch has a shorter budget than the user's authorization flow. */
export const AUTH_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

export type AuthBrowserLaunchResult =
  | { opened: true }
  | { opened: false; error: 'USER_CANCELLED' | 'BROWSER_OPEN_FAILED' | 'BROWSER_OPEN_TIMEOUT' };

/** Bound a non-cancellable OS call, consuming late rejections after cancellation/timeout. */
export function launchAuthBrowser(
  open: () => Promise<void>,
  signal: AbortSignal,
): Promise<AuthBrowserLaunchResult> {
  if (signal.aborted) return Promise.resolve({ opened: false, error: 'USER_CANCELLED' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AuthBrowserLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => finish({ opened: false, error: 'USER_CANCELLED' });
    const timer = setTimeout(
      () => finish({ opened: false, error: 'BROWSER_OPEN_TIMEOUT' }),
      AUTH_BROWSER_LAUNCH_TIMEOUT_MS,
    );
    signal.addEventListener('abort', cancel, { once: true });
    try {
      void open().then(
        () => finish({ opened: true }),
        () => finish({ opened: false, error: 'BROWSER_OPEN_FAILED' }),
      );
    } catch {
      finish({ opened: false, error: 'BROWSER_OPEN_FAILED' });
    }
  });
}
