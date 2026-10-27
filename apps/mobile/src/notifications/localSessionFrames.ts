import type { Envelope } from '@cindy/device-link';
const listeners = new Set<(frame: Envelope) => void>();
export function subscribeLocalSessionFrames(listener: (frame: Envelope) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function dispatchLocalSessionFrame(frame: Envelope) {
  for (const listener of listeners) listener(frame);
}
