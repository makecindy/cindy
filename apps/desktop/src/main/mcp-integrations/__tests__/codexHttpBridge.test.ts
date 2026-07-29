import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import {
  startCodexHttpBridge,
  type CodexHttpBridge,
} from '../codexHttpBridge.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../codexBuiltinToolPolicy.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'cindy_test', version: '1.0.0' });
  server.tool(
    'current_session',
    'Return the active lizi MCP session context session id.',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: getLiziMcpSessionContext()?.sessionId ?? 'no-session',
        },
      ],
    }),
  );
  return server;
}

async function readRpcResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text);
}

/**
 * Every JSON-RPC response in the reply, not just the first. A batched request
 * comes back as one SSE `data:` event per response, so `readRpcResponse`
 * (first event only) cannot see the whole batch.
 */
async function readAllRpcResponses(resp: Response): Promise<unknown[]> {
  const text = await resp.text();
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
  if (payloads.length > 0) return payloads.flat();
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe('codexHttpBridge', () => {
  let bridge: CodexHttpBridge | null = null;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = null;
  });

  it('routes tool calls by JSON-RPC params._meta.threadId', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-a', {
      agentKind: 'codex',
      sessionId: 'session-a',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'mcp-session-id': mcpSessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-a' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'session-a' }],
      },
    });
  });

  it('keeps the thread context when a batch sibling omits the thread id', async () => {
    // Regression: a JSON-RPC batch carrying a notification (no
    // params._meta.threadId) alongside a well-attributed tools/call used to
    // collapse extractCodexThreadId() to undefined for the WHOLE batch, so the
    // transport ran without runWithLiziMcpSessionContext. Providers reading the
    // context (cindy_browser's __mcpSessionId) then fell back to host-side
    // UI-focus inference — the cross-session routing bug, via batches.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch', {
      agentKind: 'codex',
      sessionId: 'session-batch',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        // Contextless sibling — legitimate per MCP, must be ignored here.
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    // 'no-session' here would mean the ALS context was dropped.
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-batch' }] },
    });
  });

  it('drops the thread context when a batched tool call itself lacks a thread id', async () => {
    // The permissiveness above stops at tools/call: an unattributed tool call
    // must NOT inherit a sibling's session. findBlockedToolCall fail-closes
    // this shape only for servers with a pluginId, so this server (no pluginId)
    // proves the guard also lives in extractCodexThreadId.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch', {
      agentKind: 'codex',
      sessionId: 'session-batch',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          // No _meta.threadId — poisons the batch on purpose.
          params: { name: 'current_session', arguments: {} },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      id?: number;
      result?: { content?: Array<{ text?: string }> };
    }>;
    expect(results.length).toBeGreaterThan(0);
    // No response may report the sibling's session — the batch is unattributed.
    for (const entry of results) {
      expect(entry.result?.content?.[0]?.text).not.toBe('session-batch');
    }
    // And the well-formed call did run, just without a context.
    expect(
      results.find((entry) => entry.id === 2)?.result?.content?.[0]?.text,
    ).toBe('no-session');
  });

  it('a sibling naming another thread cannot degrade a well-attributed call', async () => {
    // Sibling attribution must never win over the tool call's own: otherwise a
    // stray notification carrying some other threadId would strip the ALS
    // context and re-open the UI-focus fallback.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-x', 'session-x'],
      ['thread-y', 'session-y'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        // Notification pointing at a DIFFERENT registered thread.
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-y' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-x' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-x' }] },
    });
  });

  it('siblings disagreeing among themselves still cannot strip a call context', async () => {
    // Two non-tool siblings naming DIFFERENT threads used to short-circuit the
    // scan to undefined before the tools/call could claim the request — and
    // hasAmbiguousThreadContext ignores non-tool messages, so nothing rejected
    // it either: it just ran contextless, back to UI focus.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-x', 'session-x'],
      ['thread-y', 'session-y'],
      ['thread-z', 'session-z'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-y' } },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-z' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-x' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-x' }] },
    });
  });

  it('fail-closes a batch whose tool calls name two different threads', async () => {
    // Two registered+enabled threads coalesced into one batch: the per-call
    // policy checks pass, and extractCodexThreadId rightly refuses to pick a
    // context — but running contextless would route through the focused UI
    // session. Refusing to pick must therefore mean refusing to run.
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-one', 'session-one'],
      ['thread-two', 'session-two'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        // Plugin enabled on BOTH threads — findBlockedToolCall has no reason to
        // block either call on its own.
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify(
        ['thread-one', 'thread-two'].map((threadId, i) => ({
          jsonrpc: '2.0',
          id: i + 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId },
          },
        })),
      ),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      id?: number;
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }>;
    expect(results).toHaveLength(2);
    for (const entry of results) {
      // Rejected outright — and in particular NOT executed contextless, which
      // is what 'no-session' (or either session id) here would mean.
      expect(entry.result?.isError).toBe(true);
      expect(entry.result?.content?.[0]?.text).toMatch(/more than one session/);
    }
  });

  it('blocks a tool call using the policy frozen on its Codex thread', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-disabled', {
      agentKind: 'codex',
      sessionId: 'session-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-disabled' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('ssh') }],
      },
    });
  });

  it.each([
    ['a missing thread id', undefined],
    ['an unregistered thread id', 'thread-not-registered'],
  ])('fail-closes a policy-controlled tool call with %s', async (_label, threadId) => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          ...(threadId ? { _meta: { threadId } } : {}),
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('could not verify') }],
      },
    });
  });

  it('fail-closes a mixed JSON-RPC batch containing disabled tool calls', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch-disabled', {
      agentKind: 'codex',
      sessionId: 'session-batch-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {},
        },
        ...[2, 3].map((id) => ({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch-disabled' },
          },
        })),
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toEqual([
      expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: true }) }),
      expect.objectContaining({ id: 3, result: expect.objectContaining({ isError: true }) }),
    ]);
  });
});
