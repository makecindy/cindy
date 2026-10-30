import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';

describe.each(['claude-code', 'pi'] as const)('%s async question MCP', (agentKind) => {
  it('discovers and calls the same tool with request-time identity and a pending-only receipt', async () => {
    let context: LiziMcpSessionContext | undefined = {
      agentKind, workingDir: '/repo', sessionId: 'task-1', sessionInstanceId: 'instance-1',
      mcpCallerKind: 'root', mcpCallerAttested: true, remoteHostId: 'ssh-host',
    };
    const ask = vi.fn(() => 'question-1');
    const server = createXdtHelperMcpServer({ askUserQuestionAsync: ask }, {
      agentKind, workingDir: '', getSessionContext: () => context,
    });
    const client = new Client({ name: 'question-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    const call = (args: Record<string, unknown>) => client.callTool({ name: 'ask_user_question_async', arguments: args });
    const questions = [{ question: 'Which scope?', options: [{ label: 'Personal' }, { label: 'Both' }] }];
    try {
      const prefix = await client.listTools();
      expect(prefix.tools.some((tool) => tool.name === 'ask_user_question_async')).toBe(true);
      const bypass = await client.callTool({ name: 'call_tool', arguments: { name: 'ask_user_question_async', args: { questions } } });
      expect(bypass.isError).toBe(true);
      expect(parse(await call({ questions }))).toEqual({ ok: true, request_id: 'question-1', status: 'pending' });
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task-1', remoteHostId: 'ssh-host' }), questions);
      context = { ...context!, sessionId: 'task-2', sessionInstanceId: 'instance-2' };
      await call({ questions });
      expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'task-2' }), questions);
      context = undefined;
      expect(parse(await call({ questions })).errorCode).toBe('NO_SESSION_CONTEXT');
      expect(ask).toHaveBeenCalledTimes(2);
      for (const [mcpCallerKind, mcpCallerAttested] of [
        ['descendant', true], ['unknown', true], [undefined, true],
        ['root', false], ['root', undefined], [undefined, undefined],
      ] as const) {
        context = { agentKind, workingDir: '/repo', sessionId: 'task-2', sessionInstanceId: 'instance-2',
          mcpCallerKind, mcpCallerAttested };
        expect(parse(await call({ questions })).errorCode).toBe('ROOT_REQUIRED');
        expect(ask).toHaveBeenCalledTimes(2);
      }
      // Tool arguments cannot supply the missing host provenance.
      expect((await call({ questions, mcpCallerKind: 'root', mcpCallerAttested: true })).isError).toBe(true);
      context = { ...context!, mcpCallerKind: 'root', mcpCallerAttested: true };
      expect((await call({ questions: [...questions, ...questions] })).isError).toBe(true);
      expect((await call({ questions, sessionId: 'spoofed' })).isError).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
      ask.mockImplementationOnce(() => { throw new Error('stale instance'); });
      expect(parse(await call({ questions })).errorCode).toBe('QUESTION_UNAVAILABLE');
      expect(await client.listTools()).toEqual(prefix);
    } finally { await client.close(); await server.close(); }
  });
});

// The HTTP helper factory can serve different harnesses; its captured kind is
// not the authority for a tools/list or tools/call request.
it.each(['codex', 'claude-code'] as const)('keeps one async entry per harness with a %s factory', async (factoryKind) => {
  let context: LiziMcpSessionContext = {
    agentKind: 'claude-code', workingDir: '/repo', sessionId: 'task', sessionInstanceId: 'instance',
    mcpCallerKind: 'root', mcpCallerAttested: true,
  };
  const ask = vi.fn(() => 'question');
  const server = createXdtHelperMcpServer({ askUserQuestionAsync: ask }, {
    agentKind: factoryKind, workingDir: '', getSessionContext: () => context,
  });
  const client = new Client({ name: 'shared-question-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const questions = [{ question: 'Which scope?' }];
  try {
    const claudePrefix = await client.listTools();
    for (const agentKind of ['codex', 'pi', 'unknown', 'claude-code', 'codex']) {
      context = { ...context, agentKind };
      const supported = agentKind === 'claude-code' || agentKind === 'pi';
      expect((await client.listTools()).tools.some((t) => t.name === 'ask_user_question_async')).toBe(supported);
      ask.mockClear();
      // A cached tool name must not open a second card through direct invocation.
      const result = await client.callTool({ name: 'ask_user_question_async', arguments: { questions } });
      expect(result.isError === true).toBe(!supported);
      expect(ask).toHaveBeenCalledTimes(supported ? 1 : 0);
      const alias = await client.callTool({ name: 'call_tool', arguments: { name: 'ask_user_question_async', args: { questions } } });
      expect(alias.isError).toBe(true);
    }
    context = { ...context, agentKind: 'claude-code' };
    expect(await client.listTools()).toEqual(claudePrefix);
  } finally { await client.close(); await server.close(); }
});
