import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRequestLedger } from '../idempotency.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(filename = ':memory:', initialize = true) {
  const db = new Database(filename); databases.push(db);
  if (initialize) db.exec(readFileSync(new URL('../../../../drizzle/0123_session_control_requests.sql', import.meta.url), 'utf8'));
  const port = {
    exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    queryOne: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
  };
  return { port, db, ledger: createSessionRequestLedger(port, () => {}) };
}
const request = { callerKey: 'authenticated-device/source', businessKey: 'same-user-intent', operation: 'createRecord' as const, intent: { model: 'm', title: 'task' } };

describe('durable Session request identity', () => {
  it('survives a real SQLite connection restart, including the commit-before-receipt crash window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cindy-session-ledger-'));
    try {
      const filename = join(dir, 'requests.sqlite');
      const first = fixture(filename);
      const create = vi.fn(async ({ sessionId }) => ({ target: sessionId, phase: 'accepted' }));
      const receipt = await first.ledger.run(request, create, async () => undefined);
      let committedInput: string | undefined;
      const sendRequest = { ...request, businessKey: 'send-once', operation: 'send' as const, targetSessionId: 'task' };
      const send = vi.fn(async ({ inputId }) => { committedInput = inputId; throw new Error('host exited before receipt'); });
      await expect(first.ledger.run(sendRequest, send, async () => undefined)).rejects.toThrow('host exited');
      first.db.close(); databases.splice(databases.indexOf(first.db), 1);
      const reopened = fixture(filename, false);
      expect(await reopened.ledger.run(request, create, async () => undefined)).toEqual(receipt);
      await expect(reopened.ledger.run(sendRequest, send, async () => undefined)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
      expect(await reopened.ledger.run<unknown>(sendRequest, send, async ({ inputId }) => inputId === committedInput ? { inputId, phase: 'dispatched' } : undefined))
        .toEqual({ inputId: committedInput, phase: 'dispatched' });
      expect(create).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
      reopened.db.close(); databases.splice(databases.indexOf(reopened.db), 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reuses one committed target after response loss and host recreation', async () => {
    const f = fixture();
    const create = vi.fn(async ({ sessionId }) => ({ target: sessionId, phase: 'accepted' }));
    const result = await f.ledger.run(request, create, async () => undefined);
    const restarted = createSessionRequestLedger(f.port, () => {});
    expect(await restarted.run(request, create, async () => undefined)).toEqual(result);
    expect(create).toHaveBeenCalledOnce();
  });
  it('does not reexecute a reservation interrupted by a crash', async () => {
    const f = fixture();
    const send = vi.fn(async () => { throw new Error('process lost after dispatch'); });
    const sendRequest = { ...request, operation: 'send' as const, targetSessionId: 'task' };
    await expect(f.ledger.run(sendRequest, send, async () => undefined)).rejects.toThrow('process lost');
    const restarted = createSessionRequestLedger(f.port, () => {});
    await expect(restarted.run(sendRequest, send, async () => undefined)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(send).toHaveBeenCalledOnce();
    expect(await restarted.run<unknown>(sendRequest, send, async ({ inputId }) => ({ inputId, phase: 'accepted' }))).toMatchObject({ phase: 'accepted' });
    expect(send).toHaveBeenCalledOnce();
  });
  it('detects changed content under the same business key while allowing field reordering', async () => {
    const f = fixture();
    const create = vi.fn(async () => ({ phase: 'accepted' }));
    await f.ledger.run(request, create, async () => undefined);
    await expect(f.ledger.run({ ...request, intent: { title: 'changed', model: 'm' } }, create, async () => undefined)).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.ledger.run({ ...request, intent: { title: 'task', model: 'm' } }, create, async () => undefined);
    expect(create).toHaveBeenCalledOnce();
  });
  it('reserves before execution and isolates caller/device scopes', async () => {
    const f = fixture();
    let release!: () => void;
    const first = f.ledger.run(request, async () => { await new Promise<void>(r => { release = r; }); return 1; }, async () => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const other = vi.fn(async () => 2);
    await expect(f.ledger.run(request, other, async () => undefined)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(await f.ledger.run({ ...request, callerKey: 'another-device/source' }, other, async () => undefined)).toBe(2);
    release(); expect(await first).toBe(1);
    expect(other).toHaveBeenCalledOnce();
  });
});
