/**
 * Production entry: AcpSubscriptionSession; observable ACP messages/permission decisions.
 * Rule: personal OAuth only, no API fallback, cancel pending permissions, exact resume.
 * Gap: first ACP engine; existing Pi/Codex transports don't cover ACP semantics.
 * Minimal failure: oauth-personal rejected, then open/prompt must never be dispatched.
 * Tier: unit (in-memory protocol peer; no process, credentials or network).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AntigravityAgent, probeAntigravityRuntime, type AntigravityHost } from './antigravity-agent.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { TASK_SYSTEM_PROMPT } from '../base-agent.js';
import { AcpSubscriptionSession } from './subscription-session.js';
import { personalSubscriptionEnv } from './transport.js';
import type { AcpTransport, AcpRecord } from './client.js';
import type { AntigravityCommandExit } from '../../types/events.js';
function setup(authFails = false, holdPrompt = false, version?: string, protocolVersion = 1, imageCapability = false) {
  const sent: AcpRecord[] = []; const received = new Set<(line: string) => void>();
  const transport: AcpTransport = {
    onLine: fn => { received.add(fn); return () => { received.delete(fn); }; }, onClose: () => () => {}, close: async () => {},
    write(line) {
      const req = JSON.parse(line); sent.push(req);
      if (req.id === undefined) return;
      if (holdPrompt && req.method === 'session/prompt') return;
      let result: unknown = {};
      if (req.method === 'initialize') result = { protocolVersion, agentInfo: { name: 'Antigravity ACP Server', version }, agentCapabilities: { loadSession: true, promptCapabilities: { image: imageCapability, audio: false, embeddedContext: true }, _meta: { antigravity: { systemPrompt: { append: true } } } }, authMethods: [{ id: 'oauth-personal' }] };
      if (req.method === 'session/new') result = { sessionId: 'native-1', _meta: { antigravity: { tier: { id: 'test-pro', name: 'Google AI Pro' } } }, models: { currentModelId: 'gemini-test', availableModels: [{ modelId: 'gemini-test', name: 'Gemini' }] } };
      if (req.method === 'session/load') result = { models: { currentModelId: 'gemini-test', availableModels: [{ modelId: 'gemini-test', name: 'Gemini' }] } };
      if (req.method === 'authenticate') result = { _meta: { antigravity: { tier: { id: 'test-pro', name: 'Google AI Pro', upgradeUri: 'not-forwarded' } } } };
      queueMicrotask(() => respond(req.id, authFails && req.method === 'authenticate' ? undefined : result, authFails && req.method === 'authenticate'));
    },
  };
  function respond(id: number, result: unknown, error = false) {
    for (const fn of received) fn(JSON.stringify(error ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'secret-auth-url' } } : { jsonrpc: '2.0', id, result }));
  }
  const policy = vi.fn(async () => {});
  const permission = vi.fn(async (_input: AcpRecord, _signal: AbortSignal) => false);
  const updates = vi.fn();
  const session = new AcpSubscriptionSession({ transport, cwd: '/workspace', assertSubscriptionOnly: policy, requestPermission: permission, onUpdate: updates });
  return { session, transport, sent, policy, permission, updates, inbound: (msg: AcpRecord) => { for (const fn of received) fn(JSON.stringify({ jsonrpc: '2.0', ...msg })); } };
}
describe('Antigravity subscription ACP', () => {
  it.each(['1.5.9', '1.5.10', '1.5.13'])('probes compatible CLI %s before using any credentials', async (version) => {
    const h = setup(false, false, version);
    await h.session.close();
    await probeAntigravityRuntime(h.transport, '/workspace');
    expect(h.sent.map(request => request.method)).toEqual(['initialize']);
  });
  it('rejects an incompatible ACP protocol before authenticating', async () => {
    const h = setup(false, false, '2.0.0', 2);
    await h.session.close();
    await expect(probeAntigravityRuntime(h.transport, '/workspace')).rejects.toThrow();
    expect(h.sent.map(request => request.method)).toEqual(['initialize']);
  });
  it('authenticates only personal OAuth; failure blocks creation and hides auth error contents', async () => {
    const h = setup(true); await h.session.initialize();
    await expect(h.session.authenticate()).rejects.toThrow('Google 登录已失效');
    await expect(h.session.open()).rejects.toThrow();
    await expect(h.session.prompt('hello')).rejects.toThrow();
    expect(h.sent.map(x => x.method)).toEqual(['initialize', 'authenticate']);
    expect(h.sent[1].params).toEqual({ methodId: 'oauth-personal' }); await h.session.close();
  });
  it('discovers live models and resumes without silently creating a replacement session', async () => {
    const h = setup(); await h.session.initialize(); await h.session.authenticate();
    expect(await h.session.open({ resumeId: 'persisted-id' })).toBe('persisted-id');
    await h.session.prompt('hello');
    expect(h.sent.find(x => x.method === 'session/load')?.params).toEqual({ sessionId: 'persisted-id', cwd: '/workspace', mcpServers: [] });
    expect(h.sent.some(x => x.method === 'session/new')).toBe(false); expect(h.policy).toHaveBeenCalledTimes(3); await h.session.close();
  });
  it('rejects unknown models and checks the spending policy before every prompt', async () => {
    const h = setup(); await h.session.initialize(); await h.session.authenticate(); await h.session.open();
    expect(h.session.models).toEqual([{ id: 'gemini-test', name: 'Gemini' }]);
    await expect(h.session.setModel('invented')).rejects.toThrow();
    h.policy.mockRejectedValueOnce(new Error('CREDITS_ENABLED'));
    await expect(h.session.prompt('hello')).rejects.toThrow('CREDITS_ENABLED');
    expect(h.sent.some(x => x.method === 'session/prompt')).toBe(false); await h.session.close();
  });
  it('cancels pending permission requests and never grants allow-always', async () => {
    const h = setup(); await h.session.initialize(); await h.session.authenticate(); await h.session.open();
    h.permission.mockImplementationOnce(() => new Promise(() => {}));
    h.inbound({ id: 91, method: 'session/request_permission', params: { sessionId: 'native-1', toolCall: { title: 'Run command' }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }, { kind: 'allow_always', optionId: 'forever' }] } });
    h.session.cancel(); await vi.waitFor(() => expect(h.sent.find(x => x.id === 91)?.result).toEqual({ outcome: { outcome: 'cancelled' } }), { interval: 1 });
    expect(h.sent.find(x => x.method === 'session/cancel')?.params).toEqual({ sessionId: 'native-1' }); await h.session.close();
  });
  it.each([[true, 'yes'], [false, 'no']] as const)('returns the chosen one-time permission decision (%s)', async (decision, optionId) => {
    const h = setup(); await h.session.initialize(); await h.session.authenticate(); await h.session.open();
    h.permission.mockResolvedValueOnce(decision);
    h.inbound({ id: 92, method: 'session/request_permission', params: { sessionId: 'native-1', toolCall: { title: 'Run command' }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }, { kind: 'allow_always', optionId: 'forever' }] } });
    await vi.waitFor(() => expect(h.sent.find(x => x.id === 92)?.result).toEqual({ outcome: { outcome: 'selected', optionId } }), { interval: 1 });
    await h.session.close();
  });
  it('does not dispatch a prompt cancelled while its spending check is pending', async () => {
    const h = setup(); await h.session.initialize(); await h.session.authenticate(); await h.session.open();
    let release!: () => void;
    h.policy.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = h.session.prompt('hello'); h.session.cancel(); release();
    await expect(pending).rejects.toThrow('CANCELLED_BEFORE_DISPATCH');
    expect(h.sent.some(x => x.method === 'session/prompt')).toBe(false); await h.session.close();
  });
  it('does not inherit provider credentials, endpoints or ADC into CLI children', () => {
    const env = personalSubscriptionEnv({ PATH: '/bin', HOME: '/home/user', GEMINI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: '/secret', AGY_ADC_AUTH: 'true', GOOGLE_GEMINI_BASE_URL: 'https://other' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/user', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
  });
});

describe('AntigravityAgent native Cindy contract', () => {
  function makeAgent(
    h: ReturnType<typeof setup>,
    overrides?: Partial<Awaited<ReturnType<AntigravityHost['connect']>>>,
  ) {
    const allowed = vi.fn(async () => {});
    const connect = vi.fn<AntigravityHost['connect']>(async () => ({
      transport: h.transport, assertSubscriptionOnly: h.policy, ...overrides,
    }));
    const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
      getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
    } }, { connect, assertGenerationAllowed: allowed, modelsChanged: vi.fn() });
    return { agent, connect, allowed };
  }
  it('restores the cached account and directory once without invoking browser authentication', async () => {
    const h = setup(); await h.session.close(); const { agent, connect } = makeAgent(h);
    await expect(agent.getAuthState()).resolves.toMatchObject({ authenticated: true, subscriptionTier: { name: 'Google AI Pro' } });
    await agent.getAuthState();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(agent.capabilities.availableModels.map(m => m.id)).toEqual(['gemini-test']);
    expect(h.sent.some(x => x.method === 'authenticate' || x.method === 'session/prompt')).toBe(false);
    await agent.logout(); await agent.getAuthState(); expect(connect).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['ask', false, 'default'], ['auto', false, 'auto'], ['acceptEdits', false, 'accept-edits'],
    ['bypassPermissions', false, 'default'], ['ask', true, 'plan'],
  ] as const)('starts %s (plan=%s) using native mode %s', async (permissionMode, planMode, modeId) => {
    const h = setup(); await h.session.close(); const { agent, connect } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode, planMode });
    expect(connect).toHaveBeenCalledWith('/workspace', expect.objectContaining({ permissionMode, planMode }));
    expect(h.sent.find(x => x.method === 'session/set_mode')?.params).toEqual({ sessionId: 'native-1', modeId });
    await handle.close();
  });
  it('reopens the same native session with the chosen permission policy and preserves plan mode', async () => {
    const first = setup(); const second = setup();
    await first.session.close(); await second.session.close();
    const connect = vi.fn()
      .mockResolvedValueOnce({ transport: first.transport, assertSubscriptionOnly: first.policy })
      .mockResolvedValueOnce({ transport: second.transport, assertSubscriptionOnly: second.policy });
    const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
      getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
    } }, { connect, assertGenerationAllowed: async () => {}, modelsChanged: vi.fn() });
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    await handle.setPlanMode!(true);
    const events = handle.events()[Symbol.asyncIterator]();
    first.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: {
      sessionUpdate: 'tool_call', toolCallId: 'old-process-tool',
    } } });
    expect((await events.next()).value).toMatchObject({ type: 'tool_use', turnScope: 'background' });
    await handle.setPermissionMode!('bypassPermissions');
    // Unit: process replacement used to silently forget an open ID, leaving its published tool active.
    expect((await events.next()).value).toMatchObject({
      type: 'tool_result_full', turnScope: 'background', data: { toolUseId: 'old-process-tool', isError: true },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'tool_result', turnScope: 'background', data: { toolUseIds: ['old-process-tool'], summary: 'failed' },
    });
    expect(connect).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({ permissionMode: 'bypassPermissions', resumeSessionId: 'native-1' }));
    expect(second.sent.find(x => x.method === 'session/load')?.params).toMatchObject({ sessionId: 'native-1' });
    expect(second.sent.find(x => x.method === 'session/set_mode')?.params).toEqual({ sessionId: 'native-1', modeId: 'plan' });
    expect(handle.getPlanMode!()).toBe(true);
    await handle.close();
  });
  it('does not adopt a failed permission change and restores the confirmed policy before the next send', async () => {
    const first = setup(); const recovered = setup();
    await first.session.close(); await recovered.session.close();
    const connect = vi.fn()
      .mockResolvedValueOnce({ transport: first.transport, assertSubscriptionOnly: first.policy })
      .mockRejectedValueOnce(new Error('TEST_RECONNECT_FAILED'))
      .mockResolvedValueOnce({ transport: recovered.transport, assertSubscriptionOnly: recovered.policy });
    const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
      getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
    } }, { connect, assertGenerationAllowed: async () => {}, modelsChanged: vi.fn() });
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    await expect(handle.setPermissionMode!('bypassPermissions')).rejects.toThrow('TEST_RECONNECT_FAILED');
    expect(first.sent.some(x => x.method === 'session/prompt')).toBe(false);
    await handle.send({ type: 'user', content: 'hello' });
    expect(connect).toHaveBeenLastCalledWith('/workspace', expect.objectContaining({ permissionMode: 'ask', resumeSessionId: 'native-1' }));
    expect(recovered.sent.filter(x => x.method === 'session/prompt')).toHaveLength(1);
    await handle.close();
  });
  it('blocks sends during permission replacement and closes a late replacement after close', async () => {
    const first = setup(); const replacement = setup();
    await first.session.close(); await replacement.session.close();
    const closeReplacement = vi.spyOn(replacement.transport, 'close');
    let release!: (connection: unknown) => void;
    const connect = vi.fn()
      .mockResolvedValueOnce({ transport: first.transport, assertSubscriptionOnly: first.policy })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const allowed = vi.fn(async () => {});
    const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
      getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
    } }, { connect, assertGenerationAllowed: allowed, modelsChanged: vi.fn() });
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    const change = handle.setPermissionMode!('bypassPermissions');
    const rejectedChange = expect(change).rejects.toThrow('CLOSED');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { interval: 1 });
    await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow('TURN_UNSUPPORTED');
    const closing = handle.close();
    release({ transport: replacement.transport, assertSubscriptionOnly: replacement.policy });
    await rejectedChange; await closing;
    expect(closeReplacement).toHaveBeenCalled();
    expect(allowed).not.toHaveBeenCalled();
    expect(replacement.sent.some(x => x.method === 'session/prompt')).toBe(false);
  });
  it('sends host-resolved file attachments as ACP resource links', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'auto' });
    await handle.send({ type: 'user', content: [{ type: 'text', text: 'Read this file' }, { type: 'file', path: '/workspace/input.txt', mimeType: 'text/plain' }] });
    expect(h.sent.find(x => x.method === 'session/prompt')?.params).toMatchObject({ prompt: [
      { type: 'text', text: 'Read this file' }, { type: 'resource_link', uri: pathToFileURL('/workspace/input.txt').href, name: 'input.txt', mimeType: 'text/plain' },
    ] });
    await handle.close();
  });
  it('projects the official plan without forwarding authentication metadata', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const auth = await agent.triggerLogin();
    expect(auth).toMatchObject({ authenticated: true, authSource: 'oauth', subscriptionTier: { id: 'test-pro', name: 'Google AI Pro' } });
    expect(JSON.stringify(auth)).not.toContain('not-forwarded');
    await agent.logout();
    expect(await agent.getAuthState()).toEqual({ authenticated: false, authSource: 'oauth' });
  });
  it('delivers a native turn and appends Cindy instructions at the official system-prompt boundary', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask', [TASK_SYSTEM_PROMPT]: 'Cindy task instructions' });
    expect(handle.agentKind).toBe('antigravity');
    expect(await agent.getAuthState()).toMatchObject({ authenticated: true, authSource: 'oauth', subscriptionTier: { id: 'test-pro', name: 'Google AI Pro' } });
    expect(h.sent.find(x => x.method === 'session/new')?.params).toMatchObject({ _meta: { antigravity: { systemPrompt: { append: 'Cindy task instructions' } } } });
    const iterator = handle.events()[Symbol.asyncIterator]();
    await handle.send({ type: 'user', content: 'hello' });
    expect((await iterator.next()).value).toMatchObject({
      type: 'status', source: 'antigravity', data: { isRunning: true, status: 'Thinking...' },
    });
    expect((await iterator.next()).value).toMatchObject({ type: 'done', source: 'antigravity' });
    expect(h.sent.find(x => x.method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: 'hello' }] });
    await handle.close();
  });
  // Unit: native terminal tool_call must close the same card as tool_call_update.
  // The latter was the only form covered, leaving background work open after a valid reply.
  it.each(['tool_call', 'tool_call_update'])('delivers and finalizes a wake after the prompt reply with terminal %s', async (terminalUpdate) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup(false, true);
    await h.session.close();
    const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    try {
      const events = handle.events()[Symbol.asyncIterator]();
      await handle.send({ type: 'user', content: 'start the background tool' });
      expect((await events.next()).value).toMatchObject({ type: 'status', data: { isRunning: true } });
      const update = (data: AcpRecord) => h.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: data } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'background-tool', title: 'background work' });
      const prompt = h.sent.find(x => x.method === 'session/prompt')!;
      h.inbound({ id: prompt.id, result: { stopReason: 'end_turn' } });
      // Same stdout batch as the reply, before promise continuations run.
      update({ sessionUpdate: terminalUpdate, toolCallId: 'background-tool', status: 'completed' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'background-tool', status: 'completed' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'background-tool', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Command output' } }] });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Work finished.' } });
      expect((await events.next()).value).toMatchObject({ type: 'tool_use' });
      expect((await events.next()).value).toMatchObject({ type: 'done', data: { status: 'completed' } });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result_full', turnScope: 'background' });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result', turnScope: 'background' });
      expect((await events.next()).value).toMatchObject({
        type: 'tool_result_full', turnScope: 'background', data: { fullText: 'Command output' },
      });
      expect((await events.next()).value).toMatchObject({ type: 'text', turnScope: 'background', data: { text: 'Work finished.', isFinal: false } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await events.next()).value).toMatchObject({ type: 'text', turnScope: 'background', data: { text: 'Work finished.', isFinal: true, isFullText: true } });
      expect(h.sent.filter(x => x.method === 'session/prompt')).toHaveLength(1);
      expect(handle.isTurnRunning?.()).toBe(false);
      await handle.abort();
      expect(h.sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'native-1' } });
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });
  it('keeps a previous turn tool result background while a new turn is running', async () => {
    const h = setup(false, true);
    await h.session.close();
    const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    const update = (data: AcpRecord) => h.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: data } });
    try {
      const events = handle.events()[Symbol.asyncIterator]();
      await handle.send({ type: 'user', content: 'start a tool' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      update({ sessionUpdate: 'tool_call', toolCallId: 'earlier-tool' });
      expect((await events.next()).value).toMatchObject({ type: 'tool_use' });
      h.inbound({ id: h.sent.at(-1)?.id, result: { stopReason: 'end_turn' } });
      expect((await events.next()).value).toMatchObject({ type: 'done' });

      await handle.send({ type: 'user', content: 'next prompt' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'earlier-tool', status: 'completed' });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result_full', turnScope: 'background' });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result', turnScope: 'background' });
      expect(handle.isTurnRunning?.()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  // Unit, cd245937: cover progress and a native exit for a run_command that
  // has no ACP result at turn end. Existing ACP tests only send terminal frames.
  it('emits exact background command activity without losing a later ACP result', async () => {
    const h = setup(false, true);
    await h.session.close();
    const stopWatching = vi.fn();
    let commandExited!: (exit: AntigravityCommandExit) => void;
    const watchCommandExits = vi.fn((_sessionId: string, onExit: typeof commandExited) => {
      commandExited = onExit;
      return stopWatching;
    });
    const { agent } = makeAgent(h, { watchCommandExits });
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    const update = (type: string, data: AcpRecord) => h.inbound({
      method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: type, toolCallId: 'call-1', ...data } },
    });
    try {
      const events = handle.events()[Symbol.asyncIterator]();
      await handle.send({ type: 'user', content: 'start a command' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      update('tool_call', { name: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { WaitMsBeforeAsync: 8000 } });
      expect((await events.next()).value).toMatchObject({ type: 'tool_use', data: { toolUseId: 'call-1' } });
      h.inbound({ id: h.sent.at(-1)?.id, result: { stopReason: 'end_turn' } });
      expect((await events.next()).value).toMatchObject({ type: 'done' });
      expect(watchCommandExits).toHaveBeenCalledExactlyOnceWith('native-1', expect.any(Function));

      await handle.send({ type: 'user', content: 'next prompt' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      update('tool_call_update', { status: 'in_progress', title: 'same operation' });
      commandExited({ taskId: 'native-1/task-22', toolUseId: 'other-call' });
      update('tool_call_update', { status: 'in_progress', rawOutput: { output: 'new command output' } });
      expect((await events.next()).value).toMatchObject({
        type: 'antigravity_tool_activity', turnScope: 'background', data: { kind: 'tool_progress', toolUseId: 'call-1' },
      });

      const exit = { taskId: 'native-1/task-21', toolUseId: 'call-1' };
      update('tool_call_update', { status: 'in_progress', rawOutput: { output: 'new command output' } });
      commandExited(exit);
      commandExited(exit);
      expect((await events.next()).value).toMatchObject({
        type: 'antigravity_tool_activity', turnScope: 'background', data: { kind: 'command_exited', ...exit },
      });
      expect(stopWatching).toHaveBeenCalledOnce();

      update('tool_call_update', { status: 'completed', content: [{ content: { type: 'text', text: 'Late command output' } }] });
      expect((await events.next()).value).toMatchObject({
        type: 'tool_result_full', turnScope: 'background', data: { toolUseId: 'call-1', fullText: 'Late command output' },
      });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result', turnScope: 'background' });
      expect(handle.isTurnRunning?.()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it.each(['cancelled', 'error'] as const)('settles a dispatched prompt on %s', async (outcome) => {
    const h = setup(false, true);
    await h.session.close();
    const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    try {
      const events = handle.events()[Symbol.asyncIterator]();
      await handle.send({ type: 'user', content: 'hello' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      const prompt = h.sent.find(x => x.method === 'session/prompt')!;
      h.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'tool_call', toolCallId: 'unfinished' } } });
      expect((await events.next()).value).toMatchObject({ type: 'tool_use' });
      if (outcome === 'cancelled') {
        await handle.abort();
        expect(h.sent).toContainEqual(expect.objectContaining({ method: 'session/cancel' }));
        h.inbound({ id: prompt.id, result: { stopReason: 'cancelled' } });
      } else {
        h.inbound({ id: prompt.id, error: { code: -32603 } });
      }
      expect((await events.next()).value).toMatchObject({ type: 'tool_result_full', data: { isError: true, toolUseId: 'unfinished' } });
      expect((await events.next()).value).toMatchObject({ type: 'tool_result', data: { summary: 'failed' } });
      expect((await events.next()).value).toMatchObject(outcome === 'cancelled'
        ? { type: 'done', data: { cancelled: true } }
        : { type: 'error', data: { isTerminal: true } });
      expect(handle.isTurnRunning?.()).toBe(false);
    } finally {
      await handle.close();
    }
  });
  it('retires an unresponsive transport when the CLI ignores cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup(false, true);
    await h.session.close();
    const close = vi.spyOn(h.transport, 'close');
    const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', providerId: 'google-antigravity-subscription', model: 'gemini-test', permissionMode: 'ask' });
    try {
      const events = handle.events()[Symbol.asyncIterator]();
      await handle.send({ type: 'user', content: 'hello' });
      expect((await events.next()).value).toMatchObject({ type: 'status' });
      await handle.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(close).toHaveBeenCalledOnce();
      expect((await events.next()).value).toMatchObject({ type: 'done', data: { cancelled: true } });
      expect(handle.isTurnRunning?.()).toBe(false);
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });
  it('starts a V2 teammate with its host identity and project context, while rejecting a classic isolated profile', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const profile = { botId: 'google-bot', profileVersion: 1, projectContext: true,
      skillPolicy: { mode: 'inherit' as const, configured: [], catalog: [] },
      mcpPolicy: { mode: 'inherit' as const, configured: [], catalog: [] },
      toolsetPolicy: { mode: 'inherit' as const, configured: [], catalog: [] } };
    const options = { workingDir: '/teammate/workspace', providerId: 'google-antigravity-subscription',
      model: 'gemini-test', permissionMode: 'bypassPermissions' as const, botRuntimeProfile: profile,
      botProfilePrompt: 'You are the Gemini validation teammate.', botProfileContextPrompt: 'Reply to the requesting parent.',
      [TASK_SYSTEM_PROMPT]: 'Cindy task instructions' };
    const handle = await agent.startSession(options);
    expect(h.sent.find(x => x.method === 'session/new')?.params).toMatchObject({ _meta: { antigravity: { systemPrompt: {
      append: 'Cindy task instructions\n\nYou are the Gemini validation teammate.\n\nReply to the requesting parent.',
    } } } });
    expect(handle.agentKind).toBe('antigravity');
    await handle.close();
    await expect(agent.startSession({ ...options, botRuntimeProfile: { ...profile, projectContext: false } })).rejects.toThrow('ANTIGRAVITY_LOCAL_SESSION_ONLY');
  });
  // Unit: some calls first appear in a terminal update. They still need a
  // tool_use anchor so the persist pipeline can attach the native result.
  it.each([false, true])('translates text and tool output in order (terminal-only=%s)', async (terminalOnly) => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
    const update = (data: AcpRecord) => h.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: data } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking' } });
    const tool = { toolCallId: 'tool-1', title: 'read_file', rawInput: { path: '/workspace/readme' } };
    if (!terminalOnly) update({ sessionUpdate: 'tool_call', ...tool });
    update({ sessionUpdate: 'tool_call_update', ...tool, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const events = [];
    for (let i = 0; i < 5; i++) events.push((await iterator.next()).value);
    expect(events[0]).toMatchObject({ type: 'text', data: { text: 'Checking', isFinal: false } });
    expect(events[1]).toMatchObject({ type: 'text', data: { text: 'Checking', isFinal: true, isFullText: true } });
    expect(events[2]).toMatchObject({ type: 'tool_use', data: { toolUseId: 'tool-1' } });
    expect(events[3]).toMatchObject({ type: 'tool_result_full', data: { toolUseId: 'tool-1', fullText: 'file contents', isError: false } });
    expect(events[4]).toMatchObject({ type: 'tool_result', data: { toolUseIds: ['tool-1'], summary: 'done' } });
    await handle.close();
  });
  it('disconnect blocks retained handles and new sessions without erasing native credentials', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const opts = { workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask' as const, providerId: 'google-antigravity-subscription' };
    const handle = await agent.startSession(opts);
    await agent.logout();
    await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow('已断开');
    await expect(agent.startSession(opts)).rejects.toThrow('已断开');
    expect(h.sent.some(x => x.method === 'session/prompt')).toBe(false);
    await handle.close();
  });
  it('rejects remote/profile/unsupported permission routing before starting a process', async () => {
    const h = setup(); await h.session.close(); const { agent, connect } = makeAgent(h);
    for (const patch of [{ remoteHostId: 'remote' }, { providerId: 'openai' }]) {
      await expect(agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription', ...patch })).rejects.toThrow();
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('blocks generation when the executing host cannot verify the subscription spending boundary', async () => {
    const h = setup(); await h.session.close(); const { agent, allowed } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
    allowed.mockRejectedValueOnce(new Error('BOUNDARY_UNVERIFIED'));
    await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow('BOUNDARY_UNVERIFIED');
    expect(h.sent.some(x => x.method === 'session/prompt')).toBe(false); await handle.close();
  });
  it('honors Stop during the Cindy host preflight before accepting a turn', async () => {
    const h = setup(); await h.session.close(); const { agent, allowed } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
    let release!: () => void;
    allowed.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = handle.send({ type: 'user', content: 'hello' });
    await handle.abort(); release();
    await expect(pending).rejects.toThrow();
    expect(h.sent.some(x => x.method === 'session/prompt')).toBe(false); await handle.close();
  });

  // 测试价值
  // - 生产入口与可观察结果：AntigravityAgent.startSession + handle.send（含 image block）；验证 capabilities.multimodal.image、modelsChanged、base64 image/resource_link 协议块及错误语义。
  // - Bug／规则依据：Antigravity CLI 1.5.9 握手已返回 promptCapabilities.image: true，但此前 AntigravityAgent 硬编码 image: no 并直接抛 ANTIGRAVITY_IMAGE_INPUT_UNSUPPORTED。
  // - 现有覆盖缺口：原有单测仅测 text/file/mention，未覆盖 image block 的编码、降级与读文件失败恢复。
  // - 最小失败输入：传入 { type: 'image', path } 时直接抛 ANTIGRAVITY_IMAGE_INPUT_UNSUPPORTED。
  // - tier：unit（内存 ACP 协议对端 + 临时文件）。
  it('sends base64 image blocks when promptCapabilities.image is true and recovers on missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-image-'));
    const pngPath = join(dir, 'shot.png');
    const jpgPath = join(dir, 'photo.jpg');
    const svgPath = join(dir, 'diagram.svg');
    const missingPath = join(dir, 'missing.png');
    writeFileSync(pngPath, Buffer.from([1, 2, 3]));
    writeFileSync(jpgPath, Buffer.from([4, 5, 6]));
    writeFileSync(svgPath, '<svg/>');
    try {
      const h = setup(false, false, '1.5.9', 1, true);
      await h.session.close();
      const modelsChanged = vi.fn();
      const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
        getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
      } }, { connect: async () => ({ transport: h.transport, assertSubscriptionOnly: h.policy }), assertGenerationAllowed: async () => {}, modelsChanged });

      const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
      expect(agent.capabilities.multimodal.image.supported).toBe(true);
      expect(modelsChanged).toHaveBeenLastCalledWith(
        expect.any(Array),
        expect.objectContaining({ name: 'Google AI Pro' }),
        { supportsImageInput: true },
      );

      await expect(handle.send({ type: 'user', content: [{ type: 'image', path: 'relative/shot.png' }] })).rejects.toThrow('ANTIGRAVITY_ATTACHMENT_PATH_INVALID');
      await expect(handle.send({ type: 'user', content: [{ type: 'image', path: missingPath, mimeType: 'image/png' }] })).rejects.toThrow('ANTIGRAVITY_IMAGE_READ_FAILED');

      await handle.send({
        type: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', path: pngPath, mimeType: 'image/png' },
          { type: 'image', path: jpgPath },
          { type: 'image', path: svgPath, mimeType: 'image/svg+xml' },
        ],
      });
      const prompt = h.sent.find(x => x.method === 'session/prompt');
      expect(prompt?.params).toEqual({
        sessionId: 'native-1',
        prompt: [
          { type: 'text', text: 'describe' },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
          { type: 'resource_link', uri: pathToFileURL(svgPath).href, name: 'diagram.svg', mimeType: 'image/svg+xml' },
        ],
      });
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades image blocks to resource_link when promptCapabilities.image is false', async () => {
    const h = setup(false, false, '1.5.9', 1, false);
    await h.session.close();
    const modelsChanged = vi.fn();
    const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
      getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
    } }, { connect: async () => ({ transport: h.transport, assertSubscriptionOnly: h.policy }), assertGenerationAllowed: async () => {}, modelsChanged });

    const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
    expect(agent.capabilities.multimodal.image.supported).toBe(false);
    expect(modelsChanged).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ name: 'Google AI Pro' }),
      { supportsImageInput: false },
    );

    await handle.send({
      type: 'user',
      content: [{ type: 'image', path: '/workspace/shot.png', mimeType: 'image/png' }],
    });
    const prompt = h.sent.find(x => x.method === 'session/prompt');
    expect(prompt?.params).toEqual({
      sessionId: 'native-1',
      prompt: [{ type: 'resource_link', uri: pathToFileURL('/workspace/shot.png').href, name: 'shot.png', mimeType: 'image/png' }],
    });
    await handle.close();
  });

});
