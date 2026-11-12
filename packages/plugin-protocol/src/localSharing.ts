import { httpsUrl, isoDate, object, PluginProtocolError, sha256, string } from './internal/parse.js';
import { parsePluginObjectUrl, type PluginObjectUrlOptions } from './deliveryObjectUrl.js';

export const LOCAL_PLUGIN_SHARE_MAX_BYTES = 128 * 1024 * 1024;

/** Identical framing on disk and in a verified archive, without ZIP compression. */
export function encodeLocalPluginShareContent(
  files: readonly { path: string; sha256: string; unixPermissions: number }[],
  emptyDirectories: readonly string[],
): string {
  const entries = files.map(file => [file.path, file.sha256, 0o100000 | (file.unixPermissions & 0o777)] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify(['cindy-local-share-content-v1', emptyDirectories.slice().sort(), entries]);
}

export const isLocalPluginSnapshotId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);

export interface LocalPluginShareSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  ghostId: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  sha256: string;
  contentSha256?: string;
  sizeBytes: number;
  createdAt: string;
  icon: string | null;
}

export interface LocalPluginShareUpload {
  snapshotId: string;
  status: 'uploading' | 'validating' | 'ready' | 'failed' | 'expired';
  putUrl?: string;
  headers?: Record<string, string>;
  expiresAt: string;
  snapshot?: LocalPluginShareSnapshot;
}

export type LocalPluginShareCheck =
  | { status: 'upload_required'; contentSha256: string }
  | { status: 'ready'; contentSha256: string; snapshot: LocalPluginShareSnapshot };

export function parseCheckLocalPluginShare(value: unknown) {
  const row = object(value, 'localShareCheck');
  if (Object.keys(row).some(key => !['operationId', 'contentSha256'].includes(key)))
    throw new PluginProtocolError('Unknown local share check field');
  const operationId = string(row.operationId, 'operationId', 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) throw new PluginProtocolError('Invalid operationId');
  return { operationId, contentSha256: sha256(row.contentSha256, 'contentSha256') };
}

export function parseLocalPluginShareCheck(value: unknown): LocalPluginShareCheck {
  const row = object(value, 'localShareCheck');
  const contentSha256 = sha256(row.contentSha256, 'contentSha256');
  if (row.status === 'upload_required') return { status: 'upload_required', contentSha256 };
  if (row.status !== 'ready') throw new PluginProtocolError('Invalid local share check status');
  const snapshot = parseLocalPluginShareSnapshot(row.snapshot);
  if (snapshot.contentSha256 !== contentSha256) throw new PluginProtocolError('Content identity changed');
  return { status: 'ready', contentSha256, snapshot };
}

export function parsePrepareLocalPluginShare(value: unknown) {
  const row = object(value, 'localShare');
  if (Object.keys(row).some(key => !['operationId', 'sha256', 'sizeBytes', 'contentSha256'].includes(key)))
    throw new PluginProtocolError('Unknown local share field');
  const operationId = string(row.operationId, 'operationId', 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) throw new PluginProtocolError('Invalid operationId');
  if (!Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) <= 0 || (row.sizeBytes as number) > LOCAL_PLUGIN_SHARE_MAX_BYTES)
    throw new PluginProtocolError('Invalid local package size');
  return { operationId, sha256: sha256(row.sha256, 'sha256'), sizeBytes: row.sizeBytes as number,
    ...(row.contentSha256 !== undefined ? { contentSha256: sha256(row.contentSha256, 'contentSha256') } : {}) };
}

export function parseLocalPluginShareSnapshot(value: unknown): LocalPluginShareSnapshot {
  const row = object(value, 'localShare');
  if (row.schemaVersion !== 1 || !isLocalPluginSnapshotId(row.snapshotId)) throw new PluginProtocolError('Invalid local share snapshot');
  if (!Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) <= 0 || (row.sizeBytes as number) > LOCAL_PLUGIN_SHARE_MAX_BYTES)
    throw new PluginProtocolError('Invalid local package size');
  const nullable = (value: unknown, name: string, max: number) => value === null || value === '' ? null : string(value, name, max);
  const icon = row.icon === null ? null : string(row.icon, 'icon', Math.ceil(512 * 1024 / 3) * 4 + 32);
  if (icon !== null && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)) throw new PluginProtocolError('Invalid snapshot icon');
  return {
    schemaVersion: 1, snapshotId: row.snapshotId, ghostId: string(row.ghostId, 'ghostId', 128),
    name: string(row.name, 'name', 256), description: nullable(row.description, 'description', 10_000),
    author: nullable(row.author, 'author', 256), version: string(row.version, 'version', 128),
    sha256: sha256(row.sha256, 'sha256'), sizeBytes: row.sizeBytes as number,
    ...(row.contentSha256 !== undefined ? { contentSha256: sha256(row.contentSha256, 'contentSha256') } : {}),
    createdAt: isoDate(row.createdAt, 'createdAt'), icon,
  };
}

export function parseLocalPluginShareUpload(value: unknown, options?: PluginObjectUrlOptions): LocalPluginShareUpload {
  const row = object(value, 'upload');
  if (!isLocalPluginSnapshotId(row.snapshotId) || !['uploading', 'validating', 'ready', 'failed', 'expired'].includes(String(row.status)))
    throw new PluginProtocolError('Invalid local share upload');
  const result: LocalPluginShareUpload = {
    snapshotId: row.snapshotId, status: row.status as LocalPluginShareUpload['status'], expiresAt: isoDate(row.expiresAt, 'expiresAt'),
  };
  if (row.status === 'ready') {
    result.snapshot = parseLocalPluginShareSnapshot(row.snapshot);
    if (result.snapshot.snapshotId !== result.snapshotId) throw new PluginProtocolError('Snapshot identity changed');
  }
  if (row.putUrl !== undefined) {
    if (row.status !== 'uploading') throw new PluginProtocolError('Unexpected upload ticket');
    const url = new URL(string(row.putUrl, 'putUrl', 8192));
    const development = url.protocol === 'http:' && url.origin === options?.developmentObjectOrigin &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/dev-local/member-upload';
    if (url.username || url.password || url.hash || (!development && url.protocol !== 'https:')) throw new PluginProtocolError('Invalid upload URL');
    result.putUrl = development ? row.putUrl as string : httpsUrl(row.putUrl, 'putUrl');
    const headers = object(row.headers, 'headers');
    const entries = Object.entries(headers);
    if (entries.length !== 2 || entries.some(([key, value]) =>
      !['content-type', 'x-oss-forbid-overwrite'].includes(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value)))
      throw new PluginProtocolError('Invalid upload headers');
    const normalized = Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]));
    if (normalized['content-type'] !== 'application/octet-stream' || normalized['x-oss-forbid-overwrite'] !== 'true')
      throw new PluginProtocolError('Invalid immutable upload headers');
    result.headers = headers as Record<string, string>;
  }
  return result;
}

export function parseLocalPluginShareDownload(value: unknown, options?: PluginObjectUrlOptions) {
  const row = object(value, 'download');
  return { snapshot: parseLocalPluginShareSnapshot(row), url: parsePluginObjectUrl(row.url, 'url', options), expiresAt: isoDate(row.expiresAt, 'expiresAt') };
}
