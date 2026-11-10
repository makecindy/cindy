import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer, type XdtHelperMcpDeps } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';

// Regression: optional questions must be independently discoverable from login handoff.
// Exercise real MCP listing/calls (unit); a choose-only host previously listed ask_owner.
// Entry: tools/list and tools/call preserve root-only provenance, no call_tool alias,
// and request-time identity. Handoff coverage lives in lizi_xdtHelperMcpServer.test.ts.

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

async function connect(deps: XdtHelperMcpDeps, factoryKind: 'claude-code' | 'codex' | 'pi', getContext: () => LiziMcpSessionContext | undefined) {
  const server = createXdtHelperMcpServer(deps, { agentKind: factoryKind, workingDir: '', getSessionContext: getContext });
  const client = new Client({ name: 'async-question-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const questions = [{ question: 'Which scope?', options: [{ label: 'Personal' }, { label: 'Both' }] }];

describe.each(['claude-code', 'pi'] as const)('%s independent async question', (agentKind) => {
  it('discovers and calls the same tool with request-time identity and a pending-only receipt', async () => {
    let context: LiziMcpSessionContext | undefined = {
      agentKind, workingDir: '/repo', sessionId: 'task-1', sessionInstanceId: 'instance-1',
      mcpCallerKind: 'root', mcpCallerAttested: true, remoteHostId: 'ssh-host',
    };
    const ask = vi.fn(() => 'question-1');
    const { client, close } = await connect({ askUserQuestionAsync: ask }, agentKind, () => context);
    const call = (args: Record<string, unknown>) => client.callTool({ name: 'ask_user_question_async', arguments: args });
    try {
      const prefix = await client.listTools();
      expect(prefix.tools.some((tool) => tool.name === 'ask_owner')).toBe(false);
      expect(prefix.tools.some((tool) => tool.name === 'ask_user_question_async')).toBe(true);
      const bypass = await client.callTool({ name: 'call_tool', arguments: { name: 'ask_user_question_async', args: { questions } } });
      expect(bypass.isError).toBe(true);
      expect(parse(await call({ questions }))).toEqual({ ok: true, request_id: 'question-1', status: 'pending' });
      expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task-1', remoteHostId: 'ssh-host' }), questions);
      context = { ...context!, sessionId: 'task-2', sessionInstanceId: 'instance-2' };
      const freeform = [{ question: 'What is the context?' }];
      await call({ questions: freeform });
      expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'task-2' }), freeform);
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
      expect((await call({})).isError).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
      ask.mockImplementationOnce(() => { throw new Error('stale instance'); });
      expect(parse(await call({ questions })).errorCode).toBe('QUESTION_UNAVAILABLE');
      expect(await client.listTools()).toEqual(prefix);
    } finally { await close(); }
  });
});

// The HTTP helper factory can serve different harnesses; its captured kind is
// not the authority for a tools/list or tools/call request.
it.each(['codex', 'claude-code'] as const)('keeps one choice entry per harness with a %s factory', async (factoryKind) => {
  let context: LiziMcpSessionContext = {
    agentKind: 'claude-code', workingDir: '/repo', sessionId: 'task', sessionInstanceId: 'instance',
    mcpCallerKind: 'root', mcpCallerAttested: true,
  };
  const ask = vi.fn(() => 'question');
  const { client, close } = await connect({ askUserQuestionAsync: ask }, factoryKind, () => context);
  try {
    const claudePrefix = await client.listTools();
    for (const agentKind of ['codex', 'pi', 'unknown', 'claude-code', 'codex']) {
      context = { ...context, agentKind };
      const supported = agentKind === 'claude-code' || agentKind === 'pi';
      // With only choices wired, a harness that owns its own questions has nothing here.
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
  } finally { await close(); }
});
