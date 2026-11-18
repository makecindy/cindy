import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownerScopedPath } from '../../dataOwnerPath';
import { readNativeHistoryBackupEndpoint, scheduleNativeHistoryBackup, scheduleNativeHistoryBackupCleanup } from '../controller/nativeHistoryBackup';
import { NATIVE_HISTORY_CHECKPOINT, type NativeHistoryEndpoint } from '../nativeHistoryTransfer';

const h = vi.hoisted(() => ({
  root: '', generation: 1, database: { userId: 'owner', client: { queryOne: vi.fn() } },
}));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ generation: h.generation, dataOwnerId: 'owner', mode: 'cloud' }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: () => h.database }));
vi.mock('../../userDataPath', () => ({ getUserDataDir: () => h.root }));

const sessionId = 'task';
const nativeId = '/isolated/native.jsonl';
const fromDevice = 'executor';
const token = '11111111-1111-4111-8111-111111111111';
const invokeRecord = { [NATIVE_HISTORY_CHECKPOINT]: { token, runId: 'run' } };
const input = { sessionId, nativeId, fromDevice };
const assertCurrent = () => {};
let db: Database.Database;
beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-backup-test-'));
  h.generation++;
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, sdk_session_id TEXT, agent_device_id TEXT, cleared_at INTEGER,
      active_turn_started_at INTEGER, status TEXT, agent_kind TEXT, remote_host_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT, rewind_at INTEGER,
      created_at INTEGER, agent_meta TEXT);
    INSERT INTO sessions VALUES ('task', '/isolated/native.jsonl', 'executor', NULL, 50, 'active', 'pi', NULL);
    INSERT INTO messages VALUES ('input', 'task', 'sent', 'user', NULL, 60, '{}');
    INSERT INTO messages VALUES ('reply', 'task', 'sealed', 'assistant', NULL, 70, '{"turnCompleted":true}');
  `);
  h.database.client.queryOne.mockImplementation(async (sql: string, params: unknown[]) => db.prepare(sql).get(...params));
});
afterEach(async () => {
  db.close();
  await fs.rm(h.root, { recursive: true, force: true });
});

function save(raw: string, expectedPrefix?: string) {
  const bytes = Buffer.from(raw);
  const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const prefix = expectedPrefix && { bytes: Buffer.byteLength(expectedPrefix), sha256: sha256(expectedPrefix) };
  let released!: () => void;
  const done = new Promise<void>(resolve => { released = resolve; });
  const source: NativeHistoryEndpoint = async command => {
    if (command.action === 'checkpoint-export') {
      expect(command.prefix).toEqual(prefix || undefined);
      return { id: token, offset: prefix ? prefix.bytes : 0, manifest: { bytes: bytes.length, nativeId, kind: 'pi', sha256: sha256(bytes) } };
    }
    if (command.action === 'read') {
      expect(command.offset).toBe(prefix ? prefix.bytes : 0);
      return { data: bytes.subarray(command.offset).toString('base64') };
    }
    if (command.action === 'release') released();
    return {};
  };
  scheduleNativeHistoryBackup(sessionId, invokeRecord, 'sealed', Promise.resolve(), (device, task) => {
    expect([device, task]).toEqual([fromDevice, sessionId]);
    return source;
  });
  return done;
}

// Unit, private isolated SQLite fixture exercises the production DB revision query.
// Existing transport tests cover temporary transfers only. A second turn or an
// older message removal must make a previously complete offline backup unusable.
it('reuses only the saved prefix on the next completed turn, then rejects and removes it after rewind', async () => {
  await save('first turn\n');
  db.exec(`
    UPDATE sessions SET active_turn_started_at = 80;
    INSERT INTO messages VALUES ('input2', 'task', 'sent2', 'user', NULL, 90, '{}');
  `);
  expect(await readNativeHistoryBackupEndpoint(input, assertCurrent)).toBeNull();
  db.exec(`UPDATE messages SET created_at = 100 WHERE id = 'reply'`);
  await save('first turn\nsecond turn\n', 'first turn\n');
  h.generation++;
  const saved = await readNativeHistoryBackupEndpoint(input, assertCurrent);
  expect(saved).not.toBeNull();
  const result = await saved!.endpoint({ action: 'export', kind: 'pi', nativeId }) as { id: string };
  const chunk = await saved!.endpoint({ action: 'read', id: result.id, offset: 0 });
  expect(chunk).toEqual({ data: Buffer.from('first turn\nsecond turn\n').toString('base64') });
  db.exec(`UPDATE messages SET rewind_at = 110 WHERE id = 'input'`);
  expect(await readNativeHistoryBackupEndpoint(input, assertCurrent)).toBeNull();
  scheduleNativeHistoryBackupCleanup(sessionId);
  const dir = ownerScopedPath(h.root, 'owner', 'native-history-backups');
  await vi.waitFor(async () => expect(await fs.readdir(dir)).toEqual([]));
});

it.each([
  "UPDATE sessions SET status = 'deleted'",
  "UPDATE sessions SET cleared_at = 110",
  "UPDATE sessions SET sdk_session_id = '/different.jsonl'",
])('invalidates the exact backup after %s even across an owner runtime restart', async mutation => {
  await save('first turn\n');
  db.exec(mutation);
  h.generation++;
  expect(await readNativeHistoryBackupEndpoint(input, assertCurrent)).toBeNull();
  scheduleNativeHistoryBackupCleanup(sessionId);
  const dir = ownerScopedPath(h.root, 'owner', 'native-history-backups');
  await vi.waitFor(async () => expect(await fs.readdir(dir)).toEqual([]));
});
