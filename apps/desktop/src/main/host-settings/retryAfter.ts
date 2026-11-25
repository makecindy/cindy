import { retryAfterDeadline } from '@cindy/auth-client';

/** How long a response's Retry-After asks to wait, in seconds or until an HTTP date; none if absent or invalid. */
export function retryAfterDelayMs(response: Pick<Response, 'headers'>): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (value && /^\d+$/u.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isSafeInteger(delay) ? delay : null;
  }
  const deadline = retryAfterDeadline(response);
  return deadline === undefined ? null : Math.max(0, deadline - Date.now());
}
