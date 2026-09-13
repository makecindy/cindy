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
  if (ownedBytes + value.size > 256 * 1024 * 1024) return false;
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
) {
  return download?.(device, url, signal) ?? null;
}
