import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCAL_AGENT_CLIENT, MAIN_OWNED_SEND_CONTEXT, type InteractionDecision } from '@cindy/maker-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { mapClaudeHostedEvent } from '../controller/eventMap';
import { execServerActions, execServerCommand } from '../controller/execServerRelay';
import { collectProjectInstructionFiles } from '../controller/projectFiles';
import { approvalActionsFor, createRemoteAgentHandle, innerShellScript } from '../controller/proxyHandle';
import type { RemoteAgentRunClient } from '../controller/runClient';
import { credentialConfirmation, takeGroupSwitchState } from '../controller/startRemote';
import { EventLog, LineSplitter } from '../eventLog';
import { ExecutorGate } from '../executor/gate';
import { RemoteExecutor, type ExecutorConfirmation } from '../executor/executor';
import { handleExecMcpRequest } from '../executor/ccMcp';
import { ExecutorWorkspace } from '../executor/workspace';
import { createRunTunnel } from '../host/tunnel';
import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';
import { decodeOpenPayload, decodeStartOptions, encodeStartOptions, decodeSendOptions, encodeSendOptions, isSafeProjectFilePath } from '../wire';

let root: string;

it('encodes only application isolation, never its private URL, token, path or target', () => {
  const encoded = encodeStartOptions({ sessionId: 'client', workingDir: '/workspace', model: 'm', [LOCAL_AGENT_CLIENT]: {
    url: 'http://127.0.0.1:12345/private', token: 'private-token', storageDirectory: '/private-history', agentDeviceId: 'share:private', mcpName: 'hhh', hostToolsOnly: true,
  } });
  expect(decodeStartOptions(JSON.parse(JSON.stringify(encoded)))).toEqual(encoded);
  expect(JSON.stringify(encoded)).not.toMatch(/private|127\.0\.0\.1/);
  for (const patch of [{ storageKey: '../escape' }, { mcpName: 'cindy_exec' }, { hostToolsOnly: 'false' }]) {
    expect(() => decodeStartOptions({ ...encoded, localApplication: { ...encoded.localApplication, ...patch } })).toThrow('REMOTE_AGENT_INVALID');
  }
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-plumbing-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('event log', () => {
  it('serves bytes by cursor, re-reads idempotently and drops acknowledged data', async () => {
    const log = new EventLog(1024);
    log.append({ a: 1 });
    log.append({ b: 2 });
    const first = await log.read(0, 8, 0);
    expect(first).toMatchObject({ from: 0, cursor: 8 });
    // 回包丢失时同一游标重读，得到同一段。
    expect((await log.read(0, 8, 0)).data?.toString()).toBe(first.data?.toString());
    const rest = await log.read(first.cursor, 1024, 0);
    expect(Buffer.concat([first.data!, rest.data!]).toString()).toBe('{"a":1}\n{"b":2}\n');
    // 较旧的并发 poll：已确认的部分不再给，从仍保留的位置开始并标明起点。
    expect(await log.read(0, 8, 0)).toMatchObject({ from: 8, cursor: 16 });
    // 游标超出已写范围是无效的。
    await expect(log.read(99, 8, 0)).rejects.toThrow('REMOTE_AGENT_INVALID');
    log.end();
    expect(await log.read(rest.cursor, 1024, 0)).toEqual({ from: rest.cursor, cursor: rest.cursor, done: true });
  });

  it('waits for new data, refuses to grow past its limit, and splits lines across reads', async () => {
    const log = new EventLog(64);
    const pending = log.read(0, 1024, 2_000);
    setTimeout(() => log.append({ late: true }), 20);
    expect((await pending).data?.toString()).toBe('{"late":true}\n');
    expect(log.append({ big: 'x'.repeat(100) })).toBe(false);
    const splitter = new LineSplitter(1024);
    expect(splitter.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(splitter.push(Buffer.from(':2}\n'))).toEqual(['{"b":2}']);
    expect(() => new LineSplitter(4).push(Buffer.from('abcdef'))).toThrow();
  });
});

describe('tunnel', () => {
  // Regression: SDK cancellation uses a notification without closing its transport.
  // Real MCP Client -> tunnel -> executor, with a pending credential read (unit/loopback).
  // Socket-abort coverage did not catch stale execution/grants after a tool timeout.
  it.each(['timeout', 'abort'])('cancels an MCP tool through the SDK %s notification without accepting late approval', async (end) => {
    fs.writeFileSync(path.join(root, '.env'), 'INVALID_FIXTURE=secret');
    fs.writeFileSync(path.join(root, 'hello.txt'), 'ordinary read');
    const signals: AbortSignal[] = [];
    const answers: Array<(answer: ExecutorConfirmation) => void> = [];
    const workspace = new ExecutorWorkspace({ workingDir: root });
    const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
    const executor = new RemoteExecutor({
      workspace, gate, rgPath: '',
      confirm: (_action, signal) => {
        signals.push(signal);
        return new Promise((resolve) => { answers.push(resolve); });
      },
    });
    let streamStarted = false;
    const tunnel = await createRunTunnel({
      http: (request, signal) => handleExecMcpRequest(executor, request.method, request.body, signal),
      wsOpen() {}, wsMessage() {}, wsClose() {},
    });
    const client = new Client({ name: 'cancellation-test', version: '1' });
    const abort = new AbortController();
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${tunnel.url}/mcp/cindy_exec`), {
        requestInit: { headers: { authorization: `Bearer ${tunnel.token}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.headers.get('content-type')?.includes('text/event-stream')) streamStarted = true;
          return response;
        },
      }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const read = { name: 'Read', arguments: { file_path: path.join(root, '.env') } };
      const pending = client.callTool(read, undefined, { timeout: 60_000, signal: abort.signal }).catch((error: unknown) => error);
      await vi.waitFor(() => { expect(signals).toHaveLength(1); expect(streamStarted).toBe(true); });
      const ordinary = client.callTool({ name: 'Read', arguments: { file_path: path.join(root, 'hello.txt') } }, undefined, { timeout: 120_000 });
      if (end === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
      else abort.abort();
      expect(await pending).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
      answers[0]('session');
      expect(await ordinary).toMatchObject({ content: [expect.objectContaining({ text: expect.stringContaining('ordinary read') })] });
      await vi.waitFor(() => expect(tunnel.linkActivity().httpInFlight).toBe(0));
      const retry = client.callTool(read);
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      expect(gate.needsCredentialConsent({ kind: 'read', path: path.join(root, '.env') })).toBe(true);
      answers[1](false);
      expect(await retry).toMatchObject({ isError: true });
    } finally {
      abort.abort();
      await executor.close();
      for (const answer of answers) answer(false);
      await client.close();
      await tunnel.close();
      vi.useRealTimers();
    }
  });

  // Cancellation belongs to one run/session/typed request id. A reused id must survive
  // a late result from its cancelled predecessor, and a duplicate must not replace it (unit).
  it('isolates cancellation identities and keeps a reused id registered after a late result', async () => {
    const calls: Array<{ name: string; signal: AbortSignal; finish: () => void }> = [];
    const handlers: Parameters<typeof createRunTunnel>[0] = {
      http: (request, signal) => {
        const message = JSON.parse(request.body!.toString());
        if (message.method !== 'tools/call') return Promise.resolve({ status: 202, headers: [] });
        return new Promise((resolve) => calls.push({ name: message.params.name, signal,
          finish: () => resolve({ status: 200, headers: [['content-type', 'application/json']],
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } })) }),
        }));
      },
      wsOpen() {}, wsMessage() {}, wsClose() {},
    };
    const first = await createRunTunnel(handlers);
    const second = await createRunTunnel(handlers);
    const post = (tunnel: typeof first, session: string, body: unknown, token = tunnel.token) => fetch(`${tunnel.url}/mcp/cindy_exec`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': session, accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const call = (tunnel: typeof first, session: string, id: string | number, name: string) =>
      post(tunnel, session, { jsonrpc: '2.0', id, method: 'tools/call', params: { name } });
    const cancel = (tunnel: typeof first, session: string, requestId: string | number, token?: string) =>
      post(tunnel, session, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }, token);
    try {
      const responses = await Promise.all([
        call(first, 'a', 0, 'original'), call(first, 'a', '0', 'string-id'),
        call(first, 'b', 0, 'other-session'), call(second, 'a', 0, 'other-run'),
      ]);
      expect((await call(first, 'a', 0, 'duplicate')).status).toBe(400);
      expect(calls).toHaveLength(4);
      expect((await cancel(first, 'a', 0, 'wrong-token')).status).toBe(401);
      expect((await cancel(first, 'a', 'unknown')).status).toBe(202);
      expect(calls.every((entry) => !entry.signal.aborted)).toBe(true);
      expect((await cancel(first, 'a', 0)).status).toBe(202);
      expect(calls.filter((entry) => entry.signal.aborted).map((entry) => entry.name)).toEqual(['original']);
      expect(await responses[0].text()).toContain('Request cancelled.');
      const reused = await call(first, 'a', 0, 'reused');
      calls.find((entry) => entry.name === 'original')!.finish();
      await vi.waitFor(() => expect(first.linkActivity().httpInFlight).toBe(3));
      await cancel(first, 'a', 0);
      expect(calls.find((entry) => entry.name === 'reused')!.signal.aborted).toBe(true);
      expect(await reused.text()).toContain('Request cancelled.');
      for (const entry of calls) entry.finish();
      for (const response of responses.slice(1)) expect(await response.text()).toContain('"result"');
      await vi.waitFor(() => {
        expect(first.linkActivity().httpInFlight).toBe(0);
        expect(second.linkActivity().httpInFlight).toBe(0);
      });
    } finally {
      for (const entry of calls) entry.finish();
      await first.close();
      await second.close();
    }
  });

  // 60s 首次响应超时：真实 tunnel 必须先返回 MCP SSE，等待业务结果时保持连接；旧用例都是立即返回(unit)。
  it('starts an MCP tool response before confirmation and finishes it with the original result', async () => {
    let answer!: (value: { status: number; headers: Array<[string, string]>; body: Buffer }) => void;
    const tunnel = await createRunTunnel({
      http: () => new Promise((resolve) => { answer = resolve; }),
      wsOpen() {}, wsMessage() {}, wsClose() {},
    });
    const abort = new AbortController();
    let received = false;
    const response = fetch(`${tunnel.url}/mcp/cindy_exec`, {
      method: 'POST', signal: abort.signal,
      headers: { authorization: `Bearer ${tunnel.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'Read', arguments: { file_path: '.env' } } }),
    }).then((value) => { received = true; return value; });
    void response.catch(() => {});
    try {
      await vi.waitFor(() => expect(received).toBe(true), { timeout: 1000 });
      const stream = await response;
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const result = { jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: 'fixture' }] } };
      answer({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify(result)) });
      const data = (await stream.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
      expect(data).toEqual([result]);
    } finally {
      abort.abort();
      answer?.({ status: 200, headers: [], body: Buffer.from('{}') });
      await tunnel.close();
    }
  });

  // 同一生产 HTTP 入口：SSE 不能改变 JSON 客户端、初始化与其他 MCP 服务的状态码/响应(unit)。
  it.each([
    ['/mcp/cindy_exec', 'application/json', 'tools/call'],
    ['/mcp/cindy_exec', 'text/event-stream', 'initialize'],
    ['/mcp/other', 'text/event-stream', 'tools/call'],
  ])('preserves the ordinary response for %s accepting %s on %s', async (endpoint, accept, method) => {
    const tunnel = await createRunTunnel({
      http: async () => ({ status: 409, headers: [['content-type', 'application/json']], body: Buffer.from('{"error":"fixture"}') }),
      wsOpen() {}, wsMessage() {}, wsClose() {},
    });
    try {
      const response = await fetch(`${tunnel.url}${endpoint}`, {
        method: 'POST', headers: { authorization: `Bearer ${tunnel.token}`, accept },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ error: 'fixture' });
    } finally { await tunnel.close(); }
  });

  // 流已建立后无法改 HTTP 状态；失败必须收口成对应请求的协议错误，不能泄露内部异常(unit)。
  it.each(['status', 'invalid-json', 'empty', 'throw'])('ends an MCP stream with a protocol error on %s', async (failure) => {
    const tunnel = await createRunTunnel({
      http: async () => {
        if (failure === 'throw') throw new Error('PRIVATE_FIXTURE_PATH');
        return { status: failure === 'status' ? 502 : 200, headers: [],
          ...(failure === 'empty' ? {} : { body: Buffer.from('PRIVATE_FIXTURE_PATH') }) };
      },
      wsOpen() {}, wsMessage() {}, wsClose() {},
    });
    try {
      const response = await fetch(`${tunnel.url}/mcp/cindy_exec`, {
        method: 'POST', headers: { authorization: `Bearer ${tunnel.token}`, accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call' }),
      });
      const body = await response.text();
      expect(body).not.toContain('PRIVATE_FIXTURE_PATH');
      expect(JSON.parse(body.split('\n').find((line) => line.startsWith('data:'))!.slice(5)))
        .toMatchObject({ jsonrpc: '2.0', id: 'call-1', error: { code: -32603 } });
    } finally { await tunnel.close(); }
  });

  // 旧用例没有挂起 SSE：等待期间有心跳，客户端取消必须中止反向请求并清除心跳(unit)。
  it('keeps a pending MCP stream alive and cancels its reverse request and heartbeat on disconnect', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const tunnel = await createRunTunnel({
      http: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled(); reject(new Error('aborted')); }, { once: true });
      }),
      wsOpen() {}, wsMessage() {}, wsClose() {},
    });
    const abort = new AbortController();
    try {
      const response = await fetch(`${tunnel.url}/mcp/cindy_exec`, {
        method: 'POST', signal: abort.signal,
        headers: { authorization: `Bearer ${tunnel.token}`, accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': waiting');
      vi.advanceTimersByTime(60_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': waiting');
      abort.abort();
      await cancellation;
      await vi.waitFor(() => expect(tunnel.linkActivity().httpInFlight).toBe(0));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      await tunnel.close();
      vi.useRealTimers();
    }
  });

  it('requires the run token in the header or the path prefix and strips the prefix', async () => {
    const seen: string[] = [];
    const tunnel = await createRunTunnel({
      http: async (request) => {
        seen.push(request.path);
        return { status: 200, headers: [['content-type', 'text/plain']], body: Buffer.from('ok') };
      },
      wsOpen: () => {},
      wsMessage: () => {},
      wsClose: () => {},
    });
    try {
      expect((await fetch(`${tunnel.url}/mcp/x`)).status).toBe(401);
      expect((await fetch(`${tunnel.url}/mcp/x`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(`${tunnel.url}/t/wrong/mcp/x`)).status).toBe(401);
      expect((await fetch(`${tunnel.url}/mcp/a?q=1`, { headers: { authorization: `Bearer ${tunnel.token}` } })).status).toBe(200);
      expect((await fetch(`${tunnel.url}/t/${tunnel.token}/mcp/b`)).status).toBe(200);
      expect(seen).toEqual(['/mcp/a?q=1', '/mcp/b']);
      // Cindy 工具请求也算链路往来，结束后不再计入在途。
      expect(tunnel.linkActivity()).toMatchObject({ httpInFlight: 0, lastActivityAt: expect.any(Number) });
    } finally {
      await tunnel.close();
    }
  });

  it('relays WebSocket frames only for authorized connections', async () => {
    const opened: string[] = [];
    const messages: string[] = [];
    const tunnel = await createRunTunnel({
      http: async () => ({ status: 404, headers: [] }),
      wsOpen: (connId, wsPath) => opened.push(`${connId}:${wsPath}`),
      wsMessage: (_connId, data) => messages.push(data),
      wsClose: () => {},
    });
    try {
      const wsUrl = tunnel.url.replace('http', 'ws');
      await new Promise<void>((resolve) => {
        const bad = new WebSocket(`${wsUrl}/ws/exec-server`);
        bad.on('error', () => resolve());
        bad.on('unexpected-response', () => resolve());
      });
      const good = new WebSocket(`${wsUrl}/ws/exec-server`, { headers: { authorization: `Bearer ${tunnel.token}` } });
      const echoed = new Promise<string>((resolve) => good.on('message', (data) => resolve(String(data))));
      await new Promise<void>((resolve) => good.on('open', () => resolve()));
      good.send('{"id":1,"method":"fs/readFile","params":{}}');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(opened).toEqual(['c1:/ws/exec-server']);
      expect(messages).toEqual(['{"id":1,"method":"fs/readFile","params":{}}']);
      expect(tunnel.linkActivity()).toMatchObject({ execRequests: 1, execResponses: 0, execOldestPending: { method: 'fs/readFile' } });
      tunnel.sendWs('c1', '{"id":1,"result":true}');
      expect(await echoed).toBe('{"id":1,"result":true}');
      // 隧道两个方向的帧都记进往来(托管 Codex 据此判断慢启动仍在推进)。
      expect(tunnel.linkActivity()).toMatchObject({ execRequests: 1, execResponses: 1 });
      expect(tunnel.linkActivity().execOldestPending).toBeUndefined();
      expect(tunnel.linkActivity().lastActivityAt).toEqual(expect.any(Number));
      good.close();
    } finally {
      await tunnel.close();
    }
  });
});

describe('remote AgentSessionHandle close', () => {
  // #6921 unit: the production handle must distinguish remote notification failure
  // from local cleanup failure. The navigation-only test below missed this boundary.
  // Minimal inputs: a pending/rejected close and an onClosed cleanup still in flight.
  // Deferred promises exercise ordering without sleeps or real Agent processes.
  it.each(['close', 'detach'] as const)('releases local resources before account-boundary %s notification settles', async (mode) => {
    let failRemote!: (error: Error) => void;
    const remote = new Promise<void>((_resolve, reject) => { failRemote = reject; });
    const close = vi.fn(() => remote);
    const dispose = vi.fn(async () => undefined);
    const warn = vi.fn();
    const controller = createRemoteAgentHandle({
      client: { close } as unknown as RemoteAgentRunClient,
      started: { id: 'pi-1', agentKind: 'pi', model: 'm', shadowDir: '', methods: [], state: {} },
      workspace: new ExecutorWorkspace({ workingDir: root }),
      recordApproval: () => undefined, newId: () => 'req', dispose, log: { warn },
    });
    const closing = controller.handle[mode]!({ reason: 'account-boundary' });
    const outcome = Promise.allSettled([closing]);
    const remoteError = new Error('[DEVICE_LINK_NOT_CONNECTED] provider sharing is not ready');
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledWith(mode, 'account-boundary');
      expect(dispose).toHaveBeenCalledOnce();
      // Local event consumers can finish while the remote notification is pending.
      expect(await controller.handle.events()[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
      failRemote(remoteError);
      expect(await outcome).toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { error: String(remoteError) });
    } finally {
      failRemote(remoteError);
      await outcome;
    }
  });

  it.each(['resolve', 'reject'] as const)('shares onClosed cleanup and its %s result across close and detach', async (result) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const cleanup = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const dispose = vi.fn(() => cleanup);
    const controller = createRemoteAgentHandle({
      client: { close: async () => undefined } as unknown as RemoteAgentRunClient,
      started: { id: 'pi-1', agentKind: 'pi', model: 'm', shadowDir: '', methods: [], state: {} },
      workspace: new ExecutorWorkspace({ workingDir: root }),
      recordApproval: () => undefined, newId: () => 'req', dispose, log: { warn: vi.fn() },
    });
    controller.onClosed('closed');
    let settled = false;
    const pending = Promise.allSettled([
      controller.handle.close({ reason: 'account-boundary' }),
      controller.handle.detach!({ reason: 'account-boundary' }),
    ]).then((outcomes) => { settled = true; return outcomes; });
    const localError = new Error('local executor did not stop');
    try {
      // Let already-resolved remote calls settle; the local gate must still block both callers.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(dispose).toHaveBeenCalledOnce();
      if (result === 'reject') fail(localError);
      else finish();
      const expected = result === 'reject'
        ? { status: 'rejected', reason: localError }
        : { status: 'fulfilled', value: undefined };
      expect(await pending).toEqual([expected, expected]);
      expect(await Promise.allSettled([controller.handle.close({ reason: 'account-boundary' })])).toEqual([expected]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      finish();
      await pending;
    }
  });

  it('propagates a DEVICE_LINK close failure after disposing local resources', async () => {
    let disposed = 0;
    const client = {
      async close() {
        throw Object.assign(new Error('[REMOTE_AGENT_UNAVAILABLE] [DEVICE_LINK_DEVICE_OFFLINE] target offline'), {
          code: 'DEVICE_OFFLINE',
        });
      },
    } as unknown as RemoteAgentRunClient;
    const controller = createRemoteAgentHandle({
      client,
      started: { id: 'sdk-1', agentKind: 'claude-code', model: 'm', shadowDir: '', methods: [], state: {} },
      workspace: new ExecutorWorkspace({ workingDir: root }),
      recordApproval: () => undefined,
      newId: () => 'req',
      dispose: async () => { disposed += 1; },
    });
    await expect(controller.handle.close({ reason: 'navigation' })).rejects.toThrow(/DEVICE_LINK_DEVICE_OFFLINE/);
    expect(disposed).toBe(1);
  });
});

describe('confirmations raised on this computer', () => {
  it('uses the Agent confirmation channel and offers an explicit credential grant for this task', async () => {
    let next = 0;
    const controller = createRemoteAgentHandle({
      client: {} as RemoteAgentRunClient,
      started: { id: 'sdk-1', agentKind: 'claude-code', model: 'm', shadowDir: '', methods: [], state: {} },
      workspace: new ExecutorWorkspace({ workingDir: root }),
      recordApproval: () => undefined,
      newId: () => `req-${(next += 1)}`,
      dispose: async () => undefined,
    });
    const env = path.join(root, '.env');
    const request = credentialConfirmation({ kind: 'read', path: env }, 'goes through the sharer');
    // 交互还没接上：按拒绝处理。
    expect(await controller.confirm(request)).toBe(false);
    const seen: unknown[] = [];
    let behavior: 'allow' | 'deny' = 'allow';
    controller.handle.setInteractionResolver(async (incoming) => {
      seen.push(incoming);
      return { kind: 'permission', behavior };
    });
    expect(await controller.confirm(request)).toBe(true);
    expect(seen).toEqual([{
      kind: 'permission',
      requestId: 'req-1',
      toolName: 'Read',
      input: { file_path: env },
      description: 'goes through the sharer',
      metadata: { hostOwnedConfirmation: 'shared_provider_credential' },
      suggestions: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
    }]);
    behavior = 'deny';
    expect(await controller.confirm(request)).toBe(false);
    expect(credentialConfirmation({ kind: 'exec', command: 'cat .env', cwd: root }, 'x')).toMatchObject({
      toolName: 'Bash',
      input: { command: 'cat .env' },
    });
  });

  it('accepts a session grant only when offered by this computer, and ignores late answers', async () => {
    const controller = createRemoteAgentHandle({
      client: {} as RemoteAgentRunClient,
      started: { id: 'sdk-1', agentKind: 'claude-code', model: 'm', shadowDir: '', methods: [], state: {} },
      workspace: new ExecutorWorkspace({ workingDir: root }),
      recordApproval: () => undefined,
      newId: () => 'req',
      dispose: async () => undefined,
    });
    const request = credentialConfirmation({ kind: 'read', path: path.join(root, '.env') }, 'shared credentials');
    controller.handle.setInteractionResolver(async () => ({
      kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
    }));
    expect(await controller.confirm(request)).toBe('session');
    expect(await controller.confirm({ ...request, suggestions: [] })).toBe(true);
    expect(await controller.confirm({ ...request, metadata: {} })).toBe(true);
    for (const permissionUpdates of [
      [{ ...PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL, destination: 'userSettings' }],
      [{ ...PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL, mode: 'bypassPermissions' }],
      [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL, { type: 'setMode', destination: 'session' }],
    ]) {
      controller.handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow', permissionUpdates }));
      expect(await controller.confirm(request)).toBe(true);
    }
    // 远端的普通交互仍只登记同一操作，不建立本机的凭证授权。
    const remote = await controller.onRequest({ type: 'interaction', request: { ...request, kind: 'permission', requestId: 'remote' } });
    expect(remote?.type).toBe('interaction');

    let answer!: (decision: InteractionDecision) => void;
    controller.handle.setInteractionResolver(() => new Promise((resolve) => { answer = resolve; }));
    const pending = controller.confirm(request);
    controller.onClosed('closed');
    answer({ kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL] });
    expect(await pending).toBe(false);
  });
});

describe('exec-server relay gate', () => {
  it('maps exec-server requests to the actions checked on this computer', () => {
    expect(execServerCommand(['/bin/zsh', '-lc', 'echo hi'])).toBe('echo hi');
    expect(execServerCommand(['git', 'status'])).toBe('git status');
    expect(execServerActions('process/start', { argv: ['/bin/bash', '-c', 'rm -rf /x'], cwd: `file://${root}` }, '/w'))
      .toEqual([{ kind: 'exec', command: 'rm -rf /x', cwd: root }]);
    expect(execServerActions('fs/writeFile', { path: `file://${root}/a.txt`, dataBase64: '' }, '/w'))
      .toEqual([{ kind: 'write', path: path.join(root, 'a.txt') }]);
    expect(execServerActions('fs/readFile', { path: `file://${root}/.env` }, '/w'))
      .toEqual([{ kind: 'read', path: path.join(root, '.env') }]);
    expect(execServerActions('fs/getMetadata', { path: `file://${root}/.git` }, '/w')).toEqual([]);
    expect(execServerActions('initialize', {}, '/w')).toEqual([]);
    // 只读操作按读取：walk 是目录级读取，open 只开只读句柄，canonicalize 只解析路径。
    const skills = path.join(root, '.agents', 'skills');
    expect(execServerActions('fs/walk', { path: pathToFileURL(skills).href, options: { maxDepth: 6 } }, '/w'))
      .toEqual([{ kind: 'read', path: skills, scope: 'tree' }]);
    expect(execServerActions('fs/open', { handleId: 'h1', path: pathToFileURL(path.join(root, 'a.png')).href }, '/w'))
      .toEqual([{ kind: 'read', path: path.join(root, 'a.png') }]);
    expect(execServerActions('fs/open', { handleId: 'h2', mode: 'replace', path: pathToFileURL(path.join(root, 'a.png')).href }, '/w'))
      .toEqual([{ kind: 'write', path: path.join(root, 'a.png') }]);
    expect(execServerActions('fs/canonicalize', { path: pathToFileURL(skills).href }, '/w')).toEqual([]);
    // 不认识的 fs 方法仍从严按写入。
    expect(execServerActions('fs/futureMethod', { path: pathToFileURL(skills).href }, '/w'))
      .toEqual([{ kind: 'write', path: skills }]);
  });

  it('lets read-only exec-server operations follow the read rules (#5764)', () => {
    const project = path.join(root, 'game');
    const client = path.join(project, 'client');
    fs.mkdirSync(client, { recursive: true });
    const skills = pathToFileURL(path.join(project, '.agents', 'skills')).href;
    const agentsMd = pathToFileURL(path.join(project, 'AGENTS.md')).href;
    const decide = (gate: ExecutorGate, method: string, params: Record<string, unknown>) =>
      execServerActions(method, params, '/w').map((action) => gate.authorize(action).ok);

    // 计划模式：工作区里的 Skill 遍历与只读打开不再算写入。
    const plan = new ExecutorGate(new ExecutorWorkspace({ workingDir: project }), 'plan');
    expect(decide(plan, 'fs/walk', { path: skills })).toEqual([true]);
    expect(decide(plan, 'fs/open', { handleId: 'h1', path: agentsMd })).toEqual([true]);
    expect(decide(plan, 'fs/open', { handleId: 'h2', mode: 'replace', path: agentsMd })).toEqual([false]);

    // 任务在子目录：上级目录的单文件读取照读取规则放行，递归遍历仍要本机确认。
    const sub = new ExecutorGate(new ExecutorWorkspace({ workingDir: client }), 'normal');
    expect(decide(sub, 'fs/open', { handleId: 'h1', path: agentsMd })).toEqual([true]);
    expect(decide(sub, 'fs/walk', { path: skills })).toEqual([false]);
    expect(decide(sub, 'fs/canonicalize', { path: skills })).toEqual([]);
  });

  it('matches Codex and Claude Code confirmations to the commands and files that later run', () => {
    const workspace = new ExecutorWorkspace({ workingDir: root });
    expect(innerShellScript("/bin/zsh -lc 'rm -rf /tmp/x; echo it'\\''s'")).toBe("rm -rf /tmp/x; echo it's");
    expect(approvalActionsFor({
      kind: 'permission', requestId: 'r', toolName: 'exec', input: { command: "/bin/zsh -lc 'rm -rf /tmp/x'", cwd: root },
    }, workspace)).toEqual([{ kind: 'exec', command: 'rm -rf /tmp/x', cwd: root }]);
    expect(approvalActionsFor({
      kind: 'permission', requestId: 'r', toolName: 'file_change', input: { changes: [{ path: path.join(root, '.env') }] },
    }, workspace)).toEqual([{ kind: 'write', path: path.join(root, '.env') }]);
    expect(approvalActionsFor({
      kind: 'permission', requestId: 'r', toolName: 'Edit', input: { file_path: 'src/a.ts' },
    }, workspace)).toEqual([{ kind: 'write', path: path.join(root, 'src/a.ts') }]);
    // 受邀者任务里本机提供的 WebFetch：登记批准过的地址。
    expect(approvalActionsFor({
      kind: 'permission', requestId: 'r', toolName: 'mcp__cindy_exec__WebFetch', input: { url: ' http://10.0.0.5/wiki ', prompt: 'x' },
    }, workspace)).toEqual([{ kind: 'fetch', url: 'http://10.0.0.5/wiki' }]);
    expect(approvalActionsFor({ kind: 'ask_user_question', requestId: 'r', questions: [] }, workspace)).toEqual([]);
  });
});

describe('wire payloads', () => {
  it('accepts imported files with relative paths and personal files in the new Skill and rule folders', () => {
    const payload = decodeOpenPayload({
      sessionId: 's1',
      options: { model: 'm' },
      workspace: { workingDir: '/p', platform: 'darwin', extraDirs: [], writableDirs: [] },
      projectFiles: [],
      importFiles: [
        { base: 'workspace', path: '../../.claude/style.md', data: 'eA==' },
        { base: 'session', path: 'RTK.md', data: 'eA==' },
        { base: 'elsewhere', path: 'x.md', data: 'eA==' },
        { base: 'workspace', path: '/etc/passwd', data: 'eA==' },
        { base: 'workspace', path: 'a\\b.md', data: 'eA==' },
        { base: 'workspace', path: 'a/./b.md', data: 'eA==' },
      ],
      personal: {
        files: [
          { path: '.claude/rules/tone.md', data: '' },
          { path: '.agents/skills/review/SKILL.md', data: '' },
          { path: '.codex/skills/deploy/SKILL.md', data: '' },
          { path: '.pi/extensions/run.ts', data: '' },
        ],
      },
      mcpServers: [],
    });
    expect(payload.importFiles).toEqual([
      { base: 'workspace', path: '../../.claude/style.md', data: 'eA==' },
      { base: 'session', path: 'RTK.md', data: 'eA==' },
    ]);
    expect(payload.personal.files.map((file) => file.path)).toEqual([
      '.claude/rules/tone.md',
      '.agents/skills/review/SKILL.md',
      '.codex/skills/deploy/SKILL.md',
    ]);
  });

  it('rejects unsafe project file paths and unknown platforms', () => {
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', '.git/config', 'C:/x', 'a\\b', '']) {
      expect(isSafeProjectFilePath(bad)).toBe(false);
    }
    expect(isSafeProjectFilePath('.claude/skills/a/SKILL.md')).toBe(true);
    const payload = decodeOpenPayload({
      sessionId: 's1',
      options: { model: 'm' },
      workspace: { workingDir: '/p', platform: 'darwin', extraDirs: [], writableDirs: [] },
      projectFiles: [{ path: '../evil', data: '' }, { path: 'AGENTS.md', data: 'eA==' }],
      mcpServers: ['cindy_memory', 'bad name'],
    });
    expect(payload.projectFiles.map((file) => file.path)).toEqual(['AGENTS.md']);
    expect(payload.mcpServers).toEqual(['cindy_memory']);
    expect(payload).not.toHaveProperty('groupAssigned');
    // 供应商组分配的任务带防转圈标记；只认 true。
    const base = { sessionId: 's1', options: { model: 'm' }, workspace: { workingDir: '/p', platform: 'darwin' } };
    expect(decodeOpenPayload({ ...base, groupAssigned: true }).groupAssigned).toBe(true);
    expect(decodeOpenPayload({ ...base, groupAssigned: 'yes' })).not.toHaveProperty('groupAssigned');
    // 组所在电脑替受邀者中转的任务带不透明的 relay 键；格式不对丢弃。
    expect(decodeOpenPayload({ ...base, relay: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }).relay).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(decodeOpenPayload({ ...base, relay: '../x' })).not.toHaveProperty('relay');
    // 「需要换一台」：声明只认 true，凭证格式不对丢弃。
    expect(decodeOpenPayload({ ...base, acceptsGroupSwitch: true }).acceptsGroupSwitch).toBe(true);
    expect(decodeOpenPayload({ ...base, acceptsGroupSwitch: 1 })).not.toHaveProperty('acceptsGroupSwitch');
    expect(decodeOpenPayload({ ...base, groupSwitchToken: 'Zm9vYmFyYmF6cXV4MTIzNDU2' }).groupSwitchToken).toBe('Zm9vYmFyYmF6cXV4MTIzNDU2');
    expect(decodeOpenPayload({ ...base, groupSwitchToken: 'short' })).not.toHaveProperty('groupSwitchToken');
    // 上级目录标记：被控端据此把「没有」的答成不存在，格式有任何不对都整段丢弃(按没带处理，照常逐个转发)，
    // 不能把存在的路径答成不存在。
    const markers = { names: ['.git', '.codex-plugin'], levels: [{ up: 1, present: ['.git'] }, { up: 2, present: [] }] };
    expect(decodeOpenPayload({ ...base, ancestorMarkers: markers }).ancestorMarkers).toEqual(markers);
    for (const bad of [
      { names: ['../x'], levels: [{ up: 1, present: [] }] },
      { names: ['.git'], levels: [{ up: 1, present: ['.svn'] }] },
      { names: ['.git'], levels: [{ up: 0, present: [] }] },
      { names: ['.git'], levels: [{ up: 1, present: [] }, { up: 1, present: [] }] },
      { names: ['a/b'], levels: [{ up: 1, present: [] }] },
    ]) {
      expect(decodeOpenPayload({ ...base, ancestorMarkers: bad })).not.toHaveProperty('ancestorMarkers');
    }
    expect(() => decodeOpenPayload({ sessionId: 's', options: { model: 'm' }, workspace: { workingDir: '/p', platform: 'beos' } })).toThrow();
  });

  it('takes the provider group switch token out of the state instead of merging it', () => {
    const offered: string[] = [];
    const offer = (token: string) => offered.push(token);
    const state = { turnRunning: true };
    expect(takeGroupSwitchState(state, offer)).toBe(state);
    expect(takeGroupSwitchState({ providerGroupSwitch: 'Zm9vYmFyYmF6cXV4MTIzNDU2' }, offer)).toBeNull();
    expect(takeGroupSwitchState({ providerGroupSwitch: 'Zm9vYmFyYmF6cXV4MTIzNDU2', model: 'm' }, offer)).toEqual({ model: 'm' });
    // 格式不对的凭证丢弃，也不进状态。
    expect(takeGroupSwitchState({ providerGroupSwitch: { evil: true }, model: 'm' }, offer)).toEqual({ model: 'm' });
    expect(takeGroupSwitchState({ providerGroupSwitch: 'Zm9vYmFyYmF6cXV4MTIzNDU2' }, undefined)).toBeNull();
    expect(offered).toEqual(['Zm9vYmFyYmF6cXV4MTIzNDU2', 'Zm9vYmFyYmF6cXV4MTIzNDU2']);
  });

  it('restores known per-turn policies and confirms everything for unknown ones', async () => {
    const encoded = await encodeSendOptions({
      turnPermissionPolicy: {
        origin: { kind: 'desktop' },
        confirmationSurface: 'desktop',
        forceConfirmToolCall: () => false,
      },
    }, async () => Buffer.alloc(0));
    const decoded = await decodeSendOptions(encoded.wire, {
      onTranscriptUserEntry: async () => {},
      onInteractionStateChange: () => {},
      writeAttachment: async () => '',
    });
    expect(decoded.turnPermissionPolicy?.forceConfirmToolCall('Read', {})).toBe(true);
  });

  it('carries Auto-review references in Main context and re-projects them on decode', async () => {
    const callbacks = { onTranscriptUserEntry: async () => {}, onInteractionStateChange: () => {}, writeAttachment: async () => '' };
    const autoReviewReferences = { attachments: { images: 1, files: 0 }, quotedMessages: [{ author: '群友', text: '[图片]', attachmentCount: 1 }] };
    const encoded = await encodeSendOptions({
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'im', channel: 'telegram' }, rawChannelText: '这啥情况', autoReviewReferences },
    }, async () => Buffer.alloc(0));
    const decoded = await decodeSendOptions(JSON.parse(JSON.stringify(encoded.wire)), callbacks);
    expect(decoded[MAIN_OWNED_SEND_CONTEXT]).toEqual({
      origin: { kind: 'im', channel: 'telegram' }, rawChannelText: '这啥情况', autoReviewReferences,
    });

    // Malformed or oversized peer data is bounded, never forwarded as-is; older peers omit it.
    const tampered = await decodeSendOptions({ cindy: { mainOwned: {
      origin: { kind: 'im', channel: 'telegram' }, rawChannelText: 'x',
      autoReviewReferences: { attachments: { images: 'all' }, quotedMessages: [{ text: 'y'.repeat(10_000), extra: 'grant' }] },
    } } }, callbacks);
    const references = tampered[MAIN_OWNED_SEND_CONTEXT]?.autoReviewReferences;
    expect(references?.attachments).toBeUndefined();
    expect(references?.quotedMessages?.[0]?.text.length).toBeLessThanOrEqual(600);
    expect(references?.quotedMessages?.[0]).not.toHaveProperty('extra');
    const legacy = await decodeSendOptions({ cindy: { mainOwned: { origin: { kind: 'im', channel: 'telegram' }, rawChannelText: 'x' } } }, callbacks);
    expect(legacy[MAIN_OWNED_SEND_CONTEXT]).toEqual({ origin: { kind: 'im', channel: 'telegram' }, rawChannelText: 'x' });
  });
});

describe('event mapping and project files', () => {
  it('shows the built-in tool names for Claude Code tools that run on this computer', () => {
    expect(mapClaudeHostedEvent({ type: 'tool_use', data: { toolName: 'mcp__cindy_exec__Bash', input: {} } }).data)
      .toEqual({ toolName: 'Bash', input: {} });
    expect(mapClaudeHostedEvent({ type: 'tool_use', data: { toolName: 'mcp__cindy_exec__WebFetch', input: { url: 'https://a.b' } } }).data)
      .toEqual({ toolName: 'WebFetch', input: { url: 'https://a.b' } });
    expect(mapClaudeHostedEvent({ type: 'tool_use', data: { toolName: 'mcp__cindy_memory__x' } }).data)
      .toEqual({ toolName: 'mcp__cindy_memory__x' });
  });

  it('syncs instructions and skills but never hooks, env or source files', async () => {
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# memory');
    fs.writeFileSync(path.join(root, 'index.ts'), 'source');
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'deploy', 'SKILL.md'), 'skill');
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'] },
      hooks: { PreToolUse: [] },
      env: { ANTHROPIC_BASE_URL: 'http://evil' },
    }));
    const files = await collectProjectInstructionFiles(root);
    expect(files.map((file) => file.path).sort()).toEqual(['.claude/settings.json', '.claude/skills/deploy/SKILL.md', 'CLAUDE.md']);
    const settings = JSON.parse(Buffer.from(files.find((file) => file.path === '.claude/settings.json')!.data, 'base64').toString());
    expect(settings).toEqual({ permissions: { allow: ['Bash(npm test:*)'] } });
  });
});
