/** Lightweight boundary for V1 attachment callers. Native implementation loads
 * only for an authenticated V2 destination; old binaries keep their adapter. */
interface MediaUpload {
  deviceId?: string; size: number; contentType: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  signal?: AbortSignal; assertCurrent?(): void;
}
let backend: { available(device?: string): boolean; requiresEncryption(): boolean;
  upload(options: MediaUpload): Promise<{ key: string; sha256: string } | null> } | null = null;
export function installMobileAgentNetMedia(value: NonNullable<typeof backend>): () => void {
  backend = value; return () => { if (backend === value) backend = null; };
}
export const canUploadEncryptedMobileMedia = (device?: string): boolean => backend?.available(device) === true;
export function assertMobileLegacyMediaAllowed(): void {
  if (backend?.requiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_MEDIA_REQUIRED');
}
export async function tryUploadEncryptedMobileMedia(options: MediaUpload) {
  const selected = backend;
  if (selected?.available(options.deviceId)) {
    const result = await selected.upload(options);
    if (!result) throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
    return result;
  }
  assertMobileLegacyMediaAllowed(); return null;
}
