import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { MobileHistoryAnchor } from './messageHistoryAnchor';

export type MessageReadingPosition = { anchor: MobileHistoryAnchor | null; atEnd: boolean };
let owner = getMobileAuthOwner();
const positions = new Map<string, { device: string; session: string; value?: MessageReadingPosition }>();

/** Small, account-scoped bookmarks only; message content stays in the existing history cache. */
export function messageReadingPosition(device: string, session: string) {
  const capturedOwner = getMobileAuthOwner();
  if (owner !== capturedOwner) { positions.clear(); owner = capturedOwner; }
  const key = JSON.stringify([device, session]);
  const entry = positions.get(key) ?? { device, session };
  positions.delete(key);
  positions.set(key, entry);
  while (positions.size > 8) positions.delete(positions.keys().next().value!);
  const current = () => capturedOwner === getMobileAuthOwner() && positions.get(key) === entry;
  return {
    read: () => current() ? entry.value : undefined,
    write: (value: MessageReadingPosition) => { if (current()) entry.value = value; },
  };
}

export function clearMessageReadingPositions(device?: string, session?: string) {
  for (const [key, entry] of positions) {
    if ((device === undefined || device === entry.device) && (session === undefined || session === entry.session)) {
      positions.delete(key);
    }
  }
}
