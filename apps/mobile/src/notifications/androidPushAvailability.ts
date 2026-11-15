/** Registration is a hint, not proof of delivery. Mainland networks retain a direct connection. */
export type AndroidPushAvailability = 'unknown' | 'available' | 'unavailable';
let availability: AndroidPushAvailability = 'unknown';
const listeners = new Set<() => void>();
export function readAndroidPushAvailability() { return availability; }
export function setAndroidPushAvailability(next: AndroidPushAvailability) {
  if (availability === next) return;
  availability = next;
  for (const listener of listeners) listener();
}
export function subscribeAndroidPushAvailability(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
