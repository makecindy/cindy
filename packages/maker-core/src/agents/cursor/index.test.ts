import { describe, expect, it, vi } from 'vitest';
import { CursorAgent, CURSOR_DEFAULT_MODEL, type CursorAgentDeps } from './index.js';
import { AgentStartupCleanupPendingError, PINNED_SKILL_INVOCATION, AUTO_REVIEW_USER_INTENT } from '../base-agent.js';
import { LIBRARY_READ_ROOT } from '../shared/library-native-read.js';
import type { AcpTransport } from '../acp/transport.js';
import type { InteractionDecision, AgentEvent, InteractionRequest } from '../../types/events.js';
import { readCursorModels } from './models.js';
import { cursorAnswers } from './questions.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { CursorTranslator } from './translator.js';
import { access, rm } from 'node:fs/promises';

interface FakeMessage {
  id?: string | number;
  method?: string;
  params: Record<string, unknown> & { prompt: Array<{ type: string; text?: string }> };
  result: unknown;
  error: { code: number };
}

class FakeTransport implements AcpTransport {
  lines = new Set<(line: string) => void>();
  closes = new Set<(info: { reason: string }) => void>();
  written: FakeMessage[] = [];
  failClose = false;
  closeCount = 0;
  session = { sessionId: 'native-1', modes: { availableModes: [{ id: 'agent' }, { id: 'plan' }] },
    configOptions: [{ id: 'native-model-picker', category: 'model', currentValue: 'auto-native',
      options: [{ value: 'auto-native', name: 'Auto' }, { value: 'model-b', name: 'Model B' }] }] };
  held = new Set<string>(['session/prompt']);
  loadReplay = false;
  onWrite?: (message: FakeMessage) => void;
  async writeLine(line: string) {
    const message: FakeMessage = JSON.parse(line);
    this.written.push(message);
    this.onWrite?.(message);
    if (!message.method || message.id === undefined || this.held.has(message.method)) return;
    let result: unknown = {};
    if (message.method === 'initialize') result = { protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: 'cursor_login' }] };
    if (message.method === 'session/new' || message.method === 'session/load') {
      if (message.method === 'session/load' && this.loadReplay) this.update('agent_message_chunk', { content: { type: 'text', text: 'old' } });
      result = this.session;
    }
    queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, result }));
  }
  emit(message: unknown) { for (const listener of this.lines) listener(JSON.stringify(message)); }
  update(sessionUpdate: string, data = {}) { this.emit({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'native-1', update: { sessionUpdate, ...data } } }); }
  finish() { const request = this.written.filter(item => item.method === 'session/prompt').at(-1)!;
    this.emit({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }); }
  onLine(handler: (line: string) => void) { this.lines.add(handler); return () => { this.lines.delete(handler); }; }
  onClose(handler: (info: { reason: string }) => void) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  async close() { this.closeCount++; if (this.failClose) throw new Error('exit unconfirmed');
    for (const listener of this.closes) listener({ reason: 'closed' }); }
}
function create(fake = new FakeTransport(), extra: Partial<CursorAgentDeps> = {}) {
  const agent = new CursorAgent({ binaryPath: '/fake/cursor-agent', runtimeConfig: {},
    auth: { getState: vi.fn(async () => ({ authenticated: true })), getAuthEnv: vi.fn(async () => ({})),
      triggerLogin: vi.fn(async () => ({ authenticated: true })), logout: vi.fn(async () => {}) },
    logger: createConsoleLogger('cursor-test'),
    createCursorTransport: () => fake, ...extra,
  });
  return { fake, agent, start: (options = {}) => agent.startSession({ workingDir: '/tmp', model: CURSOR_DEFAULT_MODEL, ...options }) };
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

function permission(fake: FakeTransport, id: string, tool = { kind: 'execute', rawInput: { command: 'curl -X POST https://example.invalid -d fixture' } }) {
  fake.emit({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: 'native-1', toolCall: { toolCallId: `tool-${id}`, ...tool }, options: [
      { kind: 'allow_always', optionId: 'machine-wide' },
      { kind: 'allow_once', optionId: 'opaque-allow' }, { kind: 'reject_once', optionId: 'opaque-deny' },
    ],
  } });
}

describe('Cursor approval modes', () => {
  it.each([undefined, 'native-1'])('supports full access on new and resumed tasks (%s) without persistent native grants', async resumeSessionId => {
    const { fake, start } = create();
    const handle = await start({ permissionMode: 'bypassPermissions', resumeSessionId });
    await handle.send({ type: 'user', content: 'run the fixture command' });
    permission(fake, 'full'); await tick();
    expect(fake.written.find(item => item.id === 'full')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opaque-allow' } });
    expect(fake.written.some(item => item.method === 'session/set_config_option')).toBe(false);
    await handle.close();
  });

  it('automatically allows a concrete safe command without calling the reviewer or opening a card', async () => {
    const review = vi.fn(); const surface = vi.fn();
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto' });
    handle.setInteractionResolver(surface);
    await handle.send({ type: 'user', content: 'check the directory' });
    permission(fake, 'safe', { kind: 'execute', rawInput: { command: 'pwd' } }); await tick();
    expect(fake.written.find(item => item.id === 'safe')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opaque-allow' } });
    expect(review).not.toHaveBeenCalled(); expect(surface).not.toHaveBeenCalled();
    await handle.close();
  });

  it.each(['allow', 'block'] as const)('uses the shared reviewer and current user authorization for %s', async verdict => {
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(async () => ({ verdict, reason: 'fixture verdict' }));
    const surface = vi.fn();
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto', sessionId: 'business-1', providerId: 'cursor' });
    handle.setInteractionResolver(surface);
    await handle.send({ type: 'user', content: 'Read the fixture endpoint only; do not publish anything.' });
    permission(fake, 'review'); await tick();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'cursor', model: 'auto-native',
      providerId: 'cursor', sessionId: 'business-1', workspaceRoots: ['/tmp'], writableRoots: ['/tmp'],
      action: { kind: 'exec', command: 'curl -X POST https://example.invalid -d fixture', cwd: '/tmp' } }));
    expect(JSON.stringify(review.mock.calls[0][0].userIntent)).toContain('do not publish anything');
    expect(fake.written.find(item => item.id === 'review')?.result).toEqual({ outcome: { outcome: 'selected', optionId: verdict === 'allow' ? 'opaque-allow' : 'opaque-deny' } });
    expect(surface).not.toHaveBeenCalled();
    await handle.close();
  });

  it('falls back to a marked confirmation card and one notice when automatic review is unavailable', async () => {
    const { fake, start } = create();
    const handle = await start({ permissionMode: 'auto' }); const events: AgentEvent[] = [];
    const pump = (async () => { for await (const event of handle.events()) events.push(event); })();
    const surface = vi.fn<(request: InteractionRequest) => Promise<InteractionDecision>>(async () => ({ kind: 'permission', behavior: 'allow' }));
    handle.setInteractionResolver(surface);
    await handle.send({ type: 'user', content: 'Read the fixture endpoint' });
    permission(fake, 'first'); await tick(); permission(fake, 'second'); await tick();
    expect(surface).toHaveBeenCalledTimes(2);
    expect(surface.mock.calls[0][0]).toMatchObject({ kind: 'permission', metadata: { autoReviewUnavailable: true } });
    await handle.close(); await pump;
    expect(events.filter(event => event.type === 'error' && String((event.data as { message?: string }).message).startsWith('[AUTO_REVIEW_UNAVAILABLE]'))).toHaveLength(1);
  });

  it('releases an existing tool confirmation when switched to full access, once', async () => {
    const { fake, start } = create(); const handle = await start();
    let answer!: (decision: InteractionDecision) => void;
    handle.setInteractionResolver(() => new Promise(resolve => { answer = resolve; }));
    await handle.send({ type: 'user', content: 'run the fixture command' });
    permission(fake, 'pending'); await tick();
    await handle.setPermissionMode!('bypassPermissions'); await tick();
    answer({ kind: 'permission', behavior: 'deny' }); await tick();
    expect(fake.written.filter(item => item.id === 'pending')).toHaveLength(1);
    expect(fake.written.find(item => item.id === 'pending')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opaque-allow' } });
    await handle.close();
  });

  it('uses the host-restored authorization on a resumed task instead of authorizing from continuation text', async () => {
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(async () => ({ verdict: 'block' }));
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto', resumeSessionId: 'native-1' });
    const intent = 'Read the fixture only. Do not upload or publish anything.';
    await handle.send({ type: 'user', content: 'Continue' }, { [AUTO_REVIEW_USER_INTENT]: intent });
    permission(fake, 'restored'); await tick();
    expect(review.mock.calls[0][0].userIntent).toBe(intent);
    expect(fake.written.find(item => item.id === 'restored')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opaque-deny' } });
    await handle.close();
  });

  it('shows an unavailable-review notice again on a new turn after the earlier banner was cleared', async () => {
    const { fake, start } = create(); const handle = await start({ permissionMode: 'auto' });
    const events: AgentEvent[] = [];
    const pump = (async () => { for await (const event of handle.events()) events.push(event); })();
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'deny' }));
    for (const id of ['first-turn', 'second-turn']) {
      await handle.send({ type: 'user', content: 'Read the fixture endpoint' });
      permission(fake, id); await tick(); fake.finish(); await tick();
    }
    await handle.close(); await pump;
    expect(events.filter(event => event.type === 'error' && String((event.data as { message?: string }).message).startsWith('[AUTO_REVIEW_UNAVAILABLE]'))).toHaveLength(2);
  });

  it('ignores an old automatic allow after switching back to default permissions', async () => {
    let reviewed!: (decision: { verdict: 'allow' }) => void;
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(() => new Promise(resolve => { reviewed = resolve; }));
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto' });
    let answer!: (decision: InteractionDecision) => void;
    handle.setInteractionResolver(() => new Promise(resolve => { answer = resolve; }));
    await handle.send({ type: 'user', content: 'Read the fixture endpoint' });
    permission(fake, 'stale'); await tick();
    await handle.setPermissionMode!('ask'); await tick();
    reviewed({ verdict: 'allow' }); await tick();
    expect(fake.written.some(item => item.id === 'stale')).toBe(false);
    answer({ kind: 'permission', behavior: 'deny' }); await tick();
    expect(fake.written.find(item => item.id === 'stale')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opaque-deny' } });
    await handle.close();
  });

  it('cancels a pending automatic review immediately on Stop and ignores the late verdict', async () => {
    let reviewed!: (decision: { verdict: 'allow' }) => void;
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(() => new Promise(resolve => { reviewed = resolve; }));
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto' });
    await handle.send({ type: 'user', content: 'Read the fixture endpoint' });
    permission(fake, 'stop'); await tick();
    const abort = handle.abort(); await tick();
    expect(fake.written.find(item => item.id === 'stop')?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    reviewed({ verdict: 'allow' }); fake.finish(); await abort; await tick();
    expect(fake.written.filter(item => item.id === 'stop')).toHaveLength(1);
    await handle.close();
  });

  it('reviews host MCP actions against the same accepted user intent and rejects after close', async () => {
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(async () => ({ verdict: 'allow' }));
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto' });
    await handle.send({ type: 'user', content: 'Only inspect the fixture issue' });
    const action = { kind: 'other' as const, description: 'Look up the fixture issue' };
    expect(await handle.reviewAutoPermissionAction!(action)).toMatchObject({ verdict: 'allow' });
    expect(JSON.stringify(review.mock.calls[0][0].userIntent)).toContain('Only inspect the fixture issue');
    fake.finish(); await tick(); await handle.close();
    expect(await handle.reviewAutoPermissionAction!(action)).toMatchObject({ verdict: 'block' });
  });

  it('retains a blocked action for the next human follow-up without treating it as consent', async () => {
    const review = vi.fn<NonNullable<CursorAgentDeps['reviewAutoPermissionAction']>>(async () => ({ verdict: 'block' }));
    const { fake, start } = create(undefined, { reviewAutoPermissionAction: review });
    const handle = await start({ permissionMode: 'auto' });
    await handle.send({ type: 'user', content: 'Inspect the fixture' }); permission(fake, 'blocked'); await tick();
    fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'Why was that denied?' }); permission(fake, 'follow-up'); await tick();
    expect(review.mock.calls[1][0].precedingBlockedActions).toEqual([{ kind: 'exec', command: 'curl -X POST https://example.invalid -d fixture', cwd: '/tmp' }]);
    expect(JSON.stringify(review.mock.calls[1][0].userIntent)).toContain('Why was that denied');
    await handle.close();
  });
});

function parameterizedFixture() {
  const fake = new FakeTransport();
  const select = (id: string, category: string, currentValue: string, values: string[]) => ({
    id, category, type: 'select', currentValue, options: values.map(value => ({ value, name: value })),
  });
  const models = [
    { value: 'auto-native', name: 'Auto', configOptions: [] },
    { value: 'model-b', name: 'Grok', configOptions: [
      select('native-reasoning-id', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh']),
      select('fast', 'model_config', 'true', ['false', 'true']),
    ] },
    { value: 'kimi', name: 'Kimi', configOptions: [select('reasoning', 'thought_level', 'max', ['low', 'high', 'max'])] },
  ];
  let currentModel = 'auto-native';
  let configs: Record<string, unknown>[] = [];
  const refresh = () => { configs = [select('native-model-picker', 'model', currentModel, models.map(model => model.value)),
    ...structuredClone(models.find(model => model.value === currentModel)!.configOptions)]; };
  refresh();
  fake.onWrite = message => {
    let result: unknown;
    if (message.method === 'cursor/list_available_models') result = { models };
    if (message.method === 'session/new' || message.method === 'session/load') result = { ...fake.session, configOptions: configs };
    if (message.method === 'session/set_config_option') {
      if (message.params.configId === 'native-model-picker') { currentModel = String(message.params.value); refresh(); }
      else configs = configs.map(option => option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option);
      result = { configOptions: configs };
    }
    if (result !== undefined) fake.emit({ jsonrpc: '2.0', id: message.id, result });
  };
  return { ...create(fake), models, getConfigs: () => structuredClone(configs) };
}

describe('Cursor native model parameters', () => {
  it('negotiates the native parameterized picker and advertises each model’s actual controls', async () => {
    const { fake, agent, start } = parameterizedFixture();
    const handle = await start();
    expect(handle.model).toBe('auto-native');
    expect(agent.capabilities.availableModels.some(model => model.id === CURSOR_DEFAULT_MODEL)).toBe(false);
    expect(fake.written.find(message => message.method === 'initialize')!.params.clientCapabilities)
      .toMatchObject({ _meta: { parameterizedModelPicker: true }, session: { configOptions: { boolean: {} } } });
    expect(agent.capabilities.hasFastMode).toBe(true);
    expect(agent.capabilities.effort.supported).toBe(true);
    expect(agent.capabilities.availableModels.find(model => model.id === 'model-b'))
      .toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true });
    expect(agent.capabilities.availableModels.find(model => model.id === 'kimi'))
      .toMatchObject({ efforts: ['low', 'high', 'max'], defaultEffort: 'max', supportsFastMode: false });
    expect(agent.capabilities.availableModels.find(model => model.id === 'auto-native'))
      .toMatchObject({ efforts: [], defaultEffort: null, supportsFastMode: false });
    expect(fake.written.some(message => message.method === 'session/prompt')).toBe(false);
    await handle.close();
  });
  it('resolves old default selections to the native current model without advertising a synthetic choice', async () => {
    const { agent, start } = parameterizedFixture();
    const handle = await start({ resumeSessionId: 'native-1', model: CURSOR_DEFAULT_MODEL });
    expect(handle.model).toBe('auto-native');
    await handle.setModel!('model-b');
    expect(handle.model).toBe('model-b');
    await handle.setModel!(CURSOR_DEFAULT_MODEL);
    expect(handle.model).toBe('auto-native');
    expect(agent.capabilities.availableModels.map(model => model.id)).not.toContain(CURSOR_DEFAULT_MODEL);
    await handle.close();
  });
  it('applies startup effort and explicit Fast off before the first prompt, using native IDs', async () => {
    const { fake, start, getConfigs } = parameterizedFixture();
    const handle = await start({ model: 'model-b', effort: 'low', fastMode: false });
    expect(fake.written.filter(message => message.method === 'session/set_config_option').map(message => message.params))
      .toEqual([
        { sessionId: 'native-1', configId: 'native-model-picker', value: 'model-b' },
        { sessionId: 'native-1', configId: 'native-reasoning-id', value: 'low' },
        { sessionId: 'native-1', configId: 'fast', value: 'false' },
      ]);
    expect(getConfigs().find(option => option.id === 'fast')?.currentValue).toBe('false');
    expect(handle.getFastMode!()).toBe(false);
    await handle.send({ type: 'user', content: 'use my settings' });
    expect(fake.written.at(-1)?.method).toBe('session/prompt');
    fake.finish(); await tick(); await handle.close();
  });
  it('switches effort on the same model and reads back the acknowledged Fast value', async () => {
    const { start, getConfigs } = parameterizedFixture();
    const handle = await start({ model: 'model-b', fastMode: false });
    await handle.setModel!('model-b', { effort: 'xhigh' });
    await handle.setFastMode!(true);
    expect(getConfigs().find(option => option.id === 'native-reasoning-id')?.currentValue).toBe('xhigh');
    expect(handle.getFastMode!()).toBe(true);
    await handle.close();
  });
  it('uses the new model’s native effort ID and removes unsupported Fast', async () => {
    const { fake, start, getConfigs } = parameterizedFixture();
    const handle = await start({ model: 'model-b' });
    await handle.setModel!('kimi', { effort: 'high' });
    expect(getConfigs().find(option => option.id === 'reasoning')?.currentValue).toBe('high');
    expect(fake.written.filter(message => message.method === 'session/set_config_option').at(-1)?.params.configId).toBe('reasoning');
    await expect(handle.setFastMode!(true)).rejects.toThrow('fastMode');
    await expect(handle.setFastMode!(false)).resolves.toBeUndefined();
    expect(handle.getFastMode!()).toBe(false);
    await handle.close();
  });
  it('rejects an unsupported target effort before changing the model or dispatching a prompt', async () => {
    const { fake, start } = parameterizedFixture();
    const handle = await start();
    await expect(handle.setModel!('model-b', { effort: 'max' })).rejects.toThrow('effort');
    expect(fake.written.some(message => message.method === 'session/set_config_option')).toBe(false);
    await handle.close();
    await expect(start({ model: 'model-b', effort: 'ultra' })).rejects.toThrow('effort');
    expect(fake.written.some(message => message.method === 'session/prompt')).toBe(false);
  });
  it('reapplies persisted effort and Fast when loading the same native task', async () => {
    const { fake, start, getConfigs } = parameterizedFixture();
    const handle = await start({ resumeSessionId: 'native-1', model: 'model-b', effort: 'medium', fastMode: false });
    expect(handle.id).toBe('native-1');
    expect(fake.written.some(message => message.method === 'session/new')).toBe(false);
    expect(getConfigs().find(option => option.id === 'native-reasoning-id')?.currentValue).toBe('medium');
    expect(handle.getFastMode!()).toBe(false);
    await handle.close();
  });
  it('consumes complete config updates and refuses settings removed by the native agent', async () => {
    const { fake, start, getConfigs } = parameterizedFixture();
    const handle = await start({ model: 'model-b' });
    fake.update('config_option_update', { configOptions: getConfigs().filter(option => option.id !== 'fast') });
    await expect(handle.setFastMode!(true)).rejects.toThrow('fastMode');
    await handle.setEffort!('low');
    await handle.close();
  });
  it('does not mutate configuration while a turn is running', async () => {
    const { fake, start } = parameterizedFixture();
    const handle = await start({ model: 'model-b' });
    await handle.send({ type: 'user', content: 'wait' });
    const mutations = fake.written.filter(message => message.method === 'session/set_config_option').length;
    await expect(handle.setEffort!('low')).rejects.toThrow('active turn');
    await expect(handle.setFastMode!(false)).rejects.toThrow('active turn');
    expect(fake.written.filter(message => message.method === 'session/set_config_option')).toHaveLength(mutations);
    fake.finish(); await tick(); await handle.close();
  });
  it('keeps older CLIs usable when the optional native extension is absent', async () => {
    const { fake, agent, start } = create();
    fake.onWrite = message => {
      if (message.method === 'cursor/list_available_models') fake.emit({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Method not found' } });
    };
    const handle = await start({ model: 'model-b', fastMode: false });
    expect(agent.capabilities.hasFastMode).toBe(false);
    expect(agent.capabilities.effort.supported).toBe(false);
    await expect(handle.setEffort!('high')).rejects.toThrow('effort');
    await expect(handle.setFastMode!(true)).rejects.toThrow('fastMode');
    await handle.close();
  });
  it('uses the negotiated boolean type when Fast is a native boolean option', async () => {
    const { fake, start, getConfigs } = parameterizedFixture();
    const handle = await start({ model: 'model-b' });
    fake.update('config_option_update', { configOptions: getConfigs().map(option => option.id === 'fast'
      ? { id: 'fast', category: 'model_config', type: 'boolean', currentValue: true } : option) });
    await handle.setFastMode!(false);
    expect(fake.written.filter(message => message.method === 'session/set_config_option').at(-1)?.params)
      .toEqual({ sessionId: 'native-1', configId: 'fast', type: 'boolean', value: false });
    expect(handle.getFastMode!()).toBe(false);
    await handle.close();
  });
  it('retains the actual setting when the native agent rejects a change', async () => {
    const { fake, start } = parameterizedFixture();
    const handle = await start({ model: 'model-b' });
    const respond = fake.onWrite!;
    fake.onWrite = message => {
      if (message.method === 'session/set_config_option' && message.params.configId === 'fast') {
        fake.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Fast unavailable' } });
      } else respond(message);
    };
    await expect(handle.setFastMode!(false)).rejects.toThrow('Fast unavailable');
    expect(handle.getFastMode!()).toBe(true);
    await handle.setEffort!('low');
    await handle.close();
  });
});

describe('Cursor native ACP lifecycle', () => {
  it('describes native approval coverage without promising a prompt for every edit', () => {
    const { agent, fake } = create();
    expect(agent.capabilities.permissionModes.map(mode => mode.id)).toEqual(['ask', 'default', 'auto', 'bypassPermissions']);
    for (const mode of agent.capabilities.permissionModes) {
      expect(mode.description).toContain('native configured permission policy');
      expect(mode.description).toContain('only the approval requests Cursor sends');
      expect(mode.description).toContain('workspace edits may run without a prompt');
    }
    expect(agent.capabilities.turnPermissionPolicy?.supported.supported).toBe(false);
    expect(fake.written).toEqual([]);
  });
  it('starts once, persists native identity and streams multiple turns on one process', async () => {
    const { fake, agent, start } = create();
    expect(agent.capabilities.availableModels).toEqual([]);
    const handle = await start();
    const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    expect(handle.id).toBe('native-1');
    await handle.send({ type: 'user', content: 'one' });
    fake.update('agent_message_chunk', { content: { type: 'text', text: 'hello' } });
    fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'two' }); fake.finish(); await tick();
    await handle.close(); await consume;
    expect(fake.written.filter(item => item.method === 'session/new')).toHaveLength(1);
    expect(fake.written.filter(item => item.method === 'session/prompt')).toHaveLength(2);
    expect(events.filter(item => item.type === 'done')).toHaveLength(2);
    expect(events.find(item => item.type === 'session_id')?.data).toBe('native-1');
    expect(events.find(item => item.type === 'text')?.data).toEqual({ text: 'hello', isFinal: false });
  });
  it('suppresses native load replay and preserves saved identity', async () => {
    const { fake, start } = create(); fake.loadReplay = true;
    const handle = await start({ resumeSessionId: 'native-1' });
    const iterator = handle.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe('session_id');
    await handle.close();
    expect((await iterator.next()).done).toBe(true);
    expect(fake.written.some(item => item.method === 'session/new')).toBe(false);
  });
  it('preserves a loaded native plan mode and switches it off before sending', async () => {
    const { fake, start } = create();
    Object.assign(fake.session.modes, { currentModeId: 'plan' });
    const handle = await start({ resumeSessionId: 'native-1' });
    expect(handle.getPlanMode!()).toBe(true);
    await handle.send({ type: 'user', content: 'execute' }, { planMode: false });
    expect(fake.written.find(item => item.method === 'session/set_mode')?.params)
      .toEqual({ sessionId: 'native-1', modeId: 'agent' });
    expect(handle.getPlanMode!()).toBe(false);
    await handle.close();
  });
  it('applies an explicit startup mode after loading the native mode', async () => {
    const { fake, start } = create();
    Object.assign(fake.session.modes, { currentModeId: 'plan' });
    const handle = await start({ resumeSessionId: 'native-1', planMode: false });
    expect(fake.written.find(item => item.method === 'session/set_mode')?.params.modeId).toBe('agent');
    expect(handle.getPlanMode!()).toBe(false);
    await handle.close();
  });
  it('keeps mode notifications during load while suppressing transcript replay', async () => {
    const { fake, start } = create();
    fake.loadReplay = true;
    fake.onWrite = message => {
      if (message.method === 'session/load') fake.update('current_mode_update', { currentModeId: 'plan' });
    };
    const handle = await start({ resumeSessionId: 'native-1' });
    expect(handle.getPlanMode!()).toBe(true);
    await handle.close();
  });
  it('retains failed startup cleanup across retries and resolves exit proof only after close succeeds', async () => {
    const dispose = vi.fn();
    const { fake, agent, start } = create(undefined, { preparePiExtraSpawnConfig: async () => ({ disposeSessionCtx: dispose }) });
    fake.failClose = true;
    fake.onWrite = message => {
      if (message.method === 'initialize') fake.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32099, message: 'startup failed' } });
    };
    const failure = await start({ sessionId: 'failed-task' }).catch(error => error);
    expect(failure).toBeInstanceOf(AgentStartupCleanupPendingError);
    let stopped = false;
    void failure.whenStopped.then(() => { stopped = true; });
    await expect(start({ sessionId: 'failed-task' })).rejects.toBeInstanceOf(AgentStartupCleanupPendingError);
    await expect(agent.dispose()).rejects.toThrow();
    expect(fake.written.filter(item => item.method === 'initialize')).toHaveLength(1);
    expect(stopped).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    fake.failClose = false;
    await agent.dispose();
    await failure.whenStopped;
    expect(stopped).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it.each(['startup', 'probe-close'])('retains its model probe directory until %s cleanup is confirmed', async failurePoint => {
    const fake = new FakeTransport();
    let directory = '';
    const { agent } = create(fake, { createCursorTransport: options => { directory = options.cwd; return fake; } });
    fake.failClose = true;
    if (failurePoint === 'startup') fake.onWrite = message => {
      if (message.method === 'initialize') fake.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32099, message: 'startup failed' } });
    };
    try {
      await expect(agent.discoverModels()).rejects.toThrow();
      await expect(access(directory)).resolves.toBeUndefined();
      await expect(agent.dispose()).rejects.toThrow();
      await expect(access(directory)).resolves.toBeUndefined();
      fake.failClose = false;
      await agent.dispose();
      await vi.waitFor(async () => { await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' }); });
    } finally {
      fake.failClose = false;
      await agent.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  it('selects exact advertised config id/value and never sends default sentinel', async () => {
    const { fake, start } = create(); const handle = await start({ model: 'model-b' });
    expect(fake.written.find(item => item.method === 'session/set_config_option')!.params)
      .toEqual({ sessionId: 'native-1', configId: 'native-model-picker', value: 'model-b' });
    await handle.setModel!(CURSOR_DEFAULT_MODEL);
    expect(fake.written.filter(item => item.method === 'session/set_config_option').at(-1)!.params.value).toBe('auto-native');
    await handle.close();
  });
  it('answers approval with opaque allow_once ID, never grants always', async () => {
    const { fake, start } = create(); const handle = await start();
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow', permissionUpdates: [{}] }));
    await handle.send({ type: 'user', content: 'do it' });
    fake.emit({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 'native-1', toolCall: { toolCallId: 'tool1', title: 'write', kind: 'edit' },
      options: [{ kind: 'allow_always', optionId: 'global' }, { kind: 'allow_once', optionId: 'one-opaque' }],
    } });
    await tick();
    expect(fake.written.find(item => item.id === 'permission-1')!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'one-opaque' } });
    await handle.close();
  });
  it('cancels pending permissions and waits for prompt completion', async () => {
    const { fake, start } = create(); const handle = await start();
    handle.setInteractionResolver(() => new Promise(() => {}));
    await handle.send({ type: 'user', content: 'do it' });
    fake.emit({ jsonrpc: '2.0', id: 'p', method: 'session/request_permission', params: { sessionId: 'native-1', toolCall: {}, options: [] } });
    await tick();
    const abort = handle.abort(); await tick();
    expect(fake.written.find(item => item.id === 'p')!.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(fake.written.find(item => item.method === 'session/cancel')!.id).toBeUndefined();
    fake.finish(); await abort; await handle.close();
  });
  it('keeps reservation and aborts preparation before any prompt is dispatched', async () => {
    const { fake, start } = create(); const handle = await start(); fake.held.add('session/set_mode');
    const first = handle.send({ type: 'user', content: 'first' }, { planMode: true });
    await expect(handle.send({ type: 'user', content: 'second' })).rejects.toThrow('active turn');
    const rejected = expect(first).rejects.toThrow();
    await handle.abort(); await rejected;
    expect(fake.written.some(item => item.method === 'session/prompt')).toBe(false);
    await handle.close();
  });
  it('permits retry of unconfirmed process close without releasing bridge prematurely', async () => {
    const dispose = vi.fn(); const { fake, start } = create(undefined, {
      preparePiExtraSpawnConfig: async () => ({ disposeSessionCtx: dispose }),
    });
    const handle = await start(); fake.failClose = true;
    await expect(handle.close()).rejects.toThrow('exit unconfirmed'); expect(dispose).not.toHaveBeenCalled();
    await expect(handle.send({ type: 'user', content: 'blocked' })).rejects.toThrow('closed');
    fake.failClose = false; await handle.close(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('keeps native instructions intact and passes scoped Memory/context and MCP identity once', async () => {
    const prepare = vi.fn<NonNullable<CursorAgentDeps['preparePiExtraSpawnConfig']>>(async () => ({ mcpBridge: { token: 'fake-test-token', servers: [{ name: 'memory', url: 'http://127.0.0.1/mcp' }] }, disposeSessionCtx: vi.fn() }));
    const { fake, start } = create(undefined, { preparePiExtraSpawnConfig: prepare });
    const handle = await start({ sessionId: 'cindy-1', sessionInstanceId: 'instance-1', makerMemoryEnabled: true,
      makerMemoryScopeKey: 'bot:example', makerMemoryIndexSnapshot: 'Remembered context', userPrompt: 'User preference', vendorOptions: { orcaRole: 'lead' } });
    expect(prepare.mock.calls[0][1]).toMatchObject({ agentKind: 'cursor', sessionId: 'cindy-1', sessionInstanceId: 'instance-1',
      memoryScopeKey: 'bot:example', memoryEnabled: true, mcpCallerAttested: false, mcpCallerKind: 'unknown', vendorOptions: { orcaRole: 'lead' } });
    expect(fake.written.find(item => item.method === 'session/new')!.params.mcpServers).toEqual([
      { type: 'http', name: 'memory', url: 'http://127.0.0.1/mcp', headers: [{ name: 'Authorization', value: 'Bearer fake-test-token' }] },
    ]);
    await handle.send({ type: 'user', content: 'one' }); fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'two' }); fake.finish(); await tick();
    const prompts = fake.written.filter(item => item.method === 'session/prompt');
    expect(prompts[0].params.prompt[0].text).toBe('Remembered context\n\nUser preference');
    expect(prompts[1].params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    await handle.close();
  });
  it('rejects malformed prompt results instead of reporting successful completion', async () => {
    const { fake, start } = create(); const handle = await start(); const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'one' });
    const prompt = fake.written.find(item => item.method === 'session/prompt')!;
    fake.emit({ jsonrpc: '2.0', id: prompt.id, result: {} }); await tick();
    await handle.close(); await consume;
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ reason: 'cursor_invalid_prompt_result' });
  });
  it('returns method-not-found for unsupported client requests even while idle', async () => {
    const { fake, start } = create(); const handle = await start();
    fake.emit({ jsonrpc: '2.0', id: 'unknown', method: 'fs/write_text_file', params: {} }); await tick();
    expect(fake.written.find(item => item.id === 'unknown')!.error.code).toBe(-32601);
    await handle.close();
  });
  it.each(['default', 'auto', 'bypassPermissions'] as const)('does not auto-approve a pending plan when permission mode changes to %s', async mode => {
    const { fake, start } = create(); const handle = await start(); let answer: ((value: InteractionDecision) => void) | undefined;
    handle.setInteractionResolver(() => new Promise(resolve => { answer = resolve; }));
    await handle.send({ type: 'user', content: 'plan' });
    fake.emit({ jsonrpc: '2.0', id: 'plan', method: 'cursor/create_plan', params: { plan: 'Proposed changes' } }); await tick();
    await handle.setPermissionMode!(mode);
    expect(fake.written.some(item => item.id === 'plan')).toBe(false);
    answer!({ kind: 'plan_review', behavior: 'deny', reason: 'Revise' }); await tick();
    expect(fake.written.find(item => item.id === 'plan')!.result).toEqual({ outcome: { outcome: 'rejected', reason: 'Revise' } });
    await handle.close();
  });
  it('cancels in-flight native startup when the owning agent is disposed', async () => {
    const { fake, agent, start } = create(); fake.held.add('initialize');
    const starting = start(); const rejected = expect(starting).rejects.toThrow('aborted');
    await tick(); await agent.dispose(); await rejected;
    expect(fake.closeCount).toBeGreaterThan(0);
    expect(fake.written.some(item => item.method === 'session/new')).toBe(false);
  });
  it('keeps uncertain disconnected turns running until process exit can be confirmed', async () => {
    const dispose = vi.fn(); const { fake, start } = create(undefined, { preparePiExtraSpawnConfig: async () => ({ disposeSessionCtx: dispose }) });
    const handle = await start(); const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'work' }); fake.failClose = true;
    for (const listener of fake.closes) listener({ reason: 'lost transport' }); await tick();
    expect(handle.isTurnRunning!()).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ isTerminal: false, reason: 'cursor_cleanup_pending' });
    fake.failClose = false; await handle.abort(); await consume;
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('maps the standard authentication-required error to native login guidance', async () => {
    const { fake, start } = create(); fake.held.add('authenticate');
    fake.onWrite = message => { if (message.method === 'authenticate') fake.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } }); };
    await expect(start()).rejects.toMatchObject({ name: 'AgentNotAuthenticatedError', agentKind: 'cursor' });
    expect(fake.closeCount).toBe(1);
  });
  it.each([{ reviewMode: true }, { botRuntimeProfile: {} }])('rejects restricted startup profiles before creating a native process: %j', async options => {
    const { fake, start } = create();
    await expect(start(options)).rejects.toThrow('restricted Reviewer or Bot runtime profiles');
    expect(fake.written).toEqual([]);
  });
  it.each([{ extraDirs: ['/read-only'] }, { writableDirs: ['/write'] }, { [LIBRARY_READ_ROOT]: '/library' }])('rejects directory grant promises it cannot enforce: %j', async options => {
    const { fake, start } = create();
    await expect(start(options)).rejects.toThrow('additional directory grants');
    expect(fake.written).toEqual([]);
  });
  it('rejects unsupported remote and per-turn policy boundaries explicitly', async () => {
    const { start } = create();
    await expect(start({ remoteHostId: 'ssh' })).rejects.toThrow('only on the task host');
    const handle = await start();
    await expect(handle.send({ type: 'user', content: 'readonly' }, { turnPermissionPolicy: { forceConfirmToolCall: () => true, origin: { kind: 'desktop' }, confirmationSurface: 'desktop' } }))
      .rejects.toThrow('Turn permission policy');
    await expect(handle.send({ type: 'user', content: '/approved-skill' }, { [PINNED_SKILL_INVOCATION]: {} as never })).rejects.toThrow('pinned Skill');
    await expect(handle.send({ type: 'user', content: 'no tools' }, { toolsDisabled: true })).rejects.toThrow('tools-disabled');
    await handle.close();
  });
});

describe('Cursor model and event contracts', () => {
  it('preserves native grouping, descriptions and order while discovering only offered models', () => {
    const result = readCursorModels({ configOptions: [{ id: 'model', category: 'model', currentValue: 'default', options: [
      { value: 'default', name: 'Auto' },
      { name: 'Cursor Models', options: [{ value: 'grok-4.7', name: 'Grok 4.7', description: 'Native description' }] },
      { name: 'Other Models', options: [{ value: 'opaque-third-party', name: 'Native offer' }] },
      { name: 'Experimental', options: [{ value: 'future', name: 'Future model' }] },
    ] }] });
    expect(result.models.map(model => [model.id, model.group, model.sortOrder])).toEqual([
      ['default', 'cursor:auto', 0], ['grok-4.7', 'cursor:models', 1],
      ['opaque-third-party', 'cursor:other', 2], ['future', 'cursor:native:Experimental', 3],
    ]);
    expect(result.models[1].description).toBe('Native description');
    expect(result.models.some(model => model.id === CURSOR_DEFAULT_MODEL)).toBe(false);
  });
  it('includes renderable status text on turn start and context usage updates', async () => {
    const { fake, start } = create();
    const handle = await start();
    const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    await handle.send({ type: 'user', content: 'hello' });
    fake.update('usage_update', { used: 100, size: 200 });
    fake.finish();
    await tick();
    await handle.close();
    await consume;
    const statuses = events.filter(event => event.type === 'status').map(event => event.data);
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status).toMatchObject({ isRunning: true, status: expect.stringMatching(/\S/) });
    }
    expect(statuses[1]).toMatchObject({ contextTokens: 100, contextWindow: 200, tokenUsage: 0 });
  });

  it('merges todo patches across turns and replaces the snapshot only when merge is false', async () => {
    const { fake, start } = create();
    const handle = await start();
    const events: AgentEvent[] = [];
    const consume = (async () => { for await (const event of handle.events()) events.push(event); })();
    const todos = (items: unknown[], merge: boolean) => fake.emit({ jsonrpc: '2.0', method: 'cursor/update_todos', params: { todos: items, merge } });
    await handle.send({ type: 'user', content: 'plan' });
    todos([{ id: 'a', content: 'A', status: 'pending' }, { id: 'b', content: 'B', status: 'pending' }, { id: 'c', content: 'C', status: 'pending' }], false);
    fake.finish(); await tick();
    await handle.send({ type: 'user', content: 'continue' });
    todos([{ id: 'b', status: 'completed' }], true);
    todos([{ id: 'd', content: 'D', status: 'in_progress' }], true);
    todos([], true);
    todos([{ id: 'e', content: 'E', status: 'pending' }], false);
    todos([], false);
    await handle.close(); await consume;
    const plans = events.filter(event => event.type === 'tool_use').map(event => event.data);
    expect(plans[1]).toMatchObject({ input: { plan: [
      { step: 'A', status: 'pending' }, { step: 'B', status: 'completed' }, { step: 'C', status: 'pending' },
    ] } });
    expect(plans[2]).toMatchObject({ input: { plan: [{ step: 'A' }, { step: 'B' }, { step: 'C' }, { step: 'D' }] } });
    expect(plans[3]).toEqual(plans[2]);
    expect(plans[4]).toMatchObject({ input: { plan: [{ step: 'E', status: 'pending' }] } });
    expect(plans[5]).toMatchObject({ input: { plan: [] } });
  });
  it('does not invent a model catalog or context size', () => {
    expect(readCursorModels({}).models).toEqual([]);
    const catalog = readCursorModels({ configOptions: [{ id: 'x', category: 'model', currentValue: 'runtime',
      options: [{ group: 'vendor', options: [{ value: 'runtime', name: 'Actual' }] }] }] });
    expect(catalog.models[0]).toMatchObject({ id: 'runtime', contextWindow: 0, newSessionDefault: ['cursor'] });
  });
  it('merges partial tool events without losing name/input and emits one terminal result', () => {
    const events: AgentEvent[] = []; const translator = new CursorTranslator(event => events.push(event));
    translator.update({ sessionUpdate: 'tool_call', toolCallId: '1', title: 'read', kind: 'read', rawInput: { path: 'a' } });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'contents' } }] });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed' });
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool_result_full')?.data).toEqual({ toolUseId: '1', fullText: 'contents', isError: false });
    expect(events.filter(event => event.type === 'tool_result_full')).toHaveLength(1);
  });
  it('maps desktop/mobile JSON multi-select including commas to opaque option IDs', () => {
    expect(cursorAnswers([{ id: 'q', prompt: 'Pick', allowMultiple: true, options: [
      { id: 'a', label: 'Alpha, one' }, { id: 'b', label: 'Beta' },
    ] }], { Pick: '["Alpha, one","Beta"]' })).toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['a', 'b'] }] } });
  });
  it('does not fabricate an answer for free text or duplicate option labels', () => {
    const question = { id: 'q', prompt: 'Pick', options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }] };
    expect(cursorAnswers([question], { Pick: 'Same' })).toMatchObject({ outcome: { outcome: 'skipped' } });
    expect(cursorAnswers([question], { Pick: 'Custom' })).toMatchObject({ outcome: { outcome: 'skipped' } });
  });
});
