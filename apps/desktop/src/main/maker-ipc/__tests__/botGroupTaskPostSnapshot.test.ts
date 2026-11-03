import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareBotGroupTaskPost, type BotGroupTaskPostSnapshot } from '../botGroupTaskPostSnapshot.js';

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: h.db }) }));
const scope = { endpoint: 'https://chat.example', selfId: 'owner', roomId: 'room', clientId: 'task:started' };
const payload = (text: string): BotGroupTaskPostSnapshot => ({ actorId: 'bot', messages: [
  { operationId: scope.clientId, content: [{ type: 'text', text }, { type: 'file', mediaId: 'saved-media' }], mentions: [] },
] });

describe('durable group task payloads', () => {
  let sqlite: Database.Database;
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cindy-task-post-'));
    dbPath = path.join(dir, 'task.sqlite');
    sqlite = new Database(dbPath);
    // A nonempty pre-upgrade task database: execute the actual additive migration.
    sqlite.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, permission_snapshot_json TEXT NOT NULL DEFAULT '{}'); INSERT INTO bot_delegations (id) VALUES ('task');");
    sqlite.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0127_bot_group_task_posts.sql'), 'utf8'));
    h.db = drizzle(sqlite);
  });
  afterEach(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

  it('keeps the payload through state changes and database reopen', async () => {
    const first = payload('Original title');
    expect(await prepareBotGroupTaskPost('task', scope, async () => first)).toEqual(first);
    sqlite.exec(`UPDATE bot_delegations SET permission_snapshot_json = '{"taskPause":{"token":"pause"}}'`);
    sqlite.close(); sqlite = new Database(dbPath); h.db = drizzle(sqlite);
    const prepare = vi.fn(async () => payload('Renamed title'));
    expect(await prepareBotGroupTaskPost('task', scope, prepare)).toEqual(first);
    expect(prepare).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT permission_snapshot_json FROM bot_delegations').get()).toEqual({ permission_snapshot_json: '{"taskPause":{"token":"pause"}}' });
    expect(await prepareBotGroupTaskPost('task', { ...scope, clientId: 'task:completed' }, async () => payload('Result'))).toEqual(payload('Result'));
  });

  it('returns the first committed payload to concurrent preparers', async () => {
    let release!: (post: BotGroupTaskPostSnapshot) => void;
    let preparing!: () => void;
    const started = new Promise<void>(resolve => { preparing = resolve; });
    const late = prepareBotGroupTaskPost('task', scope, () => { preparing(); return new Promise(resolve => { release = resolve; }); });
    await started;
    const first = await prepareBotGroupTaskPost('task', scope, async () => payload('Winner'));
    release(payload('Late'));
    expect(await late).toEqual(first);
  });

  it.each(['endpoint', 'selfId', 'roomId', 'clientId'] as const)('separates snapshots by %s', async field => {
    await prepareBotGroupTaskPost('task', scope, async () => payload('Original'));
    expect(await prepareBotGroupTaskPost('task', { ...scope, [field]: 'other' }, async () => payload('Other'))).toEqual(payload('Other'));
    expect(await prepareBotGroupTaskPost('task', scope, async () => payload('Changed'))).toEqual(payload('Original'));
  });

  it('does not freeze a failed preparation or post for a deleted task', async () => {
    await expect(prepareBotGroupTaskPost('task', scope, async () => { throw new Error('UPLOAD_FAILED'); })).rejects.toThrow('UPLOAD_FAILED');
    expect(await prepareBotGroupTaskPost('task', scope, async () => payload('Retry'))).toEqual(payload('Retry'));
    sqlite.exec('DELETE FROM bot_delegations');
    const prepare = vi.fn(async () => payload('Deleted'));
    await expect(prepareBotGroupTaskPost('task', scope, prepare)).rejects.toThrow('TASK_DELIVERY_UNAVAILABLE');
    expect(prepare).not.toHaveBeenCalled();
  });
});
