/** A settings-only check of a transient user credential; no raw response projection. */
export interface GhostSecretCheckDecl {
  url: string;
  bodyFormat: string;
  validPath: string;
  validValue: string | boolean;
  expiresAtPath?: string;
  expiresAtFormat?: 'iso' | 'unix-ms' | 'unix-seconds';
}

export function parseGhostSecretCheck(value: unknown, hostAllowed: (host: string) => boolean): GhostSecretCheckDecl | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const path = (p: unknown): p is string => typeof p === 'string' && p.length <= 128 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(p)
    && !p.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
  if (typeof v.url !== 'string' || v.url.length > 2048) return null;
  try {
    const url = new URL(v.url);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hostAllowed(url.hostname)) return null;
  } catch { return null; }
  if (typeof v.bodyFormat !== 'string' || v.bodyFormat.length > 4096 || v.bodyFormat.split('{value}').length !== 2) return null;
  try {
    const body = JSON.parse(v.bodyFormat.replace('{value}', 'check-value'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  } catch { return null; }
  if (!path(v.validPath) || !(typeof v.validValue === 'boolean' || (typeof v.validValue === 'string' && v.validValue.length > 0 && v.validValue.length <= 64))) return null;
  if (v.expiresAtPath !== undefined && !path(v.expiresAtPath)) return null;
  if (v.expiresAtFormat !== undefined && (!v.expiresAtPath || !['iso', 'unix-ms', 'unix-seconds'].includes(String(v.expiresAtFormat)))) return null;
  return { url: v.url, bodyFormat: v.bodyFormat, validPath: v.validPath, validValue: v.validValue,
    ...(v.expiresAtPath !== undefined ? { expiresAtPath: v.expiresAtPath as string } : {}),
    ...(v.expiresAtFormat !== undefined ? { expiresAtFormat: v.expiresAtFormat as GhostSecretCheckDecl['expiresAtFormat'] } : {}) };
}
