/** Native control receipts: model-specific thinking, resume, mode and context.
 * No credentials, subprocesses or model generation; the peer uses observed 1.5.9 shapes. */
import { describe, expect, it } from 'vitest';
import { AntigravityAgent } from './antigravity-agent.js';
import { isAntigravitySubscriptionModel } from './model-policy.js';
import { AcpSubscriptionSession } from './subscription-session.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AcpRecord, AcpTransport } from './client.js';

function peer(withPartnerModels = false) {
  const levels: Record<string, string[]> = {
    'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
    'gemini-3.8-flash': ['low', 'medium', 'high'],
    'gemini-pro-orchestrator-g1-pro': [],
    ...(withPartnerModels ? {
      'claude-opus-5-5': ['low', 'medium', 'high'],
      'claude-sonnet-5-5': ['low', 'medium', 'high'],
      'gpt-oss-120b-medium': [],
      'unapproved-native-model': ['low', 'medium', 'high'],
    } : {}),
  };
  let model = 'gemini-4-hydrogen'; let thought = 'medium'; let mode = 'default';
  let failThought = false;
  const calls: AcpRecord[] = [];
  const receivers = new Set<(line: string) => void>();
  const notify = (update: AcpRecord, sessionId = 'controls-native') => {
    for (const receive of receivers) receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }));
  };
  const configOptions = () => [
    { id: 'model', category: 'model', type: 'select', currentValue: model, options: Object.keys(levels).map(value => ({ value, name: value })) },
    ...(levels[model].length ? [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: thought, options: levels[model].map(value => ({ value, name: value === 'xhigh' ? 'Extra' : value })) }] : []),
    { id: 'mode', category: 'mode', type: 'select', currentValue: mode, options: ['default', 'auto', 'accept-edits', 'plan'].map(value => ({ value, name: value })) },
  ];
  const transport: AcpTransport = {
    onLine: receive => { receivers.add(receive); return () => { receivers.delete(receive); }; }, onClose: () => () => {}, close: async () => {},
    write(line) {
      const req = JSON.parse(line); calls.push(req);
      if (req.id === undefined) return;
      const p = req.params ?? {};
      let result: AcpRecord = {}; let rejected = false;
      if (req.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server' }, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'oauth-personal' }] };
      if (['session/new', 'session/load'].includes(req.method)) {
        if (req.method === 'session/load') { model = 'gemini-4-hydrogen'; thought = 'medium'; mode = 'default'; }
        result = { sessionId: 'controls-native', configOptions: configOptions(), models: { availableModels: Object.entries(levels).flatMap(([base, values]) => values.map(value => ({ modelId: `${base}-${value}`, name: `${base} ${value}` }))) }, _meta: { antigravity: { tier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } } };
        notify({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'historical text must not be replayed' } });
      }
      if (req.method === 'session/set_config_option') {
        if (p.configId === 'model' && levels[p.value]) { model = p.value; if (!levels[model].includes(thought)) thought = levels[model][0] ?? ''; }
        else if (p.configId === 'thought_level' && levels[model].includes(p.value) && !failThought) thought = p.value;
        else { rejected = true; failThought = false; }
        if (!rejected) { result = { configOptions: configOptions() }; notify({ sessionUpdate: 'config_option_update', ...result }); }
      }
      if (req.method === 'session/set_mode') { mode = p.modeId; notify({ sessionUpdate: 'current_mode_update', currentModeId: mode }); }
      if (req.method === 'session/prompt') result = { stopReason: 'end_turn', usage: { totalTokens: 1234 } };
      queueMicrotask(() => {
        for (const receive of receivers) receive(JSON.stringify({ jsonrpc: '2.0', id: req.id,
          ...(rejected ? { error: { code: -32602, message: 'not forwarded' } } : { result }) }));
      });
    },
  };
  const connection = { transport, assertSubscriptionOnly: async () => {} };
  const updates: AcpRecord[] = [];
  const session = new AcpSubscriptionSession({ ...connection, cwd: '/workspace', onUpdate: update => updates.push(update), requestPermission: async () => false });
  const agent = new AntigravityAgent({ binaryPath: '/official/agy', runtimeConfig: {}, logger: createConsoleLogger('test'), auth: {
    getState: async () => ({ authenticated: false }), triggerLogin: async () => ({ authenticated: false }), logout: async () => {}, getAuthEnv: async () => ({}),
  } }, { connect: async () => connection, modelsChanged() {}, assertGenerationAllowed: async () => {} });
  return { session, agent, calls, updates, notify, native: () => ({ model, thought, mode }), failNextThought: () => { failThought = true; } };
}

describe('Antigravity native controls', () => {
  it('discovers partner defaults from native controls without prompting or changing the original selection', async () => {
    const h = peer(true); await h.session.initialize(); await h.session.open({ cachedAuthentication: true });
    await h.session.discoverModelOptions();
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(h.session.models.find(model => model.id === id)).toMatchObject({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' });
    }
    expect(h.session.models.find(model => model.id === 'gpt-oss-120b-medium')).toMatchObject({ efforts: [], defaultEffort: null });
    expect(h.native()).toEqual({ model: 'gemini-4-hydrogen', thought: 'medium', mode: 'default' });
    expect(h.calls.some(call => (call.params as AcpRecord | undefined)?.value === 'unapproved-native-model')).toBe(false);
    expect(h.calls.some(call => call.method === 'session/prompt')).toBe(false); await h.session.close();
  });
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5'])('keeps %s on Google subscription through load, effort, permission reconnect and send', async model => {
    const h = peer(true); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model, effort: 'high', permissionMode: 'bypassPermissions', resumeSessionId: 'controls-native' });
    expect(h.agent.capabilities.availableModels.some(row => row.id === model)).toBe(true);
    expect(h.agent.capabilities.availableModels.some(row => row.id === 'unapproved-native-model')).toBe(false);
    expect(h.calls.some(call => call.method === 'session/load')).toBe(true);
    expect(h.native()).toEqual({ model, thought: 'high', mode: 'default' });
    await handle.setPermissionMode!('auto');
    expect(h.native()).toEqual({ model, thought: 'high', mode: 'auto' });
    await handle.send({ type: 'user', content: 'mock subscription turn' });
    for await (const event of handle.events()) { if (event.type === 'done') break; }
    expect(h.calls.filter(call => call.method === 'session/prompt')).toHaveLength(1);
    expect(handle.model).toBe(model); await handle.close();
  });
  it('preserves GPT-OSS Medium as a fixed native model and rejects invented effort without a wire request', async () => {
    const h = peer(true); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'gpt-oss-120b-medium', permissionMode: 'auto' });
    expect(handle.model).toBe('gpt-oss-120b-medium');
    const before = h.calls.length;
    await expect(handle.setEffort!('high')).rejects.toThrow();
    expect(h.calls.length).toBe(before);
    await handle.setPermissionMode!('bypassPermissions');
    expect(h.native()).toMatchObject({ model: 'gpt-oss-120b-medium', mode: 'default' });
    expect(h.calls.some(call => call.method === 'session/load')).toBe(true); await handle.close();
  });
  it('does not broaden the subscription route to arbitrary models or a different provider', async () => {
    expect(isAntigravitySubscriptionModel('claude-opus-5-5')).toBe(true);
    expect(isAntigravitySubscriptionModel('gpt-oss-120b-medium')).toBe(true);
    for (const id of ['claude-opus-4-6', 'gpt-6.1-sol', 'https://api.example/model', 'unapproved-native-model']) expect(isAntigravitySubscriptionModel(id)).toBe(false);
    const h = peer(true); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'unapproved-native-model' });
    await expect(handle.send({ type: 'user', content: 'must not reach upstream' })).rejects.toThrow('ANTIGRAVITY_SUBSCRIPTION_MODEL_REQUIRED');
    expect(h.calls.some(call => call.method === 'session/prompt')).toBe(false); await handle.close();
    await expect(h.agent.startSession({ providerId: 'anthropic', workingDir: '/workspace', model: 'claude-opus-5-5' })).rejects.toThrow('ANTIGRAVITY_LOCAL_SESSION_ONLY');
  });
  it('reads defaults from each native picker without changing the account selection or inventing Fast', async () => {
    const h = peer(); await h.session.initialize(); await h.session.open({ cachedAuthentication: true });
    await h.session.discoverModelOptions();
    expect(h.session.models.find(model => model.id === 'gemini-3.8-flash')?.defaultEffort).toBe('medium');
    expect(h.native()).toEqual({ model: 'gemini-4-hydrogen', thought: 'medium', mode: 'default' });
    await h.session.close();
    await expect(h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'gemini-4-hydrogen', fastMode: true })).rejects.toThrow('ANTIGRAVITY_FAST_MODE_UNSUPPORTED');
    expect(h.calls.some(call => call.method === 'session/prompt')).toBe(false);
  });
  it('admits only native per-model tiers, including fixed Orchestrator, and consumes complete replies', async () => {
    const h = peer(); await h.session.initialize(); await h.session.open({ cachedAuthentication: true });
    expect(h.session.models.map(model => [model.id, model.efforts])).toEqual([
      ['gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']], ['gemini-3.8-flash', ['low', 'medium', 'high']], ['gemini-pro-orchestrator-g1-pro', []],
    ]);
    await h.session.setEffort('xhigh'); expect(h.session.currentEffort).toBe('xhigh');
    await h.session.setModel('gemini-3.8-flash');
    const before = h.calls.length;
    await expect(h.session.setEffort('xhigh')).rejects.toThrow(); expect(h.calls.length).toBe(before);
    await h.session.setModel('gemini-pro-orchestrator-g1-pro'); expect(h.session.currentEffort).toBeUndefined();
    await expect(h.session.setEffort('medium')).rejects.toThrow();
    expect(h.calls.some(call => call.method === 'session/prompt')).toBe(false); await h.session.close();
  });
  it('retains context arriving before new/load response, never replays historic text, and fences other sessions', async () => {
    const h = peer(); await h.session.initialize(); await h.session.open({ cachedAuthentication: true, resumeId: 'controls-native' });
    expect(h.updates).toContainEqual({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
    expect(h.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(false);
    const before = h.updates.length; h.notify({ sessionUpdate: 'usage_update', used: 999, size: 1234 }, 'someone-else');
    expect(h.updates.length).toBe(before); await h.session.close();
  });
  it('does not accept a failed native effort change optimistically', async () => {
    const h = peer(); await h.session.initialize(); await h.session.open({ cachedAuthentication: true });
    h.failNextThought(); await expect(h.session.setEffort('high')).rejects.toThrow();
    expect(h.session.currentEffort).toBe('medium'); expect(h.native().thought).toBe('medium'); await h.session.close();
  });
  it('applies startup and runtime effort, preserves it through permission reconnect and plan changes', async () => {
    const h = peer(); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'gemini-4-hydrogen', effort: 'high', permissionMode: 'auto' });
    expect(h.agent.capabilities.effort.supported).toBe(true); expect(h.native()).toEqual({ model: 'gemini-4-hydrogen', thought: 'high', mode: 'auto' });
    await handle.setEffort!('xhigh'); await handle.setPermissionMode!('bypassPermissions');
    expect(h.native().thought).toBe('xhigh'); await handle.setPlanMode!(true);
    expect(h.native()).toEqual({ model: 'gemini-4-hydrogen', thought: 'xhigh', mode: 'plan' });
    await handle.setPlanMode!(false); expect(h.native().mode).toBe('default');
    expect(h.calls.some(call => call.method === 'session/prompt')).toBe(false); await handle.close();
  });
  it('rolls back a partially accepted model/effort change without changing provider or permission', async () => {
    const h = peer(); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'gemini-4-hydrogen', effort: 'xhigh', permissionMode: 'auto' });
    h.failNextThought(); await expect(handle.setModel!('gemini-3.8-flash', { effort: 'high' })).rejects.toThrow();
    expect(h.native()).toEqual({ model: 'gemini-4-hydrogen', thought: 'xhigh', mode: 'auto' });
    expect(handle.model).toBe('gemini-4-hydrogen'); await handle.close();
  });
  it('keeps context fill separate from prompt totals and never marks a usage event as turn completion', async () => {
    const h = peer(); await h.session.close();
    const handle = await h.agent.startSession({ providerId: 'google-antigravity-subscription', workingDir: '/workspace', model: 'gemini-4-hydrogen' });
    h.notify({ sessionUpdate: 'usage_update', used: 350, size: 1048576 });
    await handle.send({ type: 'user', content: 'mock only' });
    const events = [];
    for await (const event of handle.events()) { events.push(event); if (event.type === 'done') break; }
    expect(events.filter(event => event.type === 'status').every(event => event.turnScope === 'background')).toBe(true);
    expect(handle.getUsageSnapshot()).toMatchObject({ contextTokens: 350, contextWindow: 1048576, tokenUsage: 1234 });
    await handle.close();
  });
});
