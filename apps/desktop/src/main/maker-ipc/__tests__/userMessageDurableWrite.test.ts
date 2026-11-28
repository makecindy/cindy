import { describe, expect, it, vi } from 'vitest';

vi.mock('../latestAssistantTranscriptUuid.js', () => ({ findLatestAssistantTranscriptUuid: vi.fn(async () => 'from-db') }));

import { createUserMessageDurableWrite } from '../userMessageDurableWrite';
import { createSharedReconnectFixture } from './helpers/sharedReconnectFixture';

// The one entry that writes a turn's user row, shared by the desktop and the Node Host: a person's
// message charges every auto-resume budget; an automatic input charges only the silent-stop one; an
// auto-resume charges none and registers its pending outcome, released again if the write fails.
// The row goes through the durable FIFO with the engine stamp and the transcript anchor.
describe('user message durable write', () => {
  function fixture(createDbMessage = vi.fn(async () => ({ id: 'row' }))) {
    const calls: string[] = [];
    const labels: string[] = [];
    const ports = {
      autoResumeBookkeeping: {
        registerPendingOutcome: vi.fn((_s: string, token: number, clientId: string) => { calls.push(`register:${token}:${clientId}`); }),
        releasePendingOutcome: vi.fn((_s: string, token: number, clientId: string) => { calls.push(`release:${token}:${clientId}`); }),
      },
      silentStopAutoResumeGuard: { noteUserSend: vi.fn(() => { calls.push('silent'); }) },
      interruptedTurnAutoResumeGuard: { noteUserSend: vi.fn(() => { calls.push('interrupted'); }) },
      usageLimitAutoResume: { noteUserAction: vi.fn(() => { calls.push('usage'); }) },
      startFallbackTurn: vi.fn(() => { calls.push('turn'); }),
      getProviderGroupService: () => ({ noteUserAction: () => { calls.push('group'); } }),
      enqueueDurableWrite: vi.fn(async <T>(label: string, write: (owner: unknown) => Promise<T>) => { labels.push(label); return write('owner'); }),
      getLastAssistantTranscriptUuid: () => 'anchor',
      getSessionDbAgentKind: () => 'codex' as const,
      createDbMessage,
    };
    const write = createUserMessageDurableWrite(ports as never);
    return { write, calls, labels, createDbMessage };
  }

  it('charges every budget for a person\'s message and writes the stamped, anchored row through the FIFO', async () => {
    const f = fixture();
    await f.write('s1', { clientId: 'c1', role: 'user', content: 'hi' } as never);
    expect(f.calls).toEqual(['turn', 'silent', 'interrupted', 'usage', 'group']);
    expect(f.labels).toEqual(['user:s1:c1']);
    expect(f.createDbMessage).toHaveBeenCalledWith('s1',
      expect.objectContaining({ clientId: 'c1', agentKind: 'codex', agentMeta: { transcriptParentUuid: 'anchor' } }),
      { broadcastOwnerScope: 'owner' });
  });

  it('charges only the silent-stop budget for an automatic input', async () => {
    const f = fixture();
    await f.write('s1', { clientId: 'c2', role: 'user', content: 'run', agentMeta: { origin: { kind: 'scheduler' } } } as never);
    // An automatic input is still a new turn: sources that failed earlier may take over again.
    expect(f.calls).toEqual(['turn', 'silent']);
  });

  it('registers an auto-resume\'s pending outcome without charging, and releases it when the write fails', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('disk full'); }));
    const meta = { autoResume: true, autoResumeInfo: { sessionTotal: 3 } };
    await expect(f.write('s1', { clientId: 'c3', role: 'user', content: '继续', agentMeta: meta } as never)).rejects.toThrow('disk full');
    expect(f.calls).toEqual(['register:3:c3', 'release:3:c3']);
  });
});

describe('shared reconnect at the durable user write boundary', () => {
  const message = { clientId: 'new-input', role: 'user', content: 'continue' } as const;

  // Unit, PR #12422: the write used to cancel the very send that owned it.
  // The budget tests stubbed noteUserAction. Use the real writer and group
  // service with two registrations for one task and one identified manual row.
  it('preserves only the reconnect registered by the manual write', async () => {
    const { write, service, createDbMessage } = createSharedReconnectFixture();
    const older = service.trackGuestStartRecovery('task');
    const own = service.trackGuestStartRecovery('task');

    await write('task', message, { ownReconnectRecoverySignal: own.signal });

    expect(own.isCurrent()).toBe(true);
    expect(own.signal.aborted).toBe(false);
    expect(older.isCurrent()).toBe(false);
    expect(older.signal.aborted).toBe(true);
    expect(createDbMessage).toHaveBeenCalledExactlyOnceWith(
      'task', expect.objectContaining(message), { broadcastOwnerScope: null },
    );
  });

  it('supersedes an existing reconnect when a manual write has no recovery identity', async () => {
    const { write, service } = createSharedReconnectFixture();
    const pending = service.trackGuestStartRecovery('task');

    await write('task', message);

    expect(pending.isCurrent()).toBe(false);
    expect(pending.signal.aborted).toBe(true);
  });

  it.each(['session', 'orca', 'scheduler'] as const)('leaves an existing reconnect untouched by a %s write', async kind => {
    const { write, service, createDbMessage } = createSharedReconnectFixture();
    const pending = service.trackGuestStartRecovery('task');
    const noteUserAction = vi.spyOn(service, 'noteUserAction');

    await write('task', { ...message, agentMeta: { origin: { kind } } });

    expect(createDbMessage).toHaveBeenCalledOnce();
    expect(noteUserAction).not.toHaveBeenCalled();
    expect(pending.isCurrent()).toBe(true);
  });
});
