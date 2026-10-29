import { createHash } from 'node:crypto';

/** Shared by hosted runs and authenticated group speed bindings. */
export function hostSessionIdFor(controller: string, sessionId: string): string {
  const hex = createHash('sha256').update(`${controller}\0${sessionId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
