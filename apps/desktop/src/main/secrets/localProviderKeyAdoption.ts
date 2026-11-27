import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { customProviderSecretStorageKey } from '../../shared/providerSecrets.js';
import { dataOwnerStorageKey } from '../dataOwnerPath.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import { readPublishedProviderKeyBatch } from '../localDb/modelVisibilityAdoption.js';
import { createLogger } from '../logger.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from '../profile/profileRegistryModel.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';

const log = createLogger('localProviderKeyAdoption');
const runtimes = ['pi', 'codex', 'claude-code'] as const;
const columns = 'id, runtimes, auth, created_at, updated_at';
type Row = {
  id: string;
  runtimes: string;
  auth: string | null;
  created_at: number;
  updated_at: number;
};

function rowDigest(row: Row): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function stage(target: string, owner: string, batch: string): string {
  return path.join(
    path.dirname(target),
    'safe-storage',
    `.provider-key-adoption-${dataOwnerStorageKey(owner)}-${batch}`,
  );
}

function keyFile(target: string, owner: string, key: string): string {
  return path.join(
    path.dirname(target),
    'safe-storage',
    `owner_${dataOwnerStorageKey(owner)}_${key}.enc`,
  );
}

function ordinaryDirectory(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory() === true;
}

// The provider row and its ciphertext become one private snapshot before the
// database is published. Only the winning publication receipt identifies this batch.
export function freezeLocalProviderKeys(
  snapshot: string,
  target: string,
  owner: string,
  batch: string,
): string | undefined {
  if (!ordinaryDirectory(path.join(path.dirname(target), 'safe-storage'))) return;
  const directory = stage(target, owner, batch);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && ordinaryDirectory(directory))
      return batch;
    throw error;
  }
  const db = createBetterSqliteDatabase(snapshot, { readonly: true, fileMustExist: true });
  let frozen = false;
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_providers'")
        .get()
    )
      return;
    for (const row of db
      .prepare(`SELECT ${columns} FROM custom_providers`)
      .iterate() as Iterable<Row>) {
      if (typeof row.id !== 'string' || !/^[a-z0-9_-]+$/.test(row.id)) continue;
      let config;
      try {
        if (row.auth !== null && JSON.parse(row.auth)?.method !== 'apiKey') continue;
        config = JSON.parse(row.runtimes);
      } catch {
        continue;
      }
      const group = path.join(directory, rowDigest(row));
      for (const runtime of runtimes) {
        if (typeof config?.[runtime]?.baseUrl !== 'string' || !config[runtime].baseUrl.trim())
          continue;
        const key = customProviderSecretStorageKey(row.id, runtime);
        const source = keyFile(target, LOCAL_PROFILE_DATA_OWNER_ID, key);
        const slot = path.join(group, key);
        try {
          if (fs.lstatSync(keyFile(target, owner, key), { throwIfNoEntry: false })) continue;
          const stat = fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
          if (!stat?.isFile() || stat.size > 1024n * 1024n || stat.size === 0n) continue;
          fs.mkdirSync(group, { recursive: true, mode: 0o700 });
          const temp = slot + '.tmp';
          let bytes: Buffer | null;
          try {
            bytes = readBoundedFileNoFollowSync(source, 1024 * 1024);
          } catch {
            // Freeze through an independent filesystem operation if reading the
            // source failed. Pin the checked inode before copying; a path swap
            // cannot turn a symlink or another owner's file into the snapshot.
            const anchor = slot + '.anchor';
            fs.linkSync(source, anchor);
            try {
              const pinned = fs.lstatSync(anchor, { bigint: true });
              if (
                !pinned.isFile() ||
                pinned.dev !== stat.dev ||
                pinned.ino !== stat.ino ||
                pinned.size !== stat.size ||
                pinned.mtimeNs !== stat.mtimeNs
              )
                continue;
              fs.copyFileSync(anchor, temp, fs.constants.COPYFILE_EXCL);
              const after = fs.lstatSync(anchor, { bigint: true });
              if (after.ctimeNs !== pinned.ctimeNs || after.size !== pinned.size) continue;
              const fd = fs.openSync(temp, 'r+');
              try {
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              fs.renameSync(temp, slot);
              frozen = true;
            } finally {
              fs.unlinkSync(anchor);
            }
            continue;
          }
          if (!bytes?.length) continue;
          try {
            fs.writeFileSync(temp, bytes, { mode: 0o600, flush: true });
            fs.renameSync(temp, slot);
          } catch {
            // A failed ciphertext copy can still leave a small, durable proof.
            // Recovery accepts only bytes with this originally observed digest.
            fs.writeFileSync(slot + '.sha256', createHash('sha256').update(bytes).digest('hex'), {
              mode: 0o600,
              flush: true,
            });
          }
          frozen = true;
        } catch {
          log.warn('could not freeze a custom provider runtime key');
        }
      }
    }
    return frozen ? batch : undefined;
  } finally {
    db.close();
    if (!frozen) fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Called only by the holder that lost the no-replace database publication.
export function discardUnpublishedProviderKeys(target: string, owner: string, batch: string): void {
  fs.rmSync(stage(target, owner, batch), { recursive: true, force: true });
}

export function hasPendingLocalProviderKeys(target: string, owner: string): boolean {
  const batch = readPublishedProviderKeyBatch(target);
  return !!batch && ordinaryDirectory(stage(target, owner, batch));
}

export function finishLocalProviderKeys(target: string, owner: string): void {
  if (!ordinaryDirectory(path.join(path.dirname(target), 'safe-storage'))) return;
  const batch = readPublishedProviderKeyBatch(target);
  if (!batch) return;
  const directory = stage(target, owner, batch);
  if (!ordinaryDirectory(directory)) return;
  const db = createBetterSqliteDatabase(target, { readonly: true, fileMustExist: true });
  try {
    const get = db.prepare(`SELECT ${columns} FROM custom_providers WHERE id = ?`);
    for (const fingerprint of fs.readdirSync(directory)) {
      const group = path.join(directory, fingerprint);
      if (!/^[0-9a-f]{64}$/.test(fingerprint) || !ordinaryDirectory(group)) continue;
      for (const name of fs.readdirSync(group)) {
        const digestOnly = name.endsWith('.sha256');
        const key = digestOnly ? name.slice(0, -7) : name;
        const match = /^provider_key_([a-z0-9_-]+)_(pi|codex|claude-code)$/.exec(key);
        if (!match) continue;
        const slot = path.join(group, key);
        const proof = path.join(group, name);
        const destination = keyFile(target, owner, key);
        const publishing = slot + '.publishing';
        try {
          const row = get.get(match[1]) as Row | undefined;
          if (
            !row ||
            rowDigest(row) !== fingerprint ||
            fs.lstatSync(destination, { throwIfNoEntry: false })
          ) {
            fs.unlinkSync(proof);
            continue;
          }
          if (digestOnly) {
            const expected = readBoundedFileNoFollowSync(proof, 64)?.toString();
            const original = readBoundedFileNoFollowSync(
              keyFile(target, LOCAL_PROFILE_DATA_OWNER_ID, key),
              1024 * 1024,
            );
            if (!original || createHash('sha256').update(original).digest('hex') !== expected) {
              fs.unlinkSync(proof);
              continue;
            }
            fs.writeFileSync(slot + '.tmp', original, { mode: 0o600, flush: true });
            // Never leave two active authorizations for the same slot across a crash.
            const consumed = slot + '.consumed';
            fs.renameSync(proof, consumed);
            try {
              fs.renameSync(slot + '.tmp', slot);
            } catch (error) {
              fs.renameSync(consumed, proof);
              throw error;
            }
            fs.unlinkSync(consumed);
          }
          const bytes = readBoundedFileNoFollowSync(slot, 1024 * 1024);
          if (!bytes?.length) continue;
          // Retire the authorization before publishing. On a crash an ambiguous
          // slot cannot recreate a key subsequently removed by the account.
          fs.renameSync(slot, publishing);
          try {
            fs.linkSync(publishing, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
              fs.renameSync(publishing, slot);
              continue;
            }
          }
          fs.unlinkSync(publishing);
        } catch {
          log.warn('custom provider runtime key adoption deferred');
        }
      }
      for (const name of fs.readdirSync(group)) {
        if (
          /^provider_key_[a-z0-9_-]+_(pi|codex|claude-code)\.(tmp|publishing|anchor|consumed)$/.test(
            name,
          )
        )
          fs.unlinkSync(path.join(group, name));
      }
      if (!fs.readdirSync(group).length) fs.rmdirSync(group);
    }
    if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
  } finally {
    db.close();
  }
}
