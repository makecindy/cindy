import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const DESKTOP_ONLY_CONFIRMATION_SOURCE_PREFIX = 'desktop-confirm-source-';
const desktopOnlyConfirmationProjectionKey = randomBytes(32);

/** Creates a Host-only capability id that can be recognized without retaining request state. */
export function createDesktopOnlyConfirmationRequestId(): string {
  return `${DESKTOP_ONLY_CONFIRMATION_SOURCE_PREFIX}${randomUUID()}`;
}

export function isDesktopOnlyConfirmationRequestId(requestId: string): boolean {
  return requestId.startsWith(DESKTOP_ONLY_CONFIRMATION_SOURCE_PREFIX);
}

/** Produces the stable opaque id exposed to Device Link for request/dismissal correlation. */
export function projectDesktopOnlyConfirmationRequestId(requestId: string): string {
  const digest = createHmac('sha256', desktopOnlyConfirmationProjectionKey)
    .update(requestId)
    .digest('hex');
  return `desktop-confirm-${digest}`;
}
