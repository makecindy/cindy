import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";
import type { LiziMcpSessionContext } from '../types.js';

const TARGET_SESSION_ID = "11111111-1111-4111-8111-111111111111";

// Item 28, unit: the ordinary helper registry and public plugin entry must
// expose the same read-only catalog, with no self-reported caller fields.
it('discovers Host services through the common validated registry', async () => {
  const list = vi.fn(() => ({ scope: 'local', services: [{ group: 'scheduler', available: false }] }));
  const server = createXdtHelperMcpServer({ hostServices: { list } }, { agentKind: 'codex', workingDir: '' });
  try {
    expect(server.hostTools.describe('host_services')).toMatchObject({ category: 'discovery' });
    expect(parsePayload(await server.hostTools.call('host_services', {}))).toMatchObject({ ok: true, services: [{ available: false }] });
    expect(parsePayload(await server.hostTools.call('host_services', { pluginId: 'someone-else' }))).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(list).toHaveBeenCalledOnce();
  } finally { await server.close(); }
});
// Unit, #9801 / 4537273680: external-history scan/status callbacks also recover
// interrupted imports. Existing task tests did not cover a plugin caller. The
// real shared dispatcher must reject all three tools before any callback (and
// therefore recovery or source scan) runs, while preserving Agent behavior.
it('rejects plugin external-history imports without invoking recovery callbacks', async () => {
  const job = { requestId: 'import-1', status: 'running', items: [] };
  const sessionImport = {
    scan: vi.fn(async () => ({ candidates: [], hiddenCounts: {}, sources: [], sourceErrors: [] })),
    start: vi.fn(async () => job),
    status: vi.fn(async () => job),
  };
  const calls = [
    { tool: 'scan_importable_sessions', args: {} },
    { tool: 'get_session_import_status', args: { request_id: job.requestId } },
    { tool: 'import_sessions', args: { keys: ['codex:session'] } },
  ];
  const plugin = createXdtHelperMcpServer({ sessionImport }, { agentKind: 'codex', workingDir: '',
    hostCaller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 } });
  try {
    for (const { tool, args } of calls) {
      expect(parsePayload(await plugin.hostTools.call(tool, args)))
        .toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
    }
    for (const callback of Object.values(sessionImport)) expect(callback).not.toHaveBeenCalled();
  } finally { await plugin.close(); }
  const agent = createXdtHelperMcpServer({ sessionImport }, { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' });
  try {
    for (const { tool, args } of calls) expect(parsePayload(await agent.hostTools.call(tool, args))).toMatchObject({ ok: true, scope: 'local' });
    for (const callback of Object.values(sessionImport)) expect(callback).toHaveBeenCalledOnce();
  } finally { await agent.close(); }
});

// Unit production dispatcher, parity #13: deletion was absent. An explicit target must
// reach the same Host operation for task/plugin callers, while the current task stays protected.
it('deletes an explicit target through the shared lifecycle handler and protects the caller', async () => {
  const deleteSession = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ ok: true as const, sessionId, status: 'deleted' as const }));
  for (const context of [
    { agentKind: 'codex' as const, workingDir: '', sessionId: 'ordinary' },
    { agentKind: 'codex' as const, workingDir: '', hostCaller: { kind: 'plugin' as const, pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 } },
  ]) {
    const server = createXdtHelperMcpServer({ deleteSession } as Parameters<typeof createXdtHelperMcpServer>[0], context);
    expect(parsePayload(await server.hostTools.call('delete_session', { session_id: TARGET_SESSION_ID }))).toMatchObject({ ok: true, status: 'deleted' });
    expect(parsePayload(await server.hostTools.call('delete_session', {}))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    if (context.sessionId) expect(parsePayload(await server.hostTools.call('delete_session', { session_id: 'local::ordinary' }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    await server.close();
  }
  expect(deleteSession).toHaveBeenCalledTimes(2);
});

// Unit: the real MCP registry validates terminal parameters and resolves caller identity per call.
// Existing helper tests cover history/control, not Host-managed commands (requirement 22).
it('discovers and dispatches terminal jobs through the shared schema for tasks and plugins', async () => {
  const caller = { kind: 'plugin' as const, pluginId: 'console', dataOwnerId: 'owner', ownerGeneration: 1 };
  let context: LiziMcpSessionContext = { agentKind: 'codex', workingDir: '/task', sessionId: 'task' };
  const call = vi.fn(async (_context: LiziMcpSessionContext, _method: string, _args: Record<string, unknown>, _signal?: AbortSignal) => ({ scope: 'local', jobs: [] }));
  const server = createXdtHelperMcpServer({ terminal: { call } }, { agentKind: 'codex', workingDir: '', getSessionContext: () => context });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'terminal-test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    expect(parsePayload(await client.callTool({ name: 'list_tools', arguments: {} })).categories)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'terminal' })]));
    expect(parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'terminal_start', args: { program: { command: '/bin/sh', args: ['-c', 'printf ready'] } } } }))).toMatchObject({ ok: true });
    expect(call.mock.calls[0]).toMatchObject([context, 'terminal_start', { program: { command: '/bin/sh', args: ['-c', 'printf ready'] } }, expect.any(AbortSignal)]);
    context = { agentKind: 'codex', workingDir: '', hostCaller: caller };
    expect(parsePayload(await server.hostTools.call('terminal_list', {}))).toMatchObject({ ok: true, scope: 'local' });
    expect(call.mock.calls[1][0]).toEqual(context);
    expect(parsePayload(await server.hostTools.call('terminal_resize', { id: 'job', cols: 0, rows: 20 }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(parsePayload(await server.hostTools.call('terminal_start', { owner: 'other' }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(call).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});

// Unit: a managed-job admission failure must survive the shared MCP dispatcher;
// earlier dispatch tests only returned success, losing actionable capacity data.
it('returns the stable managed-job limit and capacity through the shared terminal tool', async () => {
  const call = vi.fn(async () => { throw Object.assign(new Error('TERMINAL_JOB_LIMIT'), { current: 10, limit: 10 }); });
  const server = createXdtHelperMcpServer({ terminal: { call } }, { agentKind: 'codex', workingDir: '' });
  try {
    const result = await server.hostTools.call('terminal_start', {});
    expect(result.isError).toBe(true);
    expect(parsePayload(result)).toMatchObject({ ok: false, errorCode: 'TERMINAL_JOB_LIMIT', data: { current: 10, limit: 10 } });
  } finally { await server.close(); }
});

// §21 unit: production registry discovery and schema validation were missing
// for authorized directory IO. One plugin reference must be forwarded intact;
// malformed operations must be rejected before the Host touches any files.
it('discovers the shared files service and validates its opaque directory requests', async () => {
  const context = { agentKind: 'codex' as const, workingDir: '', hostCaller: {
    kind: 'plugin' as const, pluginId: 'files', dataOwnerId: 'owner', ownerGeneration: 1,
  } };
  const call = vi.fn(async () => ({ ok: true, op: 'read', content: 'selected' }));
  const server = createXdtHelperMcpServer({ files: { call } }, context);
  try {
    expect(server.hostTools.describe('file_request')).toMatchObject({ category: 'files' });
    expect(parsePayload(await server.hostTools.call('file_request', { op: 'read', directoryRef: 'selected', path: 'a.txt' })))
      .toMatchObject({ ok: true, content: 'selected' });
    expect(call).toHaveBeenCalledExactlyOnceWith(context, { op: 'read', directoryRef: 'selected', path: 'a.txt' }, undefined);
    expect(parsePayload(await server.hostTools.call('file_request', { op: 'exec', directoryRef: 'selected' })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(call).toHaveBeenCalledOnce();
  } finally { await server.close(); }
});

// §27 unit: provider selection and explicit snapshot sharing must use the same
// public registry. Existing directory tests do not cover storage providers.
it('discovers storage providers through the public tool and rejects undeclared request shapes', async () => {
  const call = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, providers: [{ id: 'library' }] }));
  const server = createXdtHelperMcpServer({ storage: { call } }, { agentKind: 'codex', workingDir: '' });
  try {
    expect(server.hostTools.describe('storage_request')).toMatchObject({ category: 'storage' });
    expect(parsePayload(await server.hostTools.call('storage_request', { op: 'providers' })))
      .toMatchObject({ ok: true, providers: [{ id: 'library' }] });
    expect(parsePayload(await server.hostTools.call('storage_request', { op: 'share', targetPluginId: 'other' })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(call).toHaveBeenCalledOnce();
    const file = { name: 'business.json', size: 3, sha256: 'a'.repeat(64) };
    call.mockResolvedValueOnce({ ok: false, errorCode: 'SHARE_RESULT_UNKNOWN', targetPluginId: 'receiver', file });
    const uncertain = await server.hostTools.call('storage_request', { op: 'share', targetPluginId: 'receiver', source: { provider: 'kv', key: 'record' } });
    expect(uncertain.isError).toBe(true);
    expect(parsePayload(uncertain)).toMatchObject({ ok: false, errorCode: 'SHARE_RESULT_UNKNOWN', targetPluginId: 'receiver', file });
  } finally { await server.close(); }
});

it('validates attachment reads against the same history scope before host I/O', async () => {
  let denied = false;
  const readSessionAttachment = vi.fn(async () => ({ ok: true as const, base64: 'dGV4dA==', nextOffset: null }));
  const history = { readSessionAttachment, resolveSessionScope: async () => ({ ok: true as const, sessionIds: denied ? [] : null }),
    listWorkdirs: vi.fn(), listSessions: vi.fn(), getMessages: vi.fn(), searchChatHistory: vi.fn() };
  const server = createXdtHelperMcpServer({ history }, { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' });
  expect(parsePayload(await server.hostTools.call('read_session_attachment', { session_id: 'target', message_id: 'm', attachment_index: 0, mediaHash: 'a'.repeat(64) })))
    .toMatchObject({ ok: true, base64: 'dGV4dA==' });
  expect(readSessionAttachment).toHaveBeenCalledWith(expect.objectContaining({ mediaHash: 'a'.repeat(64) }), expect.any(Object));
  // Scope reduction: remote attachments must not enter any history/file transport.
  expect(parsePayload(await server.hostTools.call('read_session_attachment', { session_id: 'device::target', message_id: 'm', attachment_index: 0 })))
    .toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
  expect(parsePayload(await server.hostTools.call('read_session_attachment', { session_id: 'target', message_id: 'm', attachment_index: 0, mediaHash: 'invalid' })))
    .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  expect(parsePayload(await server.hostTools.call('read_session_attachment', { message_id: 'm', attachment_index: 0 })))
    .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  denied = true;
  expect(parsePayload(await server.hostTools.call('read_session_attachment', { session_id: 'target', message_id: 'm', attachment_index: 0 })))
    .toMatchObject({ ok: false, errorCode: 'HISTORY_SCOPE_DENIED' });
  expect(readSessionAttachment).toHaveBeenCalledOnce();
  await server.close();
});

// Unit: explicit remote targets need a plugin actor, never a fabricated dispatcher Session.
it('sends a plugin message to an explicit remote task without borrowing a sender task', async () => {
  const sendToRemoteSession = vi.fn(async () => ({ ok: true as const, agentKind: 'codex' as const, wakeKind: 'queued' as const, targetTitle: null, targetLastUserSendAt: null }));
  const server = createXdtHelperMcpServer({ sendToRemoteSession, sendToSession: vi.fn() }, { agentKind: 'codex', workingDir: '',
    hostCaller: { kind: 'plugin', pluginId: 'p', dataOwnerId: 'owner', ownerGeneration: 1 } });
  expect(parsePayload(await server.hostTools.call('send_to_session', { target_session_id: 'device::task', message: 'Continue' }))).toMatchObject({ ok: true, wake_kind: 'queued' });
  expect(sendToRemoteSession).toHaveBeenCalledWith({ deviceId: 'device', sessionId: 'task', message: 'Continue', dispatcherSessionId: undefined });
  await server.close();
});

// Unit via real registry: parity #15 adds exact message boundaries; old task controls
// cannot invoke fork/rewind. Plugins must name a target and never inherit a session.
it.each(['fork_session', 'rewind_session'] as const)('routes %s to the existing Host history operation', async tool => {
  const sessionHistory = vi.fn(async () => ({ ok: true as const, sessionId: 'result-task' }));
  const server = createXdtHelperMcpServer({ sessionHistory } as Parameters<typeof createXdtHelperMcpServer>[0], {
    agentKind: 'codex', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'p', dataOwnerId: 'owner', ownerGeneration: 1 },
  });
  expect(parsePayload(await server.hostTools.call(tool, { session_id: 'target', message_client_id: 'boundary' })))
    .toMatchObject({ ok: true, session_id: 'result-task' });
  expect(sessionHistory).toHaveBeenCalledWith(expect.objectContaining({ kind: tool === 'fork_session' ? 'fork' : 'rewind', sessionId: 'target', messageClientId: 'boundary', callerSessionId: undefined }));
  expect(parsePayload(await server.hostTools.call(tool, { message_client_id: 'boundary' })))
    .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  await server.close();
});

// Unit, real shared handler: ordinary tasks and plugins need the account directory,
// including paused/hidden companions and stored relationships, without a bot identity.
it('discovers the complete teammate directory through history for task and plugin callers', async () => {
  const listTeammates = vi.fn(async () => ({ ok: true as const, page: { items: [{ id: 'paused', status: 'paused', hiddenAt: 1 }],
    hasMore: true, nextCursor: { createdAt: 0, id: 'paused' } } }));
  const history = { listTeammates, listWorkdirs: vi.fn(), listSessions: vi.fn(), getMessages: vi.fn(), searchChatHistory: vi.fn() };
  const server = createXdtHelperMcpServer({ history }, { agentKind: 'codex', workingDir: '', sessionId: 'ordinary' });
  expect(server.hostTools.describe('list_teammates')).toMatchObject({ category: 'history' });
  expect(parsePayload(await server.hostTools.call('list_teammates', {}))).toMatchObject({ ok: true,
    teammates: [{ id: 'paused', status: 'paused', hiddenAt: 1 }], hasMore: true, nextCursor: expect.any(String) });
  expect(listTeammates).toHaveBeenCalledWith({ limit: 100, cursor: null }, 'ordinary');
  const result = parsePayload(await server.hostTools.call('list_teammates', { teammate_id: 'paused', limit: 1,
    cursor: Buffer.from(JSON.stringify({ c: 0, i: 'routine', r: 7 })).toString('base64url') }));
  expect(result).toMatchObject({ ok: true, teammateId: 'paused', relationships: expect.any(Array) });
  expect(listTeammates).toHaveBeenLastCalledWith({ teammateId: 'paused', limit: 1,
    cursor: { createdAt: 0, id: 'routine', rowid: 7 } }, 'ordinary');
  expect(parsePayload(await server.hostTools.call('list_teammates', { limit: 1001 }))).toMatchObject({ ok: false });
  await server.close();
});

// §1.2 Host tools: a plugin is a caller, never an impersonated Session. Native MCP and
// in-process callers must execute the same schema, handler, result and authorization path.
it('offers the same in-process handler to a plugin without borrowing a Session', async () => {
  const setSessionsStatus = vi.fn(async ({ sessionIds, status }) => ({ ok: true as const,
    changed: sessionIds.map((sessionId: string) => ({ sessionId, title: 'Task', workingDir: null, status })) }));
  const server = createXdtHelperMcpServer({ setSessionsStatus }, {
    agentKind: 'claude-code', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 },
  });
  expect(server.hostTools.describe('archive_sessions')).toMatchObject({ name: 'archive_sessions', category: 'control' });
  expect(parsePayload(await server.hostTools.call('archive_sessions', { session_ids: [TARGET_SESSION_ID] })))
    .toMatchObject({ ok: true, count: 1 });
  expect(parsePayload(await server.hostTools.call('archive_sessions', { sessionIds: [TARGET_SESSION_ID] })))
    .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  expect(setSessionsStatus).toHaveBeenCalledOnce();
  expect(server.hostTools.describe('request_input_handoff')).toBeUndefined();
  await server.close();
});

// Unit, real MCP wire: three harness contexts discover one shared capability.
// A read must never dispatch an association write; shared guests cannot use it.
it('exposes GitHub to all harnesses without implicit association', async () => {
  for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
    let restricted = false;
    const call = vi.fn(async () => ({ ok: true, state: 'open', head_sha: 'abc' }));
    const server = createXdtHelperMcpServer({ github: { call }, resolveSurface: async () => restricted ? 'restricted' : 'default' },
      { agentKind, workingDir: '/fixture', sessionId: 'current' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'github-read-test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const overview = parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      expect(overview.categories).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'github' })]));
      const tools = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'github' } }));
      expect(tools.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'get_pr_status' }), expect.objectContaining({ name: 'manage_session_prs' })]));
      const result = parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_pr_status', args: { pr: { repo: 'o/r', number: 1 } } } }));
      expect(result).toMatchObject({ ok: true, head_sha: 'abc' });
      expect(call).toHaveBeenCalledExactlyOnceWith('current', 'get_pr_status', { pr: { repo: 'o/r', number: 1 } });
      restricted = true;
      expect(parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_pr_status', args: { pr: { repo: 'o/r', number: 1 } } } }))).toMatchObject({ ok: false });
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  }
});

function parsePayload(result: unknown): Record<string, unknown> {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || !first.text) {
    throw new Error("tool result has no text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("cindy_helper MCP server", () => {
  // Unit through real MCP wire. Shared-task mode requires an authoritative current
  // task, never a selected window or caller-supplied target. Existing control tests
  // did not cover invitation discovery, live context loss or transferable receipts.
  it.each(['codex', 'claude-code', 'pi'] as const)('offers native current-task invitations to %s with live context and restricted-surface checks', async (agentKind) => {
    let context: LiziMcpSessionContext | undefined = {
      agentKind, workingDir: '/fixture', sessionId: 'current-task', sessionInstanceId: 'instance',
    };
    let restricted = false;
    const invitationLink = 'https://relay.example.test/shared-task/join#' + 'A'.repeat(43);
    const sharedTask = vi.fn(async (ctx: LiziMcpSessionContext, action: 'state' | 'invite') => ({
      ok: true as const, sessionId: ctx.sessionId!, device: 'local' as const, available: true, sharedTaskId: 'share',
      ...(action === 'invite' ? { invitationLink } : {}),
    }));
    const server = createXdtHelperMcpServer({ sharedTask, resolveSurface: async () => restricted ? 'restricted' : 'default' }, {
      ...context, agentKind, getSessionContext: () => context,
    });
    const client = new Client({ name: 'native-task-invitation-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => parsePayload(await client.callTool({
      name: 'call_tool', arguments: { name, args },
    }));
    try {
      const overview = parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      expect(overview.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'control', description: expect.stringContaining('create_shared_task_invitation') }),
      ]));
      const listed = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'control' } }));
      expect(listed.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'create_shared_task_invitation' }), expect.objectContaining({ name: 'get_shared_task_state' }),
      ]));
      expect(await call('create_shared_task_invitation')).toMatchObject({ ok: true, sessionId: 'current-task', sharedTaskId: 'share', invitationLink });
      expect(sharedTask).toHaveBeenLastCalledWith(context, 'invite');
      expect(await call('get_shared_task_state')).toMatchObject({ ok: true, sharedTaskId: 'share' });
      expect(await call('create_shared_task_invitation', { session_id: 'another-task' })).toMatchObject({ ok: false });
      expect(sharedTask).toHaveBeenCalledTimes(2);
      context = undefined;
      expect(await call('create_shared_task_invitation')).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
      expect(sharedTask).toHaveBeenCalledTimes(2);
      context = { agentKind, workingDir: '/fixture', sessionId: 'mobile-controlled-task', sessionInstanceId: 'next-instance' };
      expect(await call('get_shared_task_state')).toMatchObject({ ok: true, sessionId: 'mobile-controlled-task' });
      expect(sharedTask).toHaveBeenLastCalledWith(context, 'state');
      restricted = true;
      expect(await call('create_shared_task_invitation')).toMatchObject({ ok: false });
      expect(sharedTask).toHaveBeenCalledTimes(3);
      restricted = false;
      sharedTask.mockRejectedValue(new Error('private invitation ' + invitationLink));
      const failed = await call('create_shared_task_invitation');
      expect(failed).toMatchObject({ ok: false, errorCode: 'SHARED_TASK_RESULT_UNKNOWN' });
      expect(JSON.stringify(failed)).not.toContain(invitationLink);
    } finally { await client.close(); await server.close(); }
  });

  // The agent never found input handoff behind list_tools(auth) (2026-10-30).
  // Unit: a fresh client sees it in tools/list, with the window/title arguments,
  // before its first call. Removing ask_owner must preserve screenshot QR input,
  // which the old target-only entry could not accept. Minimal input: image without target.
  it.each(['codex', 'claude-code', 'pi'] as const)('offers %s independent input handoff for windows and screenshot QR codes', async (agentKind) => {
    const start = vi.fn(async () => ({ ok: true as const, requestId: 'handoff-1' }));
    const startImage = vi.fn(async () => ({ ok: true as const, requestId: 'handoff-image' }));
    let context: LiziMcpSessionContext = {
      agentKind, workingDir: '/repo', sessionId: 'current-task', sessionInstanceId: 'instance-1',
    };
    const server = createXdtHelperMcpServer({ inputHandoff: { start, startImage } }, {
      agentKind, workingDir: '/repo', sessionId: 'current-task',
      getSessionContext: () => context,
    });
    const client = new Client({ name: 'handoff-discovery-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const owner = (await client.listTools()).tools.find((tool) => tool.name === 'request_input_handoff')!;
      expect(owner.description).toContain('password');
      expect(owner.inputSchema).toMatchObject({
        required: ['purpose'],
        properties: {
          purpose: { type: 'string' },
          image: { type: 'string' },
          target: { type: 'object', properties: { app: { type: 'string' } } },
        },
      });
      const overview = parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      expect(overview.categories).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'auth' })]));
      expect(parsePayload(await client.callTool({ name: 'call_tool', arguments: {
        name: 'request_input_handoff', args: { purpose: 'Sign in to continue', target: { app: 'Google Chrome' } },
      } }))).toMatchObject({ ok: true, request_id: 'handoff-1', status: 'pending' });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'current-task' }), {
        purpose: 'Sign in to continue', target: { app: 'Google Chrome' },
      });
      expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
        purpose: 'Scan the simulator sign-in code', image: 'shots/qr.png',
      } }))).toMatchObject({ ok: true, request_id: 'handoff-image', status: 'pending' });
      expect(startImage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'current-task' }), {
        purpose: 'Scan the simulator sign-in code', image: 'shots/qr.png',
      });
      for (const args of [{}, { image: 'qr.png', target: {} }, { image: 'qr.png', complete_when: { window_closed: true } }]) {
        expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
          purpose: 'Sign in', ...args,
        } }))).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
      }
      // Preserve admission and immediate host failures when switching from the wrapper.
      context = { ...context, mcpCallerKind: 'descendant' };
      expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
        purpose: 'Sign in', image: 'qr.png',
      } }))).toMatchObject({ errorCode: 'ROOT_REQUIRED' });
      context = { ...context, mcpCallerKind: 'root', remoteHostId: 'ssh-host' };
      expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
        purpose: 'Sign in', image: 'qr.png',
      } }))).toMatchObject({ errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      context = { ...context, remoteHostId: undefined, sessionInstanceId: undefined };
      expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
        purpose: 'Sign in', target: {},
      } }))).toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
      context = { ...context, sessionInstanceId: 'instance-2', sessionId: 'next-task' };
      start.mockResolvedValueOnce({ ok: false, errorCode: 'TARGET_IS_CINDY', message: 'That window is Cindy itself.' } as never);
      expect(parsePayload(await client.callTool({ name: 'request_input_handoff', arguments: {
        purpose: 'Sign in', target: { app: 'Cindy' },
      } }))).toMatchObject({ errorCode: 'TARGET_IS_CINDY' });
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'next-task', sessionInstanceId: 'instance-2' }),
        { purpose: 'Sign in', target: { app: 'Cindy' } });
      expect(start).toHaveBeenCalledTimes(2);
      expect(startImage).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it.each(['default', 'bot-main'] as const)('exposes runtime declarations through the same helper tool for %s', async (surface) => {
    const runtimeCapabilities = vi.fn(async () => ({ ok: true, capabilities: [{ server: 'fixture' }] }));
    const server = createXdtHelperMcpServer({ resolveSurface: async () => surface, runtimeCapabilities }, {
      agentKind: 'pi', workingDir: '/repo', sessionId: 'current-task',
    });
    const client = new Client({ name: 'catalog-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = parsePayload(await client.callTool({ name: 'call_tool', arguments: {
        name: 'get_capabilities', args: { scope: 'runtime', server: 'fixture', category: 'files' },
      } }));
      expect(result).toMatchObject({ ok: true, capabilities: [{ server: 'fixture' }] });
      expect(runtimeCapabilities).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'current-task', agentKind: 'pi' }), { server: 'fixture', category: 'files' });
    } finally { await client.close(); await server.close(); }
  });

  it('offers update checks without installation only to a live local task', async () => {
    let context = {
      agentKind: 'codex' as const, workingDir: '/repo', sessionId: 'local-task',
      sessionInstanceId: 'instance-1', remoteHostId: undefined as string | undefined,
    };
    let current = true;
    const check = vi.fn(async () => ({ status: 'available', currentVersion: '0.1.86', targetVersion: '0.1.90' }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => 'default',
      appUpdate: {
        isCurrentSession: (sessionId, instanceId) => current && sessionId === 'local-task' && instanceId === 'instance-1',
        check,
      },
    }, {
      ...context, getSessionContext: () => context,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'app-update-test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string) => parsePayload(await client.callTool({
      name: 'call_tool', arguments: { name, args: {} },
    }));
    try {
      // Unit regression: natural update requests must discover the existing
      // install path without executing it; previously "更新 Cindy" returned none.
      for (const query of ['更新 Cindy', '升级 Cindy', 'update Cindy', 'upgrade Cindy']) {
        expect(parsePayload(await client.callTool({ name: 'list_tools', arguments: { query } })))
          .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ key: 'application.update' })]) });
      }
      const tools = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'app_update' } }));
      expect((tools.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'check_app_update',
      ]);
      expect(await call('check_app_update')).toMatchObject({ status: 'available', targetVersion: '0.1.90' });
      const detail = parsePayload(await client.callTool({ name: 'list_tools', arguments: { key: 'application.update' } }));
      expect(detail).toMatchObject({ control: { missingOperations: ['install_app_update'], notes: expect.any(String) } });
      expect(await call('install_app_update')).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' });
      expect(check).toHaveBeenCalledOnce();
      current = false;
      expect(await call('check_app_update')).toMatchObject({ ok: false, errorCode: 'STALE_SESSION' });
      context = { ...context, remoteHostId: 'remote-machine' };
      expect(await call('check_app_update')).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(check).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('routes install and auto-update requests to the Host with the bound caller', async () => {
    let current = true;
    const caller = { sessionId: 'local-task', sessionInstanceId: 'instance-1' };
    const check = vi.fn(async () => ({ status: 'available', currentVersion: '0.1.86', targetVersion: '0.1.90' }));
    const install = vi.fn(async (): Promise<Record<string, unknown>> => ({ status: 'started', targetVersion: '0.1.90' }));
    const setAutoUpdate = vi.fn(async (_caller: unknown, enabled: boolean) => enabled
      ? { status: 'updated', autoUpdateEnabled: true }
      : { ok: false, errorCode: 'OWNER_TURN_REQUIRED', message: 'owner only' });
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => 'default',
      appUpdate: { isCurrentSession: () => current, check, install, setAutoUpdate },
    }, {
      agentKind: 'claude-code', workingDir: '/repo', sessionId: 'local-task',
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: '/repo', ...caller }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'app-install-test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => parsePayload(await client.callTool({
      name: 'call_tool', arguments: { name, args },
    }));
    try {
      const tools = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'app_update' } }));
      expect((tools.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'check_app_update', 'install_app_update', 'set_app_auto_update',
      ]);
      expect(await call('check_app_update')).toMatchObject({ ok: true, status: 'available' });
      expect(check).toHaveBeenCalledWith(caller);
      expect(await call('install_app_update')).toMatchObject({ ok: true, status: 'started', targetVersion: '0.1.90' });
      expect(install).toHaveBeenCalledWith(caller);
      expect(await call('set_app_auto_update', { enabled: true })).toMatchObject({ ok: true, autoUpdateEnabled: true });
      expect(await call('set_app_auto_update', { enabled: false })).toMatchObject({
        ok: false, errorCode: 'OWNER_TURN_REQUIRED', data: { hint: 'owner only' },
      });
      expect(setAutoUpdate).toHaveBeenNthCalledWith(1, caller, true);
      // The update receipt carries recovery guidance after the global prompt
      // removal, preserving the host's status/reason and actual error code.
      check.mockImplementationOnce(async () => ({ status: 'idle', currentVersion: '0.1.90', targetVersion: '0.1.90', reason: 'channel_current' }));
      expect(await call('check_app_update')).toMatchObject({
        status: 'idle', reason: 'channel_current', guidance: expect.any(String),
      });
      install.mockResolvedValueOnce({ status: 'unsupported', reason: 'installation_unsupported' });
      expect(await call('install_app_update')).toMatchObject({
        status: 'unsupported', reason: 'installation_unsupported', guidance: expect.any(String),
      });
      install.mockResolvedValueOnce({ ok: false, errorCode: 'UPDATE_UNAVAILABLE', message: 'no installer' });
      expect(await call('install_app_update')).toMatchObject({
        ok: false, errorCode: 'UPDATE_UNAVAILABLE', data: { hint: 'no installer', guidance: expect.any(String) },
      });
      current = false;
      expect(await call('install_app_update')).toMatchObject({ ok: false, errorCode: 'STALE_SESSION' });
      expect(install).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('hides app updates from a remote Pi task while retaining its other helper categories', async () => {
    let remoteHostId: string | undefined;
    const check = vi.fn(async () => ({ status: 'ready', currentVersion: '0.1.86', targetVersion: '0.1.90' }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => 'default',
      appUpdate: { isCurrentSession: () => true, check },
    }, {
      agentKind: 'pi', workingDir: '/repo', sessionId: 'pi-task',
      getSessionContext: () => ({
        agentKind: 'pi', workingDir: '/repo', sessionId: 'pi-task',
        sessionInstanceId: 'instance-1', remoteHostId,
      }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'remote-pi-update-test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const list = async () => parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      const local = (await list()).categories as Array<{ name: string }>;
      expect(local.map((category) => category.name)).toContain('app_update');
      remoteHostId = 'ssh-host';
      const remote = (await list()).categories as Array<{ name: string }>;
      expect(remote.map((category) => category.name)).not.toContain('app_update');
      expect(remote.map((category) => category.name)).toContain('cindy');
      expect(parsePayload(await client.callTool({
        name: 'list_tools', arguments: { category: 'app_update' },
      }))).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(parsePayload(await client.callTool({
        name: 'call_tool', arguments: { name: 'check_app_update', args: {} },
      }))).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(check).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('lets a remote agent start only the scoped Grok device login and returns no credential', async () => {
    let current = true;
    const start = vi.fn(async () => ({
      status: 'pending' as const,
      verificationUrl: 'https://auth.x.ai/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 120_000,
    }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => 'default',
      grokLogin: { start, status: async () => ({ status: 'idle' }), cancel: async () => ({ status: 'idle' }) },
    }, {
      agentKind: 'codex', workingDir: '', remoteHostId: 'remote-host',
      getSessionContext: () => current ? {
        agentKind: 'codex', workingDir: '/remote', remoteHostId: 'remote-host',
        sessionId: 'remote-session', sessionInstanceId: 'instance-1',
      } : undefined,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'grok-remote-auth-test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const overview = parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      // The dedicated sign-in entry is discoverable with its status and cancel tools.
      expect(overview.categories).toEqual([
        { name: 'cindy', tool_count: 2, description: expect.stringContaining('self-management') },
        { name: 'auth', tool_count: 3, description: expect.any(String) },
      ]);
      expect((await client.listTools()).tools.some((tool) => tool.name === 'ask_owner')).toBe(false);
      for (const request of [
        { name: 'call_tool', arguments: { name: 'start_grok_device_login', args: {} } },
      ]) {
        const result = parsePayload(await client.callTool(request));
        expect(result).toMatchObject({ status: 'pending', userCode: 'ABCD-1234' });
        expect(JSON.stringify(result)).not.toContain('access_token');
      }
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'remote-session', sessionInstanceId: 'instance-1', remoteHostId: 'remote-host',
      }));
      current = false;
      const stale = parsePayload(await client.callTool({
        name: 'call_tool', arguments: { name: 'start_grok_device_login', args: {} },
      }));
      expect(stale).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("creates a teammate through the scoped helper entry", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      bot: { id: "bot-new", name: "程序员", description: "负责开发" },
    }));
    const server = createXdtHelperMcpServer(
      { resolveSurface: async () => "bot", botProfiles: { create } },
      { agentKind: "pi", workingDir: "/repo", sessionId: "bot-parent-session" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-helper-create-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["call_tool", "list_tools"]);
      const result = await client.callTool({ name: "call_tool", arguments: { name: "create_teammate", args: {
          name: "程序员",
          description: "负责开发",
          identity_source: "你是一个可靠的程序员伙伴。",
          welcome_message: "你好，我是程序员，以后开发工作可以直接找我。",
        } } });
      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({
        ok: true,
        action: "created",
        bot: { id: "bot-new", name: "程序员" },
      });
      expect(create).toHaveBeenCalledWith({
        callerSessionId: "bot-parent-session",
        name: "程序员",
        description: "负责开发",
        identitySource: "你是一个可靠的程序员伙伴。",
        welcomeMessage: "",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("dispatches a discovered send_to_session call without dropping nested arguments", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Issue follow-up",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      { sendToSession },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-transport-test",
      version: "0.0.0",
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const topLevelTools = await client.listTools();
      expect(topLevelTools.tools.map((tool) => tool.name).sort()).toEqual([
        "call_tool",
        "list_tools",
      ]);

      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "handoff" },
        }),
      );
      expect(discovered).toMatchObject({
        ok: true,
        category: "handoff",
      });
      const discoveredTools = discovered.tools as Array<{ name: string }>;
      expect(discoveredTools.map((tool) => tool.name)).toContain(
        "send_to_session",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "send_to_session",
          args: {
            target_session_id: TARGET_SESSION_ID,
            message: "Continue the existing task",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({
        ok: true,
        target_session_id: TARGET_SESSION_ID,
        wake_kind: "resumed",
      });
      expect(sendToSession).toHaveBeenCalledOnce();
      expect(sendToSession).toHaveBeenCalledWith({
        targetSessionId: TARGET_SESSION_ID,
        message: "Continue the existing task",
        dispatcherSessionId: "dispatcher-session",
        title: undefined,
        useWorktree: undefined,
        workingDir: undefined,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  // Unit/runtime surface: ordinary tasks need the model catalog even when Orca is disabled.
  it.each(['codex', 'pi', 'claude-code'] as const)('exposes the shared model catalog to ordinary %s tasks without worker tools', async agentKind => {
    const listAvailableModels = vi.fn(async () => ({ ok: true as const, codex: [{ id: 'gpt-model', label: 'Test' }] }));
    const server = createXdtHelperMcpServer({ listAvailableModels, resolveSurface: async () => 'default' },
      { agentKind, workingDir: '/repo', sessionId: 'ordinary' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ordinary-model-catalog', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const catalog = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'control' } }));
      expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list_available_models' })]));
      expect(catalog.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'create_worker' })]));
      expect(parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'list_available_models',
        args: { device: 'destination', provider_device_id: 'local' } } }))).toMatchObject({ ok: true, device: 'destination' });
      expect(listAvailableModels).toHaveBeenCalledWith({ agent: undefined, callerSessionId: 'ordinary', executionDeviceId: 'destination', agentDeviceId: null });
    } finally { await client.close(); await server.close(); }
  });

  // V2 retired send_to_agent / check_agent_message; teammates are reached through
  // send_to_session with the main-chat address list_agents returns.
  it.each(["bot", "default"] as const)("discovers teammates from %s without the retired message tools", async surface => {
    const listAgents = vi.fn(async () => ({ ok: true as const,
      agents: [{ id: 'studio::bot-b', name: 'Mimi', deviceName: 'Studio', session_id: 'studio::b-main' }], unavailableDevices: [] }));
    const server = createXdtHelperMcpServer(
      { resolveSurface: async () => surface, botMessaging: { listAgents } },
      { agentKind: "claude-code", workingDir: "/repo", sessionId: "bot-a-main" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-list-agents-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const roster = parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'list_agents', args: {} } }));
      expect(roster).toMatchObject({ ok: true, agents: [{ id: 'studio::bot-b', session_id: 'studio::b-main' }] });
      expect(listAgents).toHaveBeenCalledWith({ callerSessionId: 'bot-a-main' });
      const discovered = parsePayload(await client.callTool({ name: "list_tools", arguments: { category: "bots" } }));
      const names = (discovered.tools as Array<{ name: string }>).map(tool => tool.name);
      expect(names).toContain('list_agents');
      expect(names).not.toContain('send_to_agent');
      expect(names).not.toContain('check_agent_message');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers and calls the arbitrary session queue tool through the entry tools", async () => {
    const listSessionQueue = vi.fn(async () => ({
      ok: true as const,
      messages: [],
    }));
    const server = createXdtHelperMcpServer(
      {
        sessionQueue: {
          listSessionQueue,
          listSessionQueuedCounts: vi.fn(async () => ({ ok: true as const, counts: {} })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-queue-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "history" },
        }),
      );
      expect((discovered.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain(
        "list_session_queue",
      );

      const result = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "list_session_queue",
          args: { session_id: "session-1" },
        },
      });

      expect(parsePayload(result)).toMatchObject({
        ok: true,
        session_id: "session-1",
        queued_count: 0,
        queue: [],
      });
      expect(listSessionQueue).toHaveBeenCalledWith("session-1");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("discovers the complete session control surface through the control category", async () => {
    const server = createXdtHelperMcpServer(
      {
        sessionControl: {
          updateQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          cancelQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
          })),
          steerQueuedMessage: vi.fn(async ({ queuedMessageId }) => ({
            ok: true as const,
            queuedMessageId,
            delivery: "steered" as const,
          })),
          moveQueuedMessage: vi.fn(async ({ queuedMessageId, position }) => ({
            ok: true as const,
            queuedMessageId,
            position,
          })),
          steerSession: vi.fn(async () => ({
            ok: true as const,
            queuedMessageId: "steer-1",
          })),
          stopSessionTurn: vi.fn(async () => ({
            ok: true as const,
            status: "requested" as const,
            turnGeneration: 4,
          })),
          getSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            runtime: {
              sessionId: "target",
              phase: "idle" as const,
              recordStatus: "active" as const,
              attention: false,
              workflow: null,
              source: "persisted" as const,
              turnGeneration: null,
              startedAtMs: null,
              lastActivityAtMs: null,
              currentActionSummary: null,
              gracefulStopState: "none" as const,
            },
          })),
          setSessionRuntime: vi.fn(async () => ({
            ok: true as const,
            status: "applied" as const,
            generation: 1,
            effectiveProfile: {
              agentKind: "codex" as const,
              model: "gpt-5.6-sol",
              providerId: "openai",
              effort: "high" as const,
              fastMode: false,
            },
            pendingMutation: null,
          })),
        },
      },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "dispatcher-session",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "cindy-helper-control-test",
      version: "0.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const discovered = parsePayload(
        await client.callTool({
          name: "list_tools",
          arguments: { category: "control" },
        }),
      );
      const names = (discovered.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "update_session_queued_message",
        "cancel_session_queued_message",
        "steer_session_queued_message",
        "move_session_queued_message",
        "steer_session",
        "stop_session_turn",
        "get_session_runtime",
        "set_session_runtime",
      ]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('binds send_to_user to the current lane without accepting an arbitrary recipient', async () => {
    const sendToUser = vi.fn(async () => ({ ok: true as const, messageId: 'saved', targetSessionId: 'owner-private', delivered: true }));
    const server = createXdtHelperMcpServer({ resolveSurface: async () => 'bot', botMessaging: { sendToUser } },
      { agentKind: 'codex', workingDir: '/fixture', sessionId: 'group-lane' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'group-private-message', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const catalog = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'bots' } }));
      expect(JSON.stringify(catalog)).toContain('send_to_user');
      const result = parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'send_to_user',
        args: { message: 'Owner reply', idempotency_key: 'request-123', target_id: 'another-account' } } }));
      expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
      expect(sendToUser).not.toHaveBeenCalled();
      const valid = parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'send_to_user', args: { message: 'Owner reply', idempotency_key: 'request-123' } } }));
      expect(valid).toMatchObject({ ok: true, delivered: true, read: null, session_id: 'owner-private' });
      expect(sendToUser).toHaveBeenCalledWith({ callerSessionId: 'group-lane', message: 'Owner reply', idempotencyKey: 'request-123' });
    } finally { await client.close(); await server.close(); }
  });

  it.each(["default", "restricted", "error", "unbound"] as const)("limits companion self-management on %s surface", async (surface) => {
    const callback = vi.fn(async () => ({ ok: false as const, errorCode: "UNEXPECTED", message: "must not run" }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => {
        if (surface === "error") throw new Error("classification unavailable");
        return surface === "unbound" ? "bot" : surface;
      },
      botMessaging: { listAgents: callback, sendToUser: callback },
      botProfiles: { create: callback },
    }, { agentKind: "codex", workingDir: "/repo", sessionId: surface === "unbound" ? undefined : "normal-session" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "helper-surface-denial", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["call_tool", "list_tools"]);
      const discovery = parsePayload(await client.callTool({ name: "list_tools", arguments: { category: "bots" } }));
      if (surface === 'default') expect(discovery).toMatchObject({ ok: true, tools: [{ name: 'list_agents' }] });
      else expect(discovery).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      for (const name of [...(surface === 'default' ? [] : ['list_agents']), "send_to_user", "create_teammate"]) {
        const result = parsePayload(await client.callTool({ name: "call_tool", arguments: { name, args: {} } }));
        expect(result).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      }
      const direct = await client.callTool({ name: "list_agents", arguments: {} });
      expect(parsePayload(direct)).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("grants Bots only the named project tools, not the rest of control or history", async () => {
    let surface: "bot" | "default" = "bot";
    const createProject = vi.fn(async () => ({
      ok: true as const,
      workingDir: "/repo",
    }));
    const moveSession = vi.fn(async () => ({
      ok: true as const,
      sessionId: "task",
      workingDir: "/repo",
      workspaceKind: "project",
    }));
    const stopSessionTurn = vi.fn(async () => ({ ok: true as const, status: "requested" as const }));
    const listSessionQueue = vi.fn(async () => ({ ok: true as const, messages: [] }));
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const listAgents = vi.fn(async () => ({ ok: true as const, agents: [], unavailableDevices: [] }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => surface,
        sendToSession,
        createProject,
        moveSession,
        sessionControl: {
          updateQueuedMessage: vi.fn(),
          cancelQueuedMessage: vi.fn(),
          steerQueuedMessage: vi.fn(),
          moveQueuedMessage: vi.fn(),
          steerSession: vi.fn(),
          stopSessionTurn,
          getSessionRuntime: vi.fn(),
          setSessionRuntime: vi.fn(),
        },
        sessionQueue: {
          listSessionQueue,
          listSessionQueuedCounts: vi.fn(),
        },
        botMessaging: { listAgents },
      },
      {
        agentKind: "pi",
        workingDir: "/repo",
        sessionId: "bot-a-main",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-bot-helper-surface-test", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cindy' }),
        expect.objectContaining({ name: 'control' }),
        expect.objectContaining({ name: 'history' }),
        expect.objectContaining({ name: 'handoff' }),
        expect.objectContaining({ name: 'bots' }),
      ]));
      // 概览阶段就写明每类的用途与作用范围;可跨电脑的类目必须在这一步可见。
      const described = Object.fromEntries(
        (overview.categories as Array<{ name: string; description: string }>).map((c) => [c.name, c.description]),
      );
      for (const description of Object.values(described)) expect(description).toMatch(/\S/);
      for (const name of ['history', 'handoff', 'bots']) expect(described[name]).toContain('可跨电脑');
      expect(described.handoff).toContain('agent_device_id');
      expect(described.handoff).not.toContain('新建只在本机');
      expect(described.control).toMatch(/本机。$/);
      const controlTools = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'control' } }));
      const controlNames = controlTools.tools as Array<{ name: string; description: string }>;
      expect(controlNames.map((tool) => tool.name)).toEqual(expect.arrayContaining(['create_project', 'move_session', 'stop_session_turn']));
      expect(controlNames.find((tool) => tool.name === 'move_session')?.description).toContain('list_sessions');
      const handedOff = parsePayload(await client.callTool({ name: 'call_tool', arguments: {
        name: 'send_to_session', args: { target_session_id: TARGET_SESSION_ID, message: 'Do work' },
      } }));
      expect(handedOff).toMatchObject({ ok: true });
      expect(sendToSession).toHaveBeenCalled();

      const botTools = parsePayload(
        await client.callTool({ name: "list_tools", arguments: { category: "bots" } }),
      );
      expect((botTools.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["list_agents"]);
      surface = "default";
      const afterReclassification = parsePayload(await client.callTool({
        name: "call_tool", arguments: { name: "list_agents", args: {} },
      }));
      expect(afterReclassification).toMatchObject({ ok: true });
      expect(listAgents).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("gives a local Bot main task the ordinary surface and judges every call with the host", async () => {
    const stopSessionTurn = vi.fn(async () => ({ ok: true as const, status: "requested" as const }));
    const listAgents = vi.fn(async () => ({ ok: true as const, agents: [], unavailableDevices: [] }));
    const authorizeCall = vi.fn(async ({ tool }: { tool: string }) => (tool === "stop_session_turn"
      ? { ok: false as const, errorCode: "TASK_OUT_OF_SCOPE", message: "not yours" }
      : { ok: true as const }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => "bot-main",
        authorizeCall,
        sessionControl: {
          updateQueuedMessage: vi.fn(),
          cancelQueuedMessage: vi.fn(),
          steerQueuedMessage: vi.fn(),
          moveQueuedMessage: vi.fn(),
          steerSession: vi.fn(),
          stopSessionTurn,
          getSessionRuntime: vi.fn(),
          setSessionRuntime: vi.fn(),
        },
        botMessaging: { listAgents },
      },
      { agentKind: "pi", workingDir: "/bot", sessionId: "bot-a-main" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bot-main-surface", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
      const categories = (overview.categories as Array<{ name: string }>).map((category) => category.name);
      expect(categories).toEqual(expect.arrayContaining(["control", "bots"]));

      expect(parsePayload(await client.callTool({
        name: "call_tool",
        arguments: { name: "stop_session_turn", args: { session_id: TARGET_SESSION_ID } },
      }))).toMatchObject({ ok: false, errorCode: "TASK_OUT_OF_SCOPE" });
      expect(stopSessionTurn).not.toHaveBeenCalled();
      expect(authorizeCall).toHaveBeenCalledWith({
        sessionId: "bot-a-main",
        server: "cindy_helper",
        tool: "stop_session_turn",
        args: { session_id: TARGET_SESSION_ID },
      });

      expect(parsePayload(await client.callTool({
        name: "call_tool",
        arguments: { name: "list_agents", args: {} },
      }))).toMatchObject({ ok: true });
      expect(listAgents).toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when the host authorizer throws", async () => {
    const listAgents = vi.fn();
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => "bot-main",
        authorizeCall: async () => { throw new Error("db gone"); },
        botMessaging: { listAgents },
      },
      { agentKind: "pi", workingDir: "/bot", sessionId: "bot-a-main" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bot-main-authorizer-throws", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(parsePayload(await client.callTool({
        name: "call_tool",
        arguments: { name: "list_agents", args: {} },
      }))).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(listAgents).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("gives remote and secondary companion tasks the ordinary surface for their transport", async () => {
    const authorizeCall = vi.fn(async () => ({ ok: true as const }));
    const createProject = vi.fn(async () => ({ ok: true as const, workingDir: "/repo" }));
    for (const context of [
      { agentKind: "codex" as const, workingDir: "/repo", sessionId: "bot-remote", remoteHostId: "ssh-host" },
      { agentKind: "pi" as const, workingDir: "/repo", sessionId: "bot-lane" },
    ]) {
      const server = createXdtHelperMcpServer(
        { resolveSurface: async () => (context.remoteHostId ? "bot-main" : "bot"), authorizeCall, createProject },
        context,
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "bot-narrow-surface", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
        const categories = (overview.categories as Array<{ name: string }>).map((category) => category.name);
        if (context.remoteHostId) {
          expect(categories).not.toContain("history");
        } else {
          expect(categories).toContain("cindy");
          expect(categories).toContain("control");
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(authorizeCall).not.toHaveBeenCalled();
  });

  it("does not offer local project tools to a remote Bot", async () => {
    const createProject = vi.fn(async () => ({ ok: true as const, workingDir: "/repo" }));
    const server = createXdtHelperMcpServer(
      { resolveSurface: async () => "bot", createProject },
      {
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "bot-remote",
        remoteHostId: "ssh-host",
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-bot-projects", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(await client.callTool({ name: "list_tools", arguments: {} }));
      expect(overview.categories).toEqual([{ name: "cindy", tool_count: 2, description: expect.any(String) }]);
      expect(
        parsePayload(await client.callTool({
          name: "call_tool",
          arguments: { name: "create_project", args: { working_dir: "/repo" } },
        })),
      ).toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      expect(createProject).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when the host cannot classify the Session surface", async () => {
    const sendToSession = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: TARGET_SESSION_ID,
      agentKind: "codex" as const,
      wakeKind: "resumed" as const,
      targetTitle: "Other task",
      targetLastUserSendAt: null,
    }));
    const server = createXdtHelperMcpServer(
      {
        resolveSurface: async () => { throw new Error("db unavailable"); },
        sendToSession,
      },
      { agentKind: "pi", workingDir: "/repo", sessionId: "unknown-session" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cindy-helper-restricted-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const overview = parsePayload(
        await client.callTool({ name: "list_tools", arguments: {} }),
      );
      expect(overview.categories).toEqual([]);
      const forbiddenCall = parsePayload(
        await client.callTool({
          name: "call_tool",
          arguments: {
            name: "send_to_session",
            args: { target_session_id: TARGET_SESSION_ID, message: "Do work" },
          },
        }),
      );
      expect(forbiddenCall).toMatchObject({
        ok: false,
        errorCode: "CAPABILITY_NOT_AVAILABLE",
      });
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("direct Bot MCP tools", () => {
  it.each(["claude-code", "codex"] as const)("omits ghost plugin guidance from find_teammate_capabilities on remote %s", async (agentKind) => {
    let remoteHostId: string | undefined;
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => "bot",
      botCapabilities: {
        list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
        select: vi.fn(async () => ({ ok: true as const, effective: "next-turn" as const, joined: true })),
      },
    }, {
      agentKind,
      workingDir: "",
      getSessionContext: () => ({
        agentKind,
        workingDir: "/bot",
        sessionId: "bot-parent",
        ...(remoteHostId ? { remoteHostId } : {}),
      }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-bot-capability-desc", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const localTool = (await client.listTools()).tools.find((tool) => tool.name === "find_teammate_capabilities");
      expect(localTool?.description).toContain("ghost_list");
      const localDiscovered = parsePayload(await client.callTool({
        name: "list_tools",
        arguments: { category: "bots" },
      })).tools as Array<{ name: string; description: string }>;
      expect(localDiscovered.find((tool) => tool.name === "find_teammate_capabilities")?.description).toContain("ghost_list");

      remoteHostId = "ssh-host";
      const remoteTool = (await client.listTools()).tools.find((tool) => tool.name === "find_teammate_capabilities");
      expect(remoteTool?.description).toContain("Skill");
      expect(remoteTool?.description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
      const remoteDiscovered = parsePayload(await client.callTool({
        name: "list_tools",
        arguments: { category: "bots" },
      })).tools as Array<{ name: string; description: string }>;
      expect(remoteDiscovered.find((tool) => tool.name === "find_teammate_capabilities")?.description).not.toMatch(
        /ghost_list|ghost_info|ghost_call/,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["claude-code", "codex"] as const)("judges direct Bot tools of a local Bot main task on %s", async (agentKind) => {
    const listAgents = vi.fn();
    const authorizeCall = vi.fn(async () => ({ ok: false as const, errorCode: "OWNER_TURN_REQUIRED", message: "owner only" }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => "bot-main",
      authorizeCall,
      botMessaging: { listAgents },
    }, {
      agentKind,
      workingDir: "",
      getSessionContext: () => ({ agentKind, workingDir: "/bot", sessionId: "bot-main" }),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "direct-bot-gate", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      expect(parsePayload(await client.callTool({
        name: "list_agents",
        arguments: {},
      }))).toMatchObject({ ok: false, errorCode: "OWNER_TURN_REQUIRED" });
      expect(authorizeCall).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "bot-main", tool: "list_agents" }));
      expect(listAgents).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps ghost plugin guidance in Pi helper discovery on remote sessions", async () => {
    const server = createXdtHelperMcpServer({
      resolveSurface: async () => "bot",
      botCapabilities: {
        list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
        select: vi.fn(async () => ({ ok: true as const, effective: "next-turn" as const, joined: true })),
      },
    }, {
      agentKind: "pi",
      workingDir: "/bot",
      sessionId: "bot-parent",
      remoteHostId: "ssh-host",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-pi-capability-desc", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["call_tool", "list_tools"]);
      const discovered = parsePayload(await client.callTool({
        name: "list_tools",
        arguments: { category: "bots" },
      })).tools as Array<{ name: string; description: string }>;
      const find = discovered.find((tool) => tool.name === "find_teammate_capabilities");
      expect(find?.description).toContain("Skill");
      expect(find?.description).toContain("ghost_list");
      expect(find?.description).toContain("ghost_info");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["claude-code", "codex"] as const)("exposes and executes teammate tools on %s without discovery", async (agentKind) => {
    let sessionId: string | undefined = "bot-parent";
    const listAgents = vi.fn(async () => ({ ok: true as const, agents: [], unavailableDevices: [] }));
    const server = createXdtHelperMcpServer({
      resolveSurface: async ({ sessionId }) => sessionId === "bot-parent" ? "bot" : "default",
      botMessaging: { listAgents },
    }, {
      agentKind, workingDir: "",
      getSessionContext: () => sessionId ? { agentKind, workingDir: "/bot", sessionId } : undefined,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "direct-bot-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const first = await client.listTools();
      const tool = first.tools.find(t => t.name === "list_agents");
      const discovered = parsePayload(await client.callTool({ name: "list_tools", arguments: { category: "bots" } })).tools as Array<{ name: string; description: string }>;
      expect(tool?.description).toBe(discovered.find(item => item.name === "list_agents")?.description);
      expect(await client.listTools()).toEqual(first);
      expect(parsePayload(await client.callTool({ name: "list_agents", arguments: {} }))).toMatchObject({ ok: true });
      // A shared Codex bridge must re-check the caller for both listing and execution.
      for (const next of ["ordinary-task", undefined]) {
        sessionId = next;
        expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["call_tool", "list_tools"]);
        expect(parsePayload(await client.callTool({ name: "list_agents", arguments: {} })))
          .toMatchObject({ ok: false, errorCode: "CAPABILITY_NOT_AVAILABLE" });
      }
      expect(listAgents).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Unit: discover and invoke the same local Settings form for all three harnesses.
it.each(['claude-code', 'codex', 'pi'] as const)('opens MCP Settings through the %s helper and returns only metadata', async agentKind => {
  const request = vi.fn(async () => ({ status: 'saved' as const, serverId: 'custom_example' }));
  const context = { agentKind, workingDir: '/repo', sessionId: 'task', sessionInstanceId: 'instance' };
  const server = createXdtHelperMcpServer({ mcpSetup: request }, { ...context, getSessionContext: () => context });
  const client = new Client({ name: 'mcp-form-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const catalog = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'auth' } }));
    expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'request_mcp_setup' })]));
    const result = parsePayload(await client.callTool({ name: 'call_tool', arguments: {
      name: 'request_mcp_setup', args: { name: 'Example', url: 'https://example.test/mcp', transport: 'sse' },
    } }));
    expect(result).toEqual({ ok: true, status: 'saved', serverId: 'custom_example' });
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(context), {
      name: 'Example', url: 'https://example.test/mcp', transport: 'sse',
    });
    request.mockClear();
    await client.callTool({ name: 'call_tool', arguments: { name: 'request_mcp_setup', args: { url: 'https://example.test/mcp?token=test-invalid-token' } } });
    expect(request).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});

// Unit, real MCP wire: ordinary tasks could not discover app defaults/settings.
// Cover all harnesses, schema failure without writes, and live visitor denial.
it('discovers native app settings in all three harnesses and rejects invalid or guest writes', async () => {
  for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
    let restricted = false;
    const settings = vi.fn(async () => ({ section: 'appearance', state: { uiSize: 16 } }));
    const models = vi.fn(async () => ({ scope: 'local', providers: [] }));
    const defaults = vi.fn(async () => ({ ok: true as const, current: null, available: [] }));
    const server = createXdtHelperMcpServer({ appSettings: { call: settings }, modelSettings: { call: models },
      appModels: { models: defaults }, resolveSurface: async () => restricted ? 'restricted' : 'default' },
      { agentKind, workingDir: '/fixture', sessionId: 'settings-owner' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'settings-test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const overview = parsePayload(await client.callTool({ name: 'list_tools', arguments: {} }));
      expect(overview.categories).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'settings' })]));
      const catalog = parsePayload(await client.callTool({ name: 'list_tools', arguments: { category: 'settings' } }));
      expect(catalog.tools).toEqual(expect.arrayContaining(['list_app_settings', 'get_app_default_model', 'list_model_providers', 'set_model_configuration', 'configure_model_connection']
        .map(name => expect.objectContaining({ name }))));
      const call = (name: string, args = {}) => client.callTool({ name: 'call_tool', arguments: { name, args } });
      expect(parsePayload(await call('get_app_default_model'))).toMatchObject({ ok: true, available: [] });
      expect(defaults).toHaveBeenCalledExactlyOnceWith({ callerSessionId: 'settings-owner' });
      expect(parsePayload(await call('get_app_settings', { section: 'appearance' }))).toMatchObject({ ok: true, state: { uiSize: 16 } });
      const invalid = await call('set_model_configuration', { target: { providerId: 'p', agent: 'pi', modelId: 'm' },
        change: { setting: 'contextLimit', value: -1 } });
      expect(invalid.isError).toBe(true);
      expect(models).not.toHaveBeenCalled();
      for (const change of [
        { action: 'setKey', providerId: 'example', agent: 'pi', apiKey: 'synthetic-secret' },
        { action: 'create', name: 'Example', runtimes: { pi: { baseUrl: 'https://example.test/?token=synthetic-secret', wireProtocol: 'openai-chat', models: [] } } },
        { action: 'create', name: 'Example', runtimes: { pi: { baseUrl: 'not-a-url', wireProtocol: 'openai-chat', models: [] } } },
      ]) expect((await call('configure_model_connection', { change })).isError).toBe(true);
      if (agentKind === 'codex') expect(parsePayload(await call('configure_model_connection', { change: {
        action: 'setKey', providerId: 'example', agent: 'codex', interruptCodex: true,
      } }))).toMatchObject({ ok: false, errorCode: 'CODEX_CALLER_WOULD_STOP' });
      expect(models).not.toHaveBeenCalled();
      await call('configure_model_connection', { change: { action: 'presets' } });
      expect(models).toHaveBeenCalledExactlyOnceWith({ callerSessionId: 'settings-owner', operation: 'connection', change: { action: 'presets' } }, expect.any(AbortSignal));
      restricted = true;
      expect(parsePayload(await call('configure_model_connection', { change: { action: 'presets' } })).ok).toBe(false);
      expect(models).toHaveBeenCalledTimes(1);
      expect(parsePayload(await call('update_app_settings', { section: 'appearance', patch: { uiSize: 17 } })).ok).toBe(false);
      expect(settings).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  }
});

// Unit, parity #7: plugins use the existing settings callbacks with no current task.
// The task-only MCP case above would miss CAPABILITY_NOT_AVAILABLE for this caller.
// Minimal input: list/get/update via Host handlers, with no sessionId in the context.
it('reads and updates app settings through the shared handler for a plugin caller', async () => {
  let state = { uiSize: 16, animation: true };
  const settings = vi.fn(async (input: { callerSessionId?: string; operation: string; patch?: Record<string, unknown> }) => {
    if (input.operation === 'update') state = { ...state, ...input.patch };
    return input.operation === 'list' ? { sections: [{ id: 'appearance' }] } : { state: { ...state } };
  });
  const server = createXdtHelperMcpServer({ appSettings: { call: settings } }, {
    agentKind: 'codex', workingDir: '', hostCaller: { kind: 'plugin', pluginId: 'dashboard', dataOwnerId: 'owner', ownerGeneration: 1 },
  });
  try {
    expect(server.hostTools.describe('update_app_settings')).toMatchObject({ category: 'settings' });
    expect(parsePayload(await server.hostTools.call('list_app_settings', {}))).toMatchObject({ ok: true, sections: [{ id: 'appearance' }] });
    expect(parsePayload(await server.hostTools.call('get_app_settings', { section: 'appearance' }))).toMatchObject({ ok: true, state });
    expect(parsePayload(await server.hostTools.call('update_app_settings', { section: 'appearance', patch: { uiSize: 18 } })))
      .toMatchObject({ ok: true, state: { uiSize: 18, animation: true } });
    expect(settings).toHaveBeenLastCalledWith({ callerSessionId: undefined, operation: 'update', section: 'appearance', patch: { uiSize: 18 } });
    expect(settings.mock.calls.every(([input]) => input.callerSessionId === undefined)).toBe(true);
    expect(parsePayload(await server.hostTools.call('update_app_settings', { patch: { uiSize: 20 } })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(settings).toHaveBeenCalledTimes(3);
  } finally { await server.close(); }
});

// #9276, unit real MCP: cancellation previously stopped the caller but left Main
// waiting for a key. Existing discovery tests never cancelled an in-flight call.
it('forwards connection tool cancellation to the host in all three harnesses', async () => {
  for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
    let entered!: () => void;
    let cancelled!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const server = createXdtHelperMcpServer({ modelSettings: { call: async (_input, signal) => {
      expect(signal).toBeDefined();
      signal!.addEventListener('abort', cancelled, { once: true });
      entered();
      await aborted;
      return { saved: false };
    } } }, { agentKind, workingDir: '/fixture', sessionId: 'owner' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'model-cancel-test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const controller = new AbortController();
      const pending = client.callTool({ name: 'call_tool', arguments: { name: 'configure_model_connection',
        args: { change: { action: 'setKey', providerId: 'example', agent: 'pi' } } } }, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toBeDefined();
      await waiting;
      controller.abort();
      await rejected;
      await aborted;
    } finally { await client.close(); await server.close(); }
  }
});

// Screenshot regression: an authored theme could be dropped into the UI, but
// its task could not discover an importer and launched another Cindy instead.
// Unit, real MCP wire: existing settings tests never import theme files. One
// .cindy path must be discoverable/callable; wrong types, SSH and guests cannot write.
it('discovers theme imports in each harness and keeps them on the authorized local host', async () => {
  for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
    let restricted = false;
    let remoteHostId: string | undefined;
    const install = vi.fn(async () => ({ status: 'installed', refreshed: true, names: ['Mist'] }));
    const server = createXdtHelperMcpServer({ themePackages: { import: install },
      resolveSurface: async () => restricted ? 'restricted' : 'default' }, {
      agentKind, workingDir: '/fixture', sessionId: 'theme-owner',
      getSessionContext: () => ({ agentKind, workingDir: '/fixture', sessionId: 'theme-owner', remoteHostId }),
    });
    const client = new Client({ name: 'theme-import-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = (filePath: string) => client.callTool({ name: 'call_tool', arguments: { name: 'import_theme_package', args: { filePath } } });
    try {
      const search = parsePayload(await client.callTool({ name: 'list_tools', arguments: { query: '导入主题' } }));
      const item = (search.items as any[]).find(item => item.key === 'appearance.themes');
      expect(item).toMatchObject({ availability: 'available' });
      const detail = parsePayload(await client.callTool({ name: 'list_tools', arguments: { key: item.key } })).control as any;
      expect(detail.operations).toEqual([expect.objectContaining({ name: 'import_theme_package' })]);
      expect(install).not.toHaveBeenCalled();
      expect(parsePayload(await call('/fixture/mist.cindy'))).toMatchObject({ ok: true, status: 'installed', refreshed: true });
      expect(install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'theme-owner', workingDir: '/fixture', agentKind }), '/fixture/mist.cindy');
      expect(parsePayload(await call('/fixture/mist.json'))).toMatchObject({ ok: false });
      expect(install).toHaveBeenCalledTimes(1);
      remoteHostId = 'ssh-host';
      expect(parsePayload(await call('/fixture/mist.cindy'))).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(install).toHaveBeenCalledTimes(1);
      remoteHostId = undefined;
      restricted = true;
      expect(parsePayload(await call('/fixture/mist.cindy'))).toMatchObject({ ok: false });
      expect(install).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  }
});

// Regression: settings discovery was buried behind a second-level tool. Unit,
// real MCP transport: a fresh client follows returned calls, reads the exact
// schema without executing it, then saves through the original authorized tool.
it.each(['default', 'bot-main'] as const)('discovers controls from the root and executes their returned binding in %s', async surface => {
  for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
    let restricted = false;
    const settings = vi.fn(async (input: { operation: string; patch?: Record<string, unknown> }) => ({ state: input.patch ?? { uiSize: 16 } }));
    const server = createXdtHelperMcpServer({ appSettings: { call: settings },
      resolveSurface: async () => restricted ? 'restricted' : surface },
      { agentKind, workingDir: '/fixture', sessionId: 'owner' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'control-discovery-test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const follow = (binding: any) => client.callTool({ name: binding.tool, arguments: binding.args });
    try {
      const root = (await client.listTools()).tools.find(tool => tool.name === 'list_tools')!;
      expect(root.inputSchema.properties).toHaveProperty('query');
      const search = parsePayload(await client.callTool({ name: root.name, arguments: { query: '修改壁纸' } }));
      const item = (search.items as any[]).find(item => item.key === 'appearance.wallpaper');
      expect(item.availability).toBe('available');
      const detail = parsePayload(await follow(item.next)).control as any;
      const write = detail.operations.find((op: any) => op.name === 'update_app_settings');
      expect(write.call.args.args).toEqual({ section: 'appearance' });
      const schema = (parsePayload(await follow(write.describe)).control as any).operations[0];
      expect(schema).toMatchObject({ schemaComplete: true, inputSchema: { required: ['section', 'patch'] } });
      // Preferences has per-field writes only; appearance still offers reset.
      // Follow the actual catalog contract, including explicit operation lookup.
      expect(detail.operations.map((op: any) => op.name)).toContain('reset_app_settings');
      const preferences = parsePayload(await client.callTool({ name: root.name, arguments: { key: 'application.preferences' } })).control as any;
      expect(preferences.operations.map((op: any) => op.name)).toEqual(['get_app_settings', 'update_app_settings']);
      expect(parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_capabilities', args: { scope: 'control', key: 'application.preferences', operation: 'reset_app_settings' } } })))
        .toMatchObject({ ok: false, errorCode: 'UNKNOWN_OPERATION' });
      expect(settings).not.toHaveBeenCalled();
      expect(parsePayload(await follow({ ...write.call, args: { ...write.call.args, args: { ...write.call.args.args, patch: { uiSize: 17 } } } })))
        .toMatchObject({ ok: true, state: { uiSize: 17 } });
      expect(settings).toHaveBeenCalledExactlyOnceWith({ callerSessionId: 'owner', operation: 'update', section: 'appearance', patch: { uiSize: 17 } });
      restricted = true;
      expect(parsePayload(await client.callTool({ name: 'list_tools', arguments: { query: '壁纸' } }))).toMatchObject({ ok: false });
      expect(parsePayload(await follow(write.describe))).toMatchObject({ ok: false });
      expect(parsePayload(await follow(write.call))).toMatchObject({ ok: false });
      expect(settings).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  }
});

// Unit: distinguish an unexposed control from an available one, and keep a
// cursor tied to its query. Neither a bad key nor a bad cursor starts a write.
it('keeps the control directory compact and reports gaps and invalid continuations', async () => {
  const rename = vi.fn(async (input: { sessionId: string; title: string }) => ({ ok: true as const, ...input }));
  const server = createXdtHelperMcpServer({ setCurrentSessionTitle: rename }, { agentKind: 'codex', workingDir: '/fixture', sessionId: 'owner' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'control-pagination-test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const read = async (args = {}) => parsePayload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_capabilities', args: { scope: 'control', ...args } } }));
  try {
    const root = await read();
    expect((root.domains as unknown[]).length).toBe(13);
    expect(JSON.stringify(root).length).toBeLessThan(2500);
    expect(await read({ key: 'mobile.preferences' })).toMatchObject({ control: { availability: 'not_exposed', operations: [] } });
    expect(await read({ key: 'teammates.profile' })).toMatchObject({ control: { availability: 'unavailable_in_context', operations: [] } });
    expect(await read({ key: 'native.set_current_session_title' })).toMatchObject({ control: { operations: [expect.objectContaining({ name: 'set_current_session_title' })] } });
    expect(rename).not.toHaveBeenCalled();
    expect(await read({ key: 'missing' })).toMatchObject({ ok: false, errorCode: 'UNKNOWN_CONTROL' });
    // 2026-11-08: a teammate told to use list_agents searched that exact name and found nothing.
    expect(await read({ toolQuery: 'list_agents' })).toMatchObject({ items: [expect.objectContaining({ key: 'teammates.management' })] });
    const page = await read({ toolQuery: '模型' });
    expect(page.complete).toBe(false);
    const next = await read({ toolQuery: '模型', cursor: page.nextCursor });
    expect((next.items as any[]).every(item => !(page.items as any[]).some(first => first.key === item.key))).toBe(true);
    expect(await read({ toolQuery: '壁纸', cursor: page.nextCursor })).toMatchObject({ ok: false, errorCode: 'INVALID_CURSOR' });
    expect(await read({ key: 'appearance.wallpaper', operation: 'schedule_run_now' })).toMatchObject({ ok: false, errorCode: 'UNKNOWN_OPERATION' });
  } finally { await client.close(); await server.close(); }
});

// Unit: Pi management is one device-local native operation. Discovery and
// checks never install; malformed versions and remote callers cannot mutate it.
it('routes Pi version checks and exact-version installs to the managed runtime', async () => {
  let remoteHostId: string | undefined;
  const call = vi.fn(async () => ({ currentVersion: '1.4.0' }));
  const server = createXdtHelperMcpServer({ piRuntime: { call } }, {
    agentKind: 'pi', workingDir: '/fixture', sessionId: 'owner',
    getSessionContext: () => ({ agentKind: 'pi', workingDir: '/fixture', sessionId: 'owner', remoteHostId }),
  });
  const client = new Client({ name: 'pi-control-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const invoke = async (name: string, args = {}) => parsePayload(await client.callTool({ name: 'call_tool', arguments: { name, args } }));
  try {
    expect(parsePayload(await client.callTool({ name: 'list_tools', arguments: { query: '更新 pi' } })))
      .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ key: 'runtimes.pi', availability: 'available' })]) });
    expect(call).not.toHaveBeenCalled();
    expect(await invoke('get_pi_runtime', { check: true })).toMatchObject({ ok: true, currentVersion: '1.4.0' });
    expect(call).toHaveBeenLastCalledWith('owner', { check: true });
    expect(await invoke('update_pi_runtime', { source: 'upstream', version: 'latest' })).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(await invoke('update_pi_runtime', { source: 'upstream', version: '1.4.0' })).toMatchObject({ ok: true });
    expect(call).toHaveBeenLastCalledWith('owner', { install: { source: 'upstream', version: '1.4.0' } });
    remoteHostId = 'ssh-target';
    expect(parsePayload(await client.callTool({ name: 'list_tools', arguments: { key: 'runtimes.pi' } })))
      .toMatchObject({ control: { availability: 'requires_local_task', operations: [] } });
    expect(await invoke('update_pi_runtime', { source: 'upstream', version: '1.4.0' })).toMatchObject({ ok: false });
    expect(call).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});
