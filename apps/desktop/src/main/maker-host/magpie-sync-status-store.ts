/**
 * Persisted Magpie sync timestamps, scoped by local data owner.
 *
 * Only coarse status is stored: timestamps, a bounded error code and an HTTP
 * status. Credentials, URLs, response bodies and model lists never enter this
 * file. A missing or unreadable file degrades to "never synchronized".
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import type {
  MagpieSyncStatusState,
  MagpieSyncStatusStore,
} from './magpie-model-sync.js';

const FILE_NAME = 'magpie-model-sync.json';
const VERSION = 1;
const MAX_OWNERS = 8;
const MAX_PROVIDERS_PER_OWNER = 64;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface StoredFile {
  version: 1;
  owners: Record<string, Record<string, MagpieSyncStatusState>>;
}

function emptyFile(): StoredFile {
  return { version: VERSION, owners: {} };
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sanitizeFailure(value: unknown): MagpieSyncStatusState['failure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validTimestamp(record.at) || typeof record.code !== 'string' || !CODE_RE.test(record.code)) {
    return null;
  }
  const status = typeof record.status === 'number' && Number.isSafeInteger(record.status)
    && record.status >= 100 && record.status <= 599
    ? record.status
    : undefined;
  return { code: record.code, at: record.at, ...(status !== undefined ? { status } : {}) };
}

function sanitizeState(value: unknown): MagpieSyncStatusState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const lastAttemptAt = validTimestamp(record.lastAttemptAt) ? record.lastAttemptAt : null;
  const lastSuccessAt = validTimestamp(record.lastSuccessAt) ? record.lastSuccessAt : null;
  return { lastAttemptAt, lastSuccessAt, failure: sanitizeFailure(record.failure) };
}

function sanitizeFile(value: unknown): StoredFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyFile();
  const owners = (value as { owners?: unknown }).owners;
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) return emptyFile();
  const result: StoredFile = emptyFile();
  for (const [owner, providers] of Object.entries(owners as Record<string, unknown>)) {
    if (!owner || owner.length > 256 || !providers || typeof providers !== 'object' || Array.isArray(providers)) continue;
    const entries: Record<string, MagpieSyncStatusState> = {};
    for (const [providerId, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!providerId || providerId.length > 128) continue;
      const state = sanitizeState(raw);
      if (state) entries[providerId] = state;
    }
    if (Object.keys(entries).length > 0) result.owners[owner] = entries;
  }
  return result;
}

export interface MagpieSyncStatusStoreOptions {
  filePath?: () => string;
  ownerKey?: () => string;
}

export function createMagpieSyncStatusStore(
  options: MagpieSyncStatusStoreOptions = {},
): MagpieSyncStatusStore {
  const filePath = options.filePath ?? (() => path.join(app.getPath('userData'), FILE_NAME));
  const ownerKey = options.ownerKey ?? (() => getCurrentDbClientUserId() ?? 'anonymous');

  function readFile(): StoredFile {
    try {
      return sanitizeFile(JSON.parse(fs.readFileSync(filePath(), 'utf-8')));
    } catch {
      return emptyFile();
    }
  }

  function writeFile(data: StoredFile): void {
    const target = filePath();
    const directory = path.dirname(target);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data), 'utf-8');
      fs.renameSync(temporary, target);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* best effort */
      }
    }
  }

  return {
    read(providerId) {
      const data = readFile();
      return data.owners[ownerKey()]?.[providerId];
    },
    write(providerId, state) {
      const data = readFile();
      const owner = ownerKey();
      const providers = { ...(data.owners[owner] ?? {}), [providerId]: state };
      const trimmed = Object.fromEntries(
        Object.entries(providers)
          .sort(([, left], [, right]) => (right.lastAttemptAt ?? 0) - (left.lastAttemptAt ?? 0))
          .slice(0, MAX_PROVIDERS_PER_OWNER),
      );
      const owners = Object.fromEntries(
        Object.entries({ ...data.owners, [owner]: trimmed })
          .sort(([, left], [, right]) => {
            const newest = (entries: Record<string, MagpieSyncStatusState>) =>
              Math.max(0, ...Object.values(entries).map((entry) => entry.lastAttemptAt ?? 0));
            return newest(right) - newest(left);
          })
          .slice(0, MAX_OWNERS),
      );
      writeFile({ version: VERSION, owners });
    },
  };
}
