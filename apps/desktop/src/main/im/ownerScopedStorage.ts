/**
 * Owner-scoped private storage for direct third-party IM integrations.
 *
 * Legacy unscoped data is claimed by the first verified cloud owner that
 * reaches it. Local mode never scans or moves legacy data.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { IMHost, IMSecretReadResult } from '@cindy/im';

import {
  dataOwnerStorageKey,
  getActiveAppSession,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { hasLegacyOwnerNamespaceClaim } from '../ownerNamespaceMigration.js';
import { createLogger } from '../logger.js';

const log = createLogger('im/owner-scoped-storage');
const LEGACY_OWNER_MARKER = 'im-legacy-owner.json';
const SAFE_SECRET_NAME = /^[A-Za-z0-9_-]+$/;

type ImSecrets = IMHost['secrets'];

function safeStorageDir(): string {
  return path.join(app.getPath('userData'), 'safe-storage');
}

function legacyOwnerMarkerPath(): string {
  return path.join(app.getPath('userData'), LEGACY_OWNER_MARKER);
}

function currentVerifiedCloudOwnerKey(): string | null {
  const session = getActiveAppSession();
  if (session.mode !== 'cloud' || !session.dataOwnerId) return null;
  return dataOwnerStorageKey(session.dataOwnerId);
}

function readLegacyOwnerKey(): string | null | undefined {
  const marker = legacyOwnerMarkerPath();
  if (!fs.existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { ownerKey?: unknown };
    return typeof parsed.ownerKey === 'string' && parsed.ownerKey ? parsed.ownerKey : null;
  } catch (err) {
    log.warn('invalid IM legacy owner marker; refusing legacy migration', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function claimLegacyOwnership(ownerKey: string): boolean {
  // The global claim is the source of truth for the first cloud owner. IM
  // storage must not create an independent claim that lets a later owner
  // reinterpret files left in the shared legacy root.
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId || !hasLegacyOwnerNamespaceClaim(ownerId)) return false;
  const existing = readLegacyOwnerKey();
  if (existing !== undefined) return existing === ownerKey;

  const marker = legacyOwnerMarkerPath();
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ ownerKey }, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return readLegacyOwnerKey() === ownerKey;
    }
    log.warn('failed to claim IM legacy storage', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Move one legacy file/directory into the current owner namespace.
 * Existing scoped data wins conflicts; non-conflicting directory entries are
 * merged before the legacy directory is removed.
 */
export function claimLegacyImPath(legacyPath: string, scopedPath: string): boolean {
  const ownerKey = currentVerifiedCloudOwnerKey();
  // Resolve the session before touching the legacy path. Local/signed-out
  // sessions must not even probe whether old account data exists.
  if (!ownerKey) return false;
  if (!fs.existsSync(legacyPath) || !claimLegacyOwnership(ownerKey)) return false;

  try {
    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    if (!fs.existsSync(scopedPath)) {
      fs.renameSync(legacyPath, scopedPath);
    } else if (fs.statSync(legacyPath).isDirectory()) {
      fs.cpSync(legacyPath, scopedPath, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      fs.rmSync(legacyPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(legacyPath);
    }
    log.info('claimed legacy IM storage for cloud owner', {
      ownerKey,
      legacyPath,
      scopedPath,
    });
    return true;
  } catch (err) {
    log.warn('failed to migrate legacy IM storage', {
      ownerKey,
      legacyPath,
      scopedPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Resolve an IM-private path under the active data owner. */
export function ownerScopedImUserDataPath(...parts: string[]): string {
  return ownerScopedUserDataPath(...parts);
}

function scopedSecretPath(name: string): string | null {
  if (!SAFE_SECRET_NAME.test(name)) return null;
  const session = getActiveAppSession();
  if (!session.dataOwnerId) return null;
  const ownerKey = dataOwnerStorageKey(session.dataOwnerId);
  return path.join(safeStorageDir(), `im_owner_${ownerKey}_${name}.enc`);
}

function prepareSecretPath(name: string): string | null {
  const scoped = scopedSecretPath(name);
  if (!scoped) return null;
  claimLegacyImPath(path.join(safeStorageDir(), `${name}.enc`), scoped);
  return scoped;
}

/** Read a secret without collapsing a missing file and an I/O/decryption failure. */
function readSecretResult(name: string): IMSecretReadResult {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { kind: 'error' };
    const target = prepareSecretPath(name);
    if (!target) return { kind: 'error' };
    const encrypted = fs.readFileSync(target, 'utf-8');
    return {
      kind: 'value',
      value: safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error' };
  }
}

/** @cindy/im secret adapter whose logical keys follow the active data owner. */
export const ownerScopedImSecrets: ImSecrets = {
  isAvailable: () => safeStorage.isEncryptionAvailable() && scopedSecretPath('probe') !== null,
  write(name, plaintext) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const target = prepareSecretPath(name);
      if (!target) return false;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, safeStorage.encryptString(plaintext).toString('base64'), 'utf-8');
      return true;
    } catch {
      return false;
    }
  },
  read(name) {
    const result = readSecretResult(name);
    return result.kind === 'value' ? result.value : null;
  },
  readResult: readSecretResult,
  remove(name) {
    try {
      const target = prepareSecretPath(name);
      if (target) fs.unlinkSync(target);
    } catch {
      // Missing credentials are already removed.
    }
  },
};

export const __testing = {
  legacyOwnerMarkerPath,
  scopedSecretPath,
};
