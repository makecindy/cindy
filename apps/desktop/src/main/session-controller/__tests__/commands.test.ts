import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSessionCaller } from '../callerContext.js';
import { executeSessionCommand } from '../commands.js';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';

const h = vi.hoisted(() => ({
  owner: {}, check: vi.fn(async () => ({ allowed: true })), stat: vi.fn(async () => ({ dev: 2, ino: 8, mtimeMs: 20 })),
  create: vi.fn(async (input: { id: string; validateResources?: () => Promise<void> }) => { await input.validateResources?.(); return { row: { id: input.id } }; }),
  send: vi.fn(), created: vi.fn(), list: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ stat: h.stat }));
vi.mock('../localHost.js', () => ({ localSessionHost: { deviceId: () => 'target-device', owner: () => h.owner, execution: () => null } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({}) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionRowSnapshotStrict: async () => null }));
vi.mock('../../localDb/agentInputQueueSnapshots.js', () => ({ awaitAgentInputQueueSnapshotPersistence: async () => {}, readInputDeliveryReceipts: async () => [] }));
vi.mock('../../device-link/remote-workdir-guard.js', () => ({ checkRemoteWorkingDir: h.check }));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({ emitSessionCreated: h.created }));
vi.mock('../opening.js', () => ({ createSessionRecord: h.create }));
vi.mock('../records.js', () => ({ sessionRecords: { list: h.list } }));
vi.mock('../sessionService.js', () => ({ tryGetSessionService: () => ({ sendToSession: h.send }) }));
vi.mock('../idempotency.js', () => ({ createSessionRequestLedger: () => ({ run: async (_req: unknown, execute: (identity: unknown) => Promise<unknown>) => execute({ sessionId: 'created', inputId: 'input' }) }) }));

const createRequest = (owningDeviceId: string, remoteHostId: string | null, version?: string): SessionControlRequest => ({
  version: 1, requestId: 'rpc', deviceId: 'target-device', command: { operation: 'createRecord', args: {
    businessKey: 'create-once', directory: { owningDeviceId, remoteHostId, locator: '/same/path', kind: 'directory', version },
  } },
});
const run = (request: SessionControlRequest) => withSessionCaller({ source: 'session', authorize: async () => {} }, () => executeSessionCommand(request, 'caller'));
beforeEach(() => { vi.clearAllMocks(); h.check.mockResolvedValue({ allowed: true }); });
describe('Session command resource ownership at the real operation boundary', () => {
  it.each([['source-device', null], ['target-device', 'ssh-host']])('never reads a same-named local directory for %s / %s', async (device, ssh) => {
    await expect(run(createRequest(device!, ssh))).rejects.toMatchObject({ code: 'RESOURCE_UNREACHABLE' });
    expect(h.check).not.toHaveBeenCalled(); expect(h.stat).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects inaccessible and changed resource versions before creating a record', async () => {
    h.check.mockResolvedValueOnce({ allowed: false });
    await expect(run(createRequest('target-device', null))).rejects.toMatchObject({ code: 'RESOURCE_UNREACHABLE' });
    await expect(run(createRequest('target-device', null, '1:8'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('returns the actual owning reference and broadcasts only the new record', async () => {
    const request = createRequest('target-device', null, '2:8');
    expect(await run(request)).toMatchObject({ target: { deviceId: 'target-device', sessionId: 'created' }, phase: 'accepted', resource: { owningDeviceId: 'target-device' } });
    expect(h.check).toHaveBeenCalledTimes(2); expect(h.created).toHaveBeenCalledExactlyOnceWith('created');
    expect(h.send).not.toHaveBeenCalled();
  });
});
