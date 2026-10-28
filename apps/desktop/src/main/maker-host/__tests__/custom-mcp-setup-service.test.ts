/** 测试价值：unit；真实 SQLite 事务覆盖凭证与配置原子提交、账号切换和取消竞态。
 * 最小输入为一个假服务和无效测试凭证；旧 CRUD 测试未覆盖本机交接流程。 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { commitCustomMcp } from '../../localDb/worker/opHandlers/customMcpTx.js';
import { CustomMcpSetupService, mcpSubmissionSchema } from '../custom-mcp-setup-service.js';
import { DeferredCodexRestartService } from '../../maker-ipc/deferredCodexRestart.js';
import {
  listMcpSummaries,
  resolveMcpCredentials,
  listMcpRecords,
  saveMcpConfig,
} from '../custom-mcp-config-service.js';
import { writeMcpCredentials } from '../../secrets/customMcpCredentials.js';
import type { McpSetupSnapshot } from '../../../shared/mcpSetup.js';

const state = vi.hoisted(() => ({ scope: 'owner:1', blobs: new Map<string, unknown>(), seq: 0 }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../secrets/customMcpCredentials.js', () => ({
  hasLegacyMcpToken: () => false,
  readLegacyMcpToken: () => null,
  writeMcpCredentials: vi.fn((_config, credentials) => {
    if (!credentials.token && !Object.keys(credentials.headers).length) return null;
    const ref = 'mcp_bundle_t_' + String(++state.seq).padStart(32, '0');
    state.blobs.set(ref, structuredClone(credentials));
    return ref;
  }),
  readMcpCredentials: (_config: unknown, ref: string | null) => {
    if (ref === null) return { token: '', headers: {} };
    const value = state.blobs.get(ref);
    if (!value) throw new Error('SECRET_UNREADABLE');
    return structuredClone(value);
  },
}));
let db: Database.Database;
let client: DbClient;
let service: CustomMcpSetupService;
let frames: McpSetupSnapshot[];
const complete = vi.fn(async () => {});
const verify = vi.fn(async () => {});
let execution = 'turn:1';
beforeEach(() => {
  vi.clearAllMocks();
  state.scope = 'owner:1';
  state.blobs.clear();
  execution = 'turn:1';
  frames = [];
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE custom_mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, credential_format INTEGER DEFAULT 0, credential_ref TEXT); CREATE TABLE custom_mcp_setup_receipts (operation_id TEXT PRIMARY KEY, session_id TEXT, server_id TEXT, created_at INTEGER);',
  );
  client = {
    drizzle: drizzle(db),
    tx: vi.fn(async (_name: string, input: unknown) =>
      commitCustomMcp(db, input as Parameters<typeof commitCustomMcp>[1]),
    ),
    queryOne: async (sql: string, params: unknown[]) => db.prepare(sql).get(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'owner');
  service = new CustomMcpSetupService({
    broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
    complete,
    changed: async () => true,
    verify,
    executionKey: () => execution,
  });
});
afterEach(() => {
  service.invalidate();
  clearCurrentDbClient(client);
  db.close();
});
function prepare() {
  const receipt = service.request('task', { name: 'Demo', url: 'https://example.test/mcp' });
  const snapshot = service.pendingSnapshots('task')[0].request;
  const updated = service.update({
    requestId: snapshot.requestId,
    expectedRevision: snapshot.revision,
    draft: { ...snapshot.draft, headerNames: ['X-Test-Key'] },
  });
  return {
    receipt,
    input: {
      requestId: updated.requestId,
      expectedRevision: updated.revision,
      submissionId: '00000000-0000-4000-8000-000000000001',
      token: 'test-invalid-token',
      headers: { 'X-Test-Key': 'test-invalid-header' },
    },
  };
}
describe('secure custom MCP setup', () => {
  it('verifies once, commits an opaque reference and safe receipt, and never echoes credential values', async () => {
    const { receipt, input } = prepare();
    const one = service.submit(input);
    const two = service.submit(input);
    expect(one).toBe(two);
    const saved = await one;
    expect(saved).toMatchObject({
      status: 'saved',
      verification: 'passed',
      activation: 'next_session',
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(client.tx).toHaveBeenCalledTimes(1);
    const rows = await listMcpRecords();
    expect(rows[0].headers).toBe('{"X-Test-Key":""}');
    expect(resolveMcpCredentials(rows[0])).toEqual({ token: input.token, headers: input.headers });
    const serialized = JSON.stringify({
      frames,
      summaries: await listMcpSummaries(),
      receipt,
      result: await service.status('task', receipt.operationId),
      row: rows[0],
    });
    expect(serialized).not.toContain(input.token);
    expect(serialized).not.toContain(input.headers['X-Test-Key']);
    expect(receipt).not.toHaveProperty('requestId');
    expect(receipt).not.toHaveProperty('draft');
    expect(complete).toHaveBeenCalledOnce();
    expect(await service.status('other-task', receipt.operationId)).toBeNull();
  });
  it('does not persist or continue on verification failure and allows a fresh credential submission', async () => {
    const { input } = prepare();
    verify.mockRejectedValueOnce(new Error('AUTH_REJECTED'));
    expect(await service.submit(input)).toMatchObject({
      status: 'awaiting_user',
      errorCode: 'AUTH_REJECTED',
    });
    expect(client.tx).not.toHaveBeenCalled();
    expect(writeMcpCredentials).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const snapshot = service.pendingSnapshots('task')[0].request;
    expect(await service.submit({ ...input, expectedRevision: snapshot.revision })).toMatchObject({
      status: 'saved',
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it('retries activation without verifying or saving a second server', async () => {
    const changed = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete,
      changed,
      verify,
      executionKey: () => execution,
    });
    const { input } = prepare();
    const saved = await service.submit(input);
    expect(saved).toMatchObject({ status: 'saved', activation: 'pending' });
    expect(await service.retryActivation(saved.requestId, saved.revision)).toMatchObject({
      status: 'saved',
      activation: 'next_session',
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(client.tx).toHaveBeenCalledOnce();
    expect(await listMcpRecords()).toHaveLength(1);
  });
  it('publishes durable saved state while runtime refresh is pending and shares its retry', async () => {
    let finish!: (value: boolean) => void;
    const changed = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete,
      changed,
      verify,
      executionKey: () => execution,
    });
    const { input } = prepare();
    const saving = service.submit(input);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const saved = frames.at(-1)!;
    expect(saved).toMatchObject({ status: 'saved', activation: 'refreshing' });
    expect(complete).toHaveBeenCalledOnce();
    const retry = service.retryActivation(saved.requestId, saved.revision);
    expect(changed).toHaveBeenCalledOnce();
    finish(true);
    expect(await saving).toMatchObject({ status: 'saved', activation: 'next_session' });
    expect(await retry).toMatchObject({ status: 'saved', activation: 'next_session' });
    expect(client.tx).toHaveBeenCalledOnce();
  });
  it('automatically settles a deferred activation at the idle restart boundary without another save or continuation', async () => {
    let busy = true;
    const restart = vi.fn(async (apply: () => Promise<boolean>) => { await apply(); });
    const deferred = new DeferredCodexRestartService({
      restart,
      hasBusyLocalCodexSession: () => busy,
      listLocalCodexSessionIds: () => ['task'],
      onApplied: () => service.activationApplied(),
    });
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, verify, executionKey: () => execution,
      changed: async () => { deferred.schedule('Custom MCP configuration changed'); return 'deferred'; },
    });
    try {
      const { input, receipt } = prepare();
      expect(await service.submit(input)).toMatchObject({ status: 'saved', activation: 'deferred' });
      await deferred.flushBeforeLocalCodexSessionStart();
      expect(restart).not.toHaveBeenCalled();
      busy = false;
      // The existing runtime-refresh close silences Agent continuation, not
      // this owner's already durable result card.
      service.cleanupForSession('task');
      await deferred.flushBeforeLocalCodexSessionStart();
      expect(frames.at(-1)).toMatchObject({ status: 'saved', activation: 'next_session' });
      expect(await service.status('task', receipt.operationId)).toMatchObject({ activation: 'next_session' });
      expect(verify).toHaveBeenCalledOnce();
      expect(client.tx).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
    } finally { deferred.clear(); }
  });
  it('publishes the applied receipt when an immediate refresh retires the originating Agent session', async () => {
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, verify, executionKey: () => execution,
      changed: async () => { service.cleanupForSession('task'); return true; },
    });
    expect(await service.submit(prepare().input)).toMatchObject({ status: 'saved', activation: 'next_session' });
    expect(frames.at(-1)).toMatchObject({ status: 'saved', activation: 'next_session' });
    expect(complete).toHaveBeenCalledOnce();
  });
  it('keeps the applied result if the idle callback wins the race with the initial refresh reply', async () => {
    let pending = true;
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, verify, executionKey: () => execution,
      activationPending: () => pending,
      changed: async () => {
        pending = false;
        service.activationApplied();
        return 'deferred';
      },
    });
    expect(await service.submit(prepare().input)).toMatchObject({ activation: 'next_session' });
    expect(frames.at(-1)).toMatchObject({ activation: 'next_session' });
  });
  it('does not publish an old owner receipt when a late activation callback arrives', async () => {
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, verify, changed: async () => 'deferred', executionKey: () => execution,
    });
    await service.submit(prepare().input);
    const count = frames.length;
    state.scope = 'owner:2';
    service.activationApplied();
    expect(frames).toHaveLength(count);
  });
  it('revokes a queued completion if Stop arrives after persistence', async () => {
    let resume!: () => void;
    const delivered = vi.fn();
    const changed = vi.fn(async () => true);
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete: async (_sessionId, _snapshot, assertCurrent) => {
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        assertCurrent();
        delivered();
      },
      changed,
      verify,
      executionKey: () => execution,
    });
    const { input } = prepare();
    const saving = service.submit(input);
    await vi.waitFor(() => expect(frames.at(-1)?.status).toBe('saved'));
    service.cleanupForSession('task');
    resume();
    expect(await saving).toMatchObject({ status: 'saved', activation: 'pending' });
    expect(delivered).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(await listMcpRecords()).toHaveLength(1);
  });
  // Stop during the non-cancellable transaction must settle the visible card
  // without resuming the stopped turn; the saved-before-Stop case misses this.
  it.each(['saved', 'receipt-lost', 'failed'] as const)('settles a %s commit after Stop without continuing the turn', async (outcome) => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const changed = vi.fn(async () => true);
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, changed, verify, executionKey: () => execution,
      save: async (...args) => {
        await gate;
        if (outcome === 'failed') throw new Error('SAVE_FAILED');
        const result = await saveMcpConfig(...args);
        if (outcome === 'receipt-lost') throw new Error('SAVE_FAILED');
        return result;
      },
    });
    const { input } = prepare();
    const saving = service.submit(input);
    await vi.waitFor(() => expect(frames.at(-1)?.status).toBe('committing'));
    service.cleanupForSession('task');
    finish();
    await saving;
    expect(frames.at(-1)?.status).toBe(outcome === 'failed' ? 'cancelled' : 'saved');
    expect(service.pendingSnapshots('task')).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(await listMcpRecords()).toHaveLength(outcome === 'failed' ? 0 : 1);
  });
  it('does not publish the old owner card when a committing save settles after account invalidation', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    service = new CustomMcpSetupService({
      broadcast: (_id, snapshot) => frames.push(structuredClone(snapshot)),
      complete, changed: async () => true, verify, executionKey: () => execution,
      save: async (...args) => {
        const result = await saveMcpConfig(...args);
        await gate;
        return result;
      },
    });
    const { input } = prepare();
    const saving = service.submit(input);
    await vi.waitFor(() => expect(client.tx).toHaveBeenCalledOnce());
    service.invalidate();
    state.scope = 'owner:2';
    const frameCount = frames.length;
    finish();
    await saving;
    expect(frames).toHaveLength(frameCount);
    expect(complete).not.toHaveBeenCalled();
  });
  it('encrypts Settings credentials while retaining its existing network semantics', async () => {
    const input = {
      id: 'custom_settings',
      name: 'Settings',
      url: 'http://lan.test/mcp?public=true',
      transport: 'http' as const,
      headers: { 'X-Test-Key': 'test-invalid-header' },
      tokenAction: 'replace' as const,
      token: 'test-invalid-token',
    };
    await saveMcpConfig(input, true);
    const row = (await listMcpRecords())[0];
    expect(row.credentialFormat).toBe(2);
    expect(row.headers).toBe('{"X-Test-Key":""}');
    expect(resolveMcpCredentials(row)).toEqual({ token: input.token, headers: input.headers });
    await saveMcpConfig({ ...input, expectedRevision: row.updatedAt }, false);
    expect((await listMcpRecords())[0].credentialFormat).toBe(2);
  });
  it('keeps conversation network restrictions when Settings edits a secure entry', async () => {
    const { input } = prepare();
    await service.submit(input);
    const row = (await listMcpRecords())[0];
    await expect(
      saveMcpConfig(
        {
          id: row.id,
          name: row.name,
          url: 'http://lan.test/mcp',
          transport: 'http',
          headers: {},
          tokenAction: 'keep',
          expectedRevision: row.updatedAt,
        },
        false,
      ),
    ).rejects.toThrow();
    expect((await listMcpRecords())[0]).toMatchObject({
      url: row.url,
      credentialFormat: 1,
      updatedAt: row.updatedAt,
    });
  });
  it('keeps the first pending target and rejects stale revisions and extra submission fields', () => {
    const { receipt, input } = prepare();
    expect(service.request('task', { url: 'https://another.test/mcp' }).operationId).toBe(
      receipt.operationId,
    );
    expect(() => service.submit({ ...input, expectedRevision: 0 })).toThrow('CONFIG_CONFLICT');
    expect(
      mcpSubmissionSchema.safeParse({ ...input, url: 'https://another.test/mcp' }).success,
    ).toBe(false);
    expect(client.tx).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'owner', 'stop'] as const)(
    'prevents commit after %s while verification is in flight',
    async (mode) => {
      let finish!: () => void;
      verify.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const { input } = prepare();
      const job = service.submit(input);
      if (mode === 'owner') {
        service.invalidate();
        state.scope = 'owner:2';
      } else if (mode === 'stop') service.cleanupForSession('task');
      else service.cancel(input.requestId);
      const notifications = complete.mock.calls.length;
      finish();
      await job;
      expect(client.tx).not.toHaveBeenCalled();
      expect(writeMcpCredentials).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(notifications);
    },
  );
  it('does not restart an unrelated later turn after saving', async () => {
    const { input } = prepare();
    execution = 'turn:2';
    await service.submit(input);
    expect(complete).not.toHaveBeenCalled();
    expect(await listMcpRecords()).toHaveLength(1);
  });
  it('expires the pending card and rejects a replay without touching storage', () => {
    vi.useFakeTimers();
    try {
      const { input } = prepare();
      vi.advanceTimersByTime(15 * 60_000);
      expect(() => service.submit(input)).toThrow();
      expect(client.tx).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('recovers a committed receipt after a lost worker reply without duplicating the server', async () => {
    vi.mocked(client.tx).mockImplementationOnce(async (_name: string, input: unknown) => {
      commitCustomMcp(db, input as Parameters<typeof commitCustomMcp>[1]);
      throw new Error('DB_TRANSPORT_OUTCOME_UNKNOWN');
    });
    const { receipt, input } = prepare();
    expect(await service.submit(input)).toMatchObject({ status: 'saved' });
    expect(await listMcpRecords()).toHaveLength(1);
    service.invalidate();
    expect(await service.status('task', receipt.operationId)).toMatchObject({ status: 'saved' });
  });
  it('recovers the original target before using new credentials after an ambiguous save', async () => {
    vi.mocked(client.tx).mockImplementationOnce(async (_name: string, input: unknown) => {
      commitCustomMcp(db, input as Parameters<typeof commitCustomMcp>[1]);
      throw new Error('DB_TRANSPORT_OUTCOME_UNKNOWN');
    });
    vi.spyOn(client, 'queryOne').mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    const { input } = prepare();
    const failed = await service.submit(input);
    expect(failed).toMatchObject({ status: 'awaiting_user', errorCode: 'SAVE_FAILED' });
    const updated = service.update({
      requestId: failed.requestId,
      expectedRevision: failed.revision,
      draft: { ...failed.draft, name: 'Another target', url: 'https://another.test/mcp' },
    });
    complete.mockRejectedValueOnce(new Error('TRANSIENT_QUEUE_FAILURE'));
    const recovered = await service.submit({
      ...input,
      expectedRevision: updated.revision,
      token: 'test-new-target-token',
    });
    expect(recovered).toMatchObject({
      status: 'saved',
      verification: 'passed',
      draft: { name: 'Demo', url: 'https://example.test/mcp' },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(client.tx).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    const [row] = await listMcpRecords();
    expect(row.url).toBe(recovered.draft.url);
    expect(resolveMcpCredentials(row).token).toBe(input.token);
  });
  it('permits an edited target once the previous uncertain save is confirmed absent', async () => {
    vi.mocked(client.tx).mockRejectedValueOnce(new Error('DB_TRANSPORT_OUTCOME_UNKNOWN'));
    vi.spyOn(client, 'queryOne').mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    const { input } = prepare();
    const failed = await service.submit(input);
    expect(failed.status).toBe('awaiting_user');
    const updated = service.update({
      requestId: failed.requestId,
      expectedRevision: failed.revision,
      draft: { ...failed.draft, name: 'Another target', url: 'https://another.test/mcp' },
    });
    const saved = await service.submit({ ...input, expectedRevision: updated.revision });
    expect(saved).toMatchObject({
      status: 'saved', draft: { name: 'Another target', url: 'https://another.test/mcp' },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(client.tx).toHaveBeenCalledTimes(2);
    expect(await listMcpRecords()).toMatchObject([{ url: saved.draft.url }]);
  });
  it('does not use replacement credentials while an earlier save outcome remains unreadable', async () => {
    vi.mocked(client.tx).mockImplementationOnce(async (_name: string, input: unknown) => {
      commitCustomMcp(db, input as Parameters<typeof commitCustomMcp>[1]);
      throw new Error('DB_TRANSPORT_OUTCOME_UNKNOWN');
    });
    const query = vi.spyOn(client, 'queryOne');
    query.mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    const { input } = prepare();
    const failed = await service.submit(input);
    query.mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    query.mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    const pending = await service.submit({
      ...input, expectedRevision: failed.revision, token: 'test-replacement-token',
    });
    expect(pending).toMatchObject({ status: 'awaiting_user', errorCode: 'SAVE_FAILED' });
    expect(verify).toHaveBeenCalledOnce();
    expect(client.tx).toHaveBeenCalledOnce();
    expect(await service.submit({ ...input, expectedRevision: pending.revision })).toMatchObject({
      status: 'saved', draft: { name: 'Demo', url: 'https://example.test/mcp' },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(client.tx).toHaveBeenCalledOnce();
  });
  it.each(['initial', 'fallback'] as const)('does not revive a cancelled card when its %s receipt query returns late', async (phase) => {
    vi.mocked(client.tx).mockImplementationOnce(async (_name: string, input: unknown) => {
      commitCustomMcp(db, input as Parameters<typeof commitCustomMcp>[1]);
      throw new Error('DB_TRANSPORT_OUTCOME_UNKNOWN');
    });
    const query = vi.spyOn(client, 'queryOne');
    query.mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    const { input } = prepare();
    const failed = await service.submit(input);
    let finish!: (value: { server_id: string }) => void;
    let entered!: () => void;
    const querying = new Promise<void>(resolve => { entered = resolve; });
    if (phase === 'fallback') query.mockRejectedValueOnce(new Error('DB_TEMPORARILY_UNAVAILABLE'));
    query.mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { finish = resolve; });
    });
    const retry = service.submit({ ...input, expectedRevision: failed.revision });
    await querying;
    service.cancel(input.requestId);
    finish({ server_id: (await listMcpRecords())[0].id });
    expect(await retry).toMatchObject({ status: 'cancelled' });
    expect(frames.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(verify).toHaveBeenCalledOnce();
    expect(client.tx).toHaveBeenCalledOnce();
  });
  it('preserves the previous row and credentials when encryption fails or an edit is stale', async () => {
    await service.submit(prepare().input);
    const row = (await listMcpRecords())[0];
    const old = resolveMcpCredentials(row);
    const config = {
      id: row.id,
      name: 'Edited',
      url: row.url,
      transport: 'http' as const,
      headers: {},
      token: 'test-replacement',
      tokenAction: 'replace' as const,
      expectedRevision: row.updatedAt,
    };
    vi.mocked(writeMcpCredentials).mockImplementationOnce(() => {
      throw new Error('SECRET_STORE_UNAVAILABLE');
    });
    await expect(saveMcpConfig(config, false)).rejects.toThrow('SECRET_STORE_UNAVAILABLE');
    expect((await listMcpRecords())[0]).toEqual(row);
    expect(resolveMcpCredentials(row)).toEqual(old);
    await expect(
      saveMcpConfig({ ...config, expectedRevision: row.updatedAt - 1 }, false),
    ).rejects.toThrow('CONFIG_CONFLICT');
    expect((await listMcpRecords())[0]).toEqual(row);
  });
  it('does not silently remove unreadable saved credentials, but permits explicit replacement', async () => {
    await service.submit(prepare().input);
    const row = (await listMcpRecords())[0];
    state.blobs.clear();
    const config = {
      id: row.id,
      name: row.name,
      url: row.url,
      transport: 'http' as const,
      headers: {},
      expectedRevision: row.updatedAt,
    };
    await expect(saveMcpConfig({ ...config, tokenAction: 'keep' }, false)).rejects.toThrow(
      'SECRET_UNREADABLE',
    );
    await saveMcpConfig({ ...config, tokenAction: 'replace', token: 'test-replacement' }, false);
    expect(resolveMcpCredentials((await listMcpRecords())[0]).token).toBe('test-replacement');
  });
});
