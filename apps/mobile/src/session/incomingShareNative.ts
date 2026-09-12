import { requireOptionalNativeModule } from 'expo-modules-core';
import type { SharePayload } from 'expo-sharing';

const native = requireOptionalNativeModule<{
  readSnapshot(): string | null;
  clearSnapshot(expected: string): boolean;
}>('CindyIncomingShare');
const snapshots = new WeakMap<SharePayload[], string>();

export function getSharedPayloads(): SharePayload[] {
  const snapshot = native?.readSnapshot();
  if (!snapshot) return [];
  const payloads: SharePayload[] = JSON.parse(snapshot).map((item: { value: string; type: SharePayload['shareType']; mimeType?: string }) => ({
    value: item.value, shareType: item.type, mimeType: item.mimeType,
  }));
  snapshots.set(payloads, snapshot);
  return payloads;
}

export function clearSharedPayloads(expected: SharePayload[]): void {
  const snapshot = snapshots.get(expected);
  if (snapshot !== undefined) native?.clearSnapshot(snapshot);
}
