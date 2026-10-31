/**
 * A group avatar through the account's public asset store, the same contract as Desktop's
 * `ossPublicUpload.ts`: presign with the account token, PUT the bytes with exactly the signed
 * headers, and only then hand the public URL to Chat Server. The signed URL stays in memory.
 */
export const GROUP_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** Desktop rejects larger avatars before uploading; the phone resizes to this edge. */
export const GROUP_AVATAR_EDGE_PX = 512;

export interface PublicAvatarUploadDeps {
  /** The account's authenticated fetch against the object-store API. */
  presign(body: { scene: 'avatar'; contentType: string; size: number }): Promise<unknown>;
  put(url: string, uri: string, headers: Record<string, string>): Promise<void>;
  current(): boolean;
}

export async function uploadPublicAvatar(deps: PublicAvatarUploadDeps, file: { uri: string; size: number; mimeType: 'image/jpeg' | 'image/png' }) {
  const check = () => { if (!deps.current()) throw new Error('OWNER_CHANGED'); };
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > GROUP_AVATAR_MAX_BYTES) throw new Error('AVATAR_TOO_LARGE');
  check();
  const presign = await deps.presign({ scene: 'avatar', contentType: file.mimeType, size: file.size });
  check();
  const record = presign && typeof presign === 'object' ? presign as Record<string, unknown> : {};
  const { putUrl, publicUrl } = record;
  if (typeof putUrl !== 'string' || !putUrl.startsWith('https://') || typeof publicUrl !== 'string' || !publicUrl.startsWith('https://')) {
    throw new Error('PROFILE_AVATAR_UPLOAD_FAILED');
  }
  const headers: Record<string, string> = {};
  if (record.headers && typeof record.headers === 'object') {
    for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) if (typeof value === 'string') headers[name] = value;
  }
  await deps.put(putUrl, file.uri, headers);
  check();
  return publicUrl;
}
