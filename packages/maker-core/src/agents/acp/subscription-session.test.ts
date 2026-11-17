/**
 * Production entry: AcpSubscriptionSession; observable ACP messages/permission decisions.
 * Rule: personal OAuth only, no API fallback, cancel pending permissions, exact resume.
 * Gap: first ACP engine; existing Pi/Codex transports don't cover ACP semantics.
 * Minimal failure: oauth-personal rejected, then open/prompt must never be dispatched.
 * Tier: unit (in-memory protocol peer; no process, credentials or network).
 */
import { describe, it, expect, vi } from 'vitest';
import { AntigravityAgent } from './antigravity-agent.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { TASK_SYSTEM_PROMPT } from '../base-agent.js';
import { AcpSubscriptionSession } from './subscription-session.js';
import { personalSubscriptionEnv } from './transport.js';
import type { AcpTransport, AcpRecord } from './client.js';
function setup(authFails = false) {
  const sent: AcpRecord[] = []; const received = new Set<(line: string) => void>();
  const transport: AcpTransport = {
    onLine: fn => { received.add(fn); return () => { received.delete(fn); }; }, onClose: () => () => {}, close: async () => {},
    write(line) {
      const req = JSON.parse(line); sent.push(req);
      if (req.id === undefined) return;
      let result: unknown = {};
      if (req.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server' }, agentCapabilities: { loadSession: true, _meta: { antigravity: { systemPrompt: { append: true } } } }, authMethods: [{ id: 'oauth-personal' }] };
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
  function makeAgent(h: ReturnType<typeof setup>) {
    const allowed = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ transport: h.transport, assertSubscriptionOnly: h.policy }));
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
    await handle.setPermissionMode!('bypassPermissions');
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
      { type: 'text', text: 'Read this file' }, { type: 'resource_link', uri: 'file:///workspace/input.txt', name: 'input.txt', mimeType: 'text/plain' },
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
    expect((await iterator.next()).value).toMatchObject({ type: 'done', source: 'antigravity' });
    expect(h.sent.find(x => x.method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: 'hello' }] });
    await handle.close();
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
  it('translates text and tool output into Cindy events without losing the final answer', async () => {
    const h = setup(); await h.session.close(); const { agent } = makeAgent(h);
    const handle = await agent.startSession({ workingDir: '/workspace', model: 'gemini-test', permissionMode: 'ask', providerId: 'google-antigravity-subscription' });
    const update = (data: AcpRecord) => h.inbound({ method: 'session/update', params: { sessionId: 'native-1', update: data } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read_file', rawInput: { path: '/workspace/readme' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] });
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

});
