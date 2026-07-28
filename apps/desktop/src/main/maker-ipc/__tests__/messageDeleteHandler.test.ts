import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  performMessageDeletion,
  type MessageDeleteHandlerDeps,
} from '../messageDeleteHandler';

function makeDeps(
  overrides: Partial<MessageDeleteHandlerDeps> = {},
): MessageDeleteHandlerDeps {
  return {
    getSessionRow: vi.fn(async () => ({ status: 'active', agentKind: 'cc' })),
    getMessage: vi.fn(async () => ({
      id: 'target-row',
      role: 'user' as const,
      deletedClientIds: ['target'],
    })),
    listMessagesForContext: vi.fn(async () => [
      { clientId: 'before', role: 'user', content: 'keep before', createdAt: 100 },
      { clientId: 'target', role: 'user', content: 'delete me', createdAt: 200 },
      { clientId: 'after', role: 'assistant', content: 'keep after', createdAt: 300 },
    ]),
    getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
    hasBackgroundActivity: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
    commitDeletion: vi.fn(async (sessionId, deletedClientIds) => ({
      sessionId,
      deletedClientIds,
      updatedAt: 500,
      preview: 'keep after',
      messageCount: 4,
    })),
    setPendingHandoff: vi.fn(),
    onCommitted: vi.fn(),
    withCloseSuppressed: vi.fn(async (_sessionId, fn) => fn()),
    log: { info: vi.fn() },
    ...overrides,
  };
}

describe('performMessageDeletion', () => {
  it('keeps deleted-session patch count on the visible message projection', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/localDb/ipc/messages.ts'), 'utf8');
    const deletionBlock = source.slice(
      source.indexOf('export async function commitMessageDeletion'),
      source.indexOf('export function broadcastMessageDeleted'),
    );

    expect(deletionBlock).toContain('const visibleMessageProjection = and(');
    expect(deletionBlock).toContain(".where(visibleMessageProjection)");
    expect(deletionBlock).not.toContain('.where(eq(messages.sessionId, sessionId))');
  });

  it('closes the old native session and rebuilds handoff from history without the target', async () => {
    const deps = makeDeps();

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).resolves.toEqual({
      sessionId: 's1',
      clientId: 'target',
      clientIds: ['target'],
    });

    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitDeletion).toHaveBeenCalledWith(
      's1',
      ['target'],
      expect.any(String),
    );
    const handoff = vi.mocked(deps.commitDeletion).mock.calls[0]?.[2] ?? '';
    expect(handoff).toContain('keep before');
    expect(handoff).toContain('keep after');
    expect(handoff).not.toContain('delete me');
    expect(handoff).toContain('treat only these records as the prior conversation');
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', handoff);
    expect(deps.onCommitted).toHaveBeenCalledWith(
      {
        sessionId: 's1',
        deletedClientIds: ['target'],
        updatedAt: 500,
        preview: 'keep after',
        messageCount: 4,
      },
      'target',
    );
  });

  it('deletes every AI record in the surrounding real user round', async () => {
    const deps = makeDeps({
      getMessage: vi.fn(async () => ({
        id: 'final-row',
        role: 'assistant' as const,
        deletedClientIds: ['progress', 'thinking', 'auto-resume', 'tool', 'final'],
      })),
      listMessagesForContext: vi.fn(async () => [
        { clientId: 'user', role: 'user', content: 'diagnose it', createdAt: 100 },
        { clientId: 'progress', role: 'assistant', content: 'checking', createdAt: 200 },
        { clientId: 'thinking', role: 'thinking', content: 'analysis', createdAt: 300 },
        { clientId: 'auto-resume', role: 'user', content: 'continue', createdAt: 400 },
        { clientId: 'tool', role: 'tool_result', content: 'result', createdAt: 500 },
        { clientId: 'final', role: 'assistant', content: 'fixed', createdAt: 600 },
        { clientId: 'next-user', role: 'user', content: 'thanks', createdAt: 700 },
      ]),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'final',
    })).resolves.toEqual({
      sessionId: 's1',
      clientId: 'final',
      clientIds: ['progress', 'thinking', 'auto-resume', 'tool', 'final'],
    });

    expect(deps.commitDeletion).toHaveBeenCalledWith(
      's1',
      ['progress', 'thinking', 'auto-resume', 'tool', 'final'],
      expect.any(String),
    );
    const handoff = vi.mocked(deps.commitDeletion).mock.calls[0]?.[2] ?? '';
    expect(handoff).toContain('diagnose it');
    expect(handoff).toContain('thanks');
    expect(handoff).not.toContain('checking');
    expect(handoff).not.toContain('analysis');
    expect(handoff).not.toContain('continue');
    expect(handoff).not.toContain('result');
    expect(handoff).not.toContain('fixed');
  });

  it('rejects while a turn is running and leaves storage untouched', async () => {
    const deps = makeDeps({
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => true })),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).rejects.toThrow('SESSION_RUNNING');
    expect(deps.listMessagesForContext).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitDeletion).not.toHaveBeenCalled();
  });

  it('rejects while background activity is running and leaves storage untouched', async () => {
    const deps = makeDeps({
      hasBackgroundActivity: vi.fn(() => true),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).rejects.toThrow('SESSION_RUNNING');
    expect(deps.listMessagesForContext).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitDeletion).not.toHaveBeenCalled();
  });

  it('rechecks background activity before closing the native session', async () => {
    let reads = 0;
    const deps = makeDeps({
      hasBackgroundActivity: vi.fn(() => ++reads > 1),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).rejects.toThrow('SESSION_RUNNING');
    expect(deps.listMessagesForContext).toHaveBeenCalledOnce();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitDeletion).not.toHaveBeenCalled();
  });

  it('rejects a missing target before loading the bounded context window', async () => {
    const deps = makeDeps({
      getMessage: vi.fn(async () => null),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'missing',
    })).rejects.toThrow('NOT_FOUND');
    expect(deps.listMessagesForContext).not.toHaveBeenCalled();
    expect(deps.commitDeletion).not.toHaveBeenCalled();
  });

  it('can delete an older visible message outside the bounded handoff window', async () => {
    const deps = makeDeps({
      listMessagesForContext: vi.fn(async () => [
        { clientId: 'after', role: 'assistant', content: 'visible', createdAt: 300 },
      ]),
    });

    await expect(performMessageDeletion(deps, {
      sessionId: 's1',
      clientId: 'target',
    })).resolves.toEqual({
      sessionId: 's1',
      clientId: 'target',
      clientIds: ['target'],
    });
    expect(deps.commitDeletion).toHaveBeenCalledWith('s1', ['target'], expect.any(String));
  });
});
