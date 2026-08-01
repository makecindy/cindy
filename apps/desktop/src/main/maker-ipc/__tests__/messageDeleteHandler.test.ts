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
    })),
    setPendingHandoff: vi.fn(),
    onCommitted: vi.fn(),
    withCloseSuppressed: vi.fn(async (_sessionId, fn) => fn()),
    log: { info: vi.fn() },
    ...overrides,
  };
}

describe('performMessageDeletion', () => {
  it('keeps the deleted-session preview on the visible message projection', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/localDb/ipc/messages.ts'), 'utf8');
    const deletionBlock = source.slice(
      source.indexOf('export async function commitMessageDeletion'),
      source.indexOf('export function broadcastMessageDeleted'),
    );

    expect(deletionBlock).toContain('const visibleMessageProjection = and(');
    expect(deletionBlock).toContain('.where(visibleMessageProjection)');
    expect(deletionBlock).not.toContain('.where(eq(messages.sessionId, sessionId))');
  });

  /**
   * issue #1282:删除路径一度用「可见 user/assistant 行数」去 patch `_count.messages`,而列表的
   * 权威口径是全部 messages 行数(sessions.ts 的 SESSION_MESSAGE_COUNT_SQL),差几十倍。shallow
   * merge 消费端不会自纠,错值留到下次 reseed。权威口径受删除影响只有 0 或 +1(见
   * commitMessageDeletion 的注释),不值得每次删除多跑一次全表 count,故整个字段不再广播。
   * 这几条静态断言守住「删除不按可见投影数行、不广播 _count」。
   */
  it('never patches _count.messages from the delete path', () => {
    const messagesSource = readFileSync(
      resolve(process.cwd(), 'src/main/localDb/ipc/messages.ts'),
      'utf8',
    );
    const deletionStart = messagesSource.indexOf('export async function commitMessageDeletion');
    const deletionBlock = messagesSource.slice(
      deletionStart,
      messagesSource.indexOf('export function broadcastMessageDeleted'),
    );
    // 返回契约里不得再出现 messageCount——它就是 _count 广播的唯一来源。只看函数签名段,
    // 因为下方注释本身要提这个名字解释原因。(切点找不到时先失败在这里,否则 slice(-1) 会把
    // 整个文件当签名段,报出一个和真实原因无关的断言。)
    const bodyStart = messagesSource.indexOf('const now = Date.now()', deletionStart);
    expect(bodyStart).toBeGreaterThan(deletionStart);
    const signatureBlock = messagesSource.slice(deletionStart, bodyStart);
    expect(signatureBlock).not.toContain('messageCount');
    // 也不得再对可见投影数行。只匹配真实查询写法——注释里提 count 口径是允许的。
    expect(deletionBlock).not.toContain('.select({ messageCount');
    expect(deletionBlock).not.toMatch(/count\(messages\./);

    // 只切 broadcastSessionPatched 的对象字面量本身:整个 onCommitted 块里的注释也提 `_count`
    // (说明为什么不发),连注释一起断言会把自己打挂。
    const registerSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    const onCommittedStart = registerSource.indexOf('onCommitted: ({ sessionId, deletedClientIds');
    expect(onCommittedStart).toBeGreaterThan(-1);
    const patchStart = registerSource.indexOf(
      'broadcastSessionPatched(sessionId, {',
      onCommittedStart,
    );
    expect(patchStart).toBeGreaterThan(-1);
    const patchBlock = registerSource.slice(patchStart, registerSource.indexOf('});', patchStart));
    expect(patchBlock).toContain('preview,');
    expect(patchBlock).not.toContain('_count');
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
    // 第三参数是写入前取的代次(mock deps 未提供 readPendingHandoffGeneration → undefined)
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', handoff, undefined);
    expect(deps.onCommitted).toHaveBeenCalledWith(
      {
        sessionId: 's1',
        deletedClientIds: ['target'],
        updatedAt: 500,
        preview: 'keep after',
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
