/**
 * Host API token: one random bearer per profile, stored 0600 next to the profile.
 *
 * Never put it in a URL, log line, or HTTP body. Clients read the file (same OS
 * user) or receive it once from an explicit pairing step in a later stage.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_FILE = 'host-api-token';

export function readOrCreateApiToken(userDataDir) {
  const file = path.join(userDataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  return token;
}

/** Constant-time comparison; a missing header never matches. */
export function isAuthorized(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || !expected) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}
