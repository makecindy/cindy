import { GHOST_DIR_DEPOSIT_TOKEN_RE, GHOST_FETCH_BODY_MAX_BYTES } from '../../shared/ghost.js';
import type { GhostJsonFileUpload } from '../../shared/ghost.js';
import type { TakenDirDeposit } from './dirDeposit.js';

/** Bounded Host-only assembly. Neither bytes nor filesystem paths cross the pipe. */
export const JSON_FILE_UPLOAD_LIMITS = Object.freeze({
  version: 1,
  maxFiles: 10,
  maxTotalBytes: 2 * 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
});
type JsonObject = Record<string, unknown> | unknown[];
type Target = { parent: JsonObject; key: string | number; path: string };
export interface PreparedJsonFileUpload {
  token: string;
  document: JsonObject;
  targets: Target[];
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Resolve existing null placeholders only; no prototype traversal or object creation. */
export function prepareJsonFileUpload(value: unknown): PreparedJsonFileUpload | null {
  if (!record(value) || Object.keys(value).some((k) => !['token', 'json', 'files'].includes(k)))
    return null;
  const u = value as unknown as GhostJsonFileUpload;
  if (
    typeof u.token !== 'string' ||
    !GHOST_DIR_DEPOSIT_TOKEN_RE.test(u.token) ||
    typeof u.json !== 'string' ||
    Buffer.byteLength(u.json) > GHOST_FETCH_BODY_MAX_BYTES ||
    !Array.isArray(u.files) ||
    u.files.length < 1 ||
    u.files.length > JSON_FILE_UPLOAD_LIMITS.maxFiles
  )
    return null;
  let document: unknown;
  try {
    document = JSON.parse(u.json);
  } catch {
    return null;
  }
  if (!record(document)) return null;
  const paths = new Set<string>(),
    destinations = new Set<string>(),
    targets: Target[] = [];
  for (const f of u.files) {
    if (
      !record(f) ||
      Object.keys(f).some((k) => !['path', 'target'].includes(k)) ||
      typeof f.path !== 'string' ||
      f.path.length === 0 ||
      f.path.length > 2048 ||
      f.path.split('/').some((p) => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p)) ||
      !Array.isArray(f.target) ||
      f.target.length < 1 ||
      f.target.length > 16 ||
      paths.has(f.path)
    )
      return null;
    let parent: unknown = document;
    for (let i = 0; i < f.target.length; i++) {
      const key: unknown = f.target[i];
      if (
        (!record(parent) && !Array.isArray(parent)) ||
        (Array.isArray(parent)
          ? !Number.isSafeInteger(key) || Number(key) < 0
          : typeof key !== 'string') ||
        ['__proto__', 'prototype', 'constructor'].includes(String(key)) ||
        !Object.hasOwn(parent, String(key))
      )
        return null;
      const child: unknown = (parent as Record<string, unknown>)[String(key)];
      if (i === f.target.length - 1) {
        const identity = JSON.stringify(f.target);
        if (child !== null || destinations.has(identity)) return null;
        destinations.add(identity);
        targets.push({ parent, key: key as string | number, path: f.path });
      } else parent = child;
    }
    paths.add(f.path);
  }
  return { token: u.token, document, targets };
}

/** Consume the existing one-use ticket after network/account authorization. */
export async function buildJsonFileUpload(
  prepared: PreparedJsonFileUpload,
  deposit: TakenDirDeposit | null,
  assertCurrent: () => void,
): Promise<string> {
  if (!deposit) throw new Error('文件交接票据已失效，请重新交付文件。');
  const { maxTotalBytes, maxRequestBytes } = JSON_FILE_UPLOAD_LIMITS;
  const chosen = prepared.targets.map((t) => deposit.files.find((f) => f.relPath === t.path));
  if (chosen.some((f) => !f)) throw new Error('附件不在本次交付的文件中，请重新选择。');
  const files = chosen as TakenDirDeposit['files'];
  let total = 0;
  for (const f of files) {
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > maxTotalBytes - total) {
      throw new Error('附件总大小超过 2 MiB，请缩小文件后重新交付。');
    }
    total += f.size;
  }
  total = 0;
  for (let i = 0; i < files.length; i++) {
    assertCurrent();
    let bytes: Uint8Array;
    try {
      bytes = await files[i].read(maxTotalBytes - total);
    } catch {
      throw new Error('附件无法完整读取或已变化，请重新交付文件。');
    }
    assertCurrent();
    if (bytes.byteLength !== files[i].size || bytes.byteLength > maxTotalBytes - total) {
      throw new Error('附件大小在交付后变化，请重新交付文件。');
    }
    total += bytes.byteLength;
    const t = prepared.targets[i];
    (t.parent as Record<string, unknown>)[String(t.key)] = Buffer.from(bytes).toString('base64');
  }
  const body = JSON.stringify(prepared.document);
  if (Buffer.byteLength(body) > maxRequestBytes)
    throw new Error('附件请求超过 4 MiB，请缩小文件或正文。');
  return body;
}
