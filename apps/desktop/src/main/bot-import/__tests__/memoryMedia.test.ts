import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../../localDb/schema';
const { default: migration0071 } = await import('../../../../drizzle/scripts/0071_bright_ultron') as unknown as { default: { run(db: Database.Database): void } };
import type { LedgerDb } from '../../cindy-media/ledger';

let root = '';
let raw: Database.Database;
let db: LedgerDb;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'cloud:import-owner:1',
  dataOwnerStorageKey: () => 'a'.repeat(20),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'import-owner', generation: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: db }) }));
const { importMemoryMedia, removeImportedMemoryMedia } = await import('../memoryMedia.js');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-memory-media-test-'));
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) if (statement.trim()) raw.exec(statement);
  migration0071.run(raw);
  db = drizzle(raw, { schema }) as unknown as LedgerDb;
});
afterEach(() => { raw.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('keeps original image bytes, retries without duplicate refs, and removes only the deleted companion reference', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5l0AAAAASUVORK5CYII=', 'base64');
  const url = await importMemoryMedia('first', 'first-chat', bytes, () => {});
  expect(await importMemoryMedia('first', 'first-chat', bytes, () => {})).toBe(url);
  expect(await importMemoryMedia('second', 'second-chat', bytes, () => {})).toBe(url);
  const [blob] = db.select().from(schema.mediaBlobs).all();
  expect(blob.isCache).toBe(false);
  const hash = url.match(/blobs\/(.+)\.png/)![1];
  expect(fs.readFileSync(path.join(root, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}.png`))).toEqual(bytes);
  expect(db.select().from(schema.mediaRefs).all()).toHaveLength(2);
  await removeImportedMemoryMedia('first', () => {});
  const refs = db.select().from(schema.mediaRefs).all();
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ refId: 'companion-memory:second', originSessionId: 'second-chat' });
});

it('reports unsupported attachments and rejects writes after account changes', async () => {
  await expect(importMemoryMedia('first', 'chat', Buffer.from('unknown binary'), () => {})).rejects.toThrow('MEMORY_ATTACHMENT_UNSUPPORTED');
  await expect(importMemoryMedia('first', 'chat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), () => { throw new Error('OWNER_CHANGED'); })).rejects.toThrow('OWNER_CHANGED');
  expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(0);
});
