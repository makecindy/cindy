import { FILE_PEER_MAX_BYTES } from '@cindy/device-link';
import type { InvokeResultPayload } from '@cindy/device-link';
import type { PeerAttachment } from '@cindy/device-link';
type PeerUpload = (device: string, uri: string, metadata: Omit<PeerAttachment, 'ticket'>, signal?: AbortSignal) => Promise<string | null>;
let upload: PeerUpload | null = null;
let reset: ((device: string) => void) | null = null;
export function installPeerReset(value: (device: string) => void) {
  reset = value;
  return () => { if (reset === value) reset = null; };
}
export function resetMobilePeer(device: string) { reset?.(device); }
export function installPeerUpload(value: PeerUpload) {
  upload = value;
  return () => { if (upload === value) upload = null; };
}
export async function tryMobilePeerUpload(...args: Parameters<PeerUpload>) { return upload?.(...args) ?? null; }
type PeerInvoke = (device: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload | null>;
let invoke: PeerInvoke | null = null;
export function installPeerInvoke(value: PeerInvoke) {
  invoke = value;
  return () => { if (invoke === value) invoke = null; };
}
export async function tryMobilePeerInvoke(device: string, channel: string, args: unknown[]) {
  return invoke?.(device, channel, args) ?? null;
}
export interface LocalPeerMedia {
  ossKey: string;
  size: number;
  mimeType: string;
}
const localUris = new WeakMap<object, { uri: string; expiresAt: string }>();
const owned = new Map<
  string,
  { size: number; dispose(): void; timer: ReturnType<typeof setTimeout> }
>();
let ownedBytes = 0;
export const peerMediaUri = (value: object) => localUris.get(value)?.uri;
export const peerMediaExpiry = (value: object) =>
  localUris.get(value)?.expiresAt;
export function releasePeerMedia(uri: string) {
  const entry = owned.get(uri);
  if (!entry) return;
  owned.delete(uri);
  ownedBytes -= entry.size;
  clearTimeout(entry.timer);
  try {
    entry.dispose();
  } catch {
    /* The next process sweeps interrupted staging files. */
  }
}
export function clearPeerMedia() {
  for (const uri of owned.keys()) releasePeerMedia(uri);
}
/** Short-lived staging only. Consumers copy into their existing preview/cache ownership. */
export function recordPeerMedia(
  value: LocalPeerMedia,
  uri: string,
  dispose: () => void,
) {
  if (!canStagePeerMedia(value.size)) return false;
  const timer = setTimeout(() => releasePeerMedia(uri), 5 * 60_000);
  owned.set(uri, { size: value.size, dispose, timer });
  ownedBytes += value.size;
  localUris.set(value, {
    uri,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  return true;
}
type Download = (
  device: string,
  url: string,
  signal?: AbortSignal,
  trace?: number,
) => Promise<LocalPeerMedia | null>;
let download: Download | null = null;
export function installPeerFileDownload(value: Download) {
  download = value;
  return () => {
    if (download === value) download = null;
  };
}
export async function tryMobilePeerFile(
  device: string,
  url: string,
  signal?: AbortSignal,
  trace?: number,
) {
  return download?.(device, url, signal, trace) ?? null;
}

/** Budget includes retained files; reserve room for the consumer copy and keep 256 MiB free. */
export function canStagePeerMedia(size: number, availableBytes = Infinity): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= FILE_PEER_MAX_BYTES &&
    ownedBytes + size <= 4 * 1024 * 1024 * 1024 &&
    availableBytes >= 2 * size + 256 * 1024 * 1024;
}
