import { describe, expect, it, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import {
  buildFindBotCapabilitiesDescription,
  registerBotCapabilityTools,
  withCindyGatedBotToolDescriptions,
} from '../xdt-helper/bot_capabilities.js';

function fixture(sessionId: string | undefined = 'current-bot') {
  const registry = new XdtHelperToolRegistry();
  const callbacks = {
    list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
    select: vi.fn(async () => ({ ok: true as const, effective: 'next-turn' as const, joined: true })),
  };
  registerBotCapabilityTools(registry, {
    getSessionContext: () => ({ sessionId, agentKind: 'pi', workingDir: '/w' }),
    callbacks,
  });
  return { registry, callbacks };
}

describe('Bot capability tools', () => {
  it('binds discovery and selection to the host caller and reports next-turn activation', async () => {
    const { registry, callbacks } = fixture();
    await registry.call('find_teammate_capabilities', { kind: 'mcp', query: 'docs' });
    expect(callbacks.list).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', query: 'docs' });
    const result = await registry.call('set_teammate_capability', { kind: 'mcp', id: 'docs', joined: true });
    expect(callbacks.select).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', id: 'docs', joined: true });
    expect(result.content[0]).toMatchObject({ text: JSON.stringify({ ok: true, effective: 'next-turn', joined: true }) });
  });

  it('rejects attempts to select capabilities for another caller', async () => {
    const { registry, callbacks } = fixture();
    const result = await registry.call('set_teammate_capability', { kind: 'skill', id: 'release', joined: true, callerSessionId: 'another-bot' });
    expect(result.isError).toBe(true);
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it('does not call the host without a bound session', async () => {
    const { registry, callbacks } = fixture('');
    expect((await registry.call('find_teammate_capabilities', { kind: 'skill' })).isError).toBe(true);
    expect((await registry.call('set_teammate_capability', { kind: 'skill', id: 'release', joined: false })).isError).toBe(true);
    expect(callbacks.list).not.toHaveBeenCalled();
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it('keeps plugin discovery in the default find_teammate_capabilities description', () => {
    const description = buildFindBotCapabilitiesDescription();
    expect(description).toContain('ghost_list');
    expect(description).toContain('ghost_info');
    expect(buildFindBotCapabilitiesDescription(true)).toBe(description);
    const { registry } = fixture();
    expect(registry.list('bots').find((tool) => tool.name === 'find_teammate_capabilities')?.description).toBe(description);
  });

  it('omits ghost tools when cindy is unavailable', () => {
    const description = buildFindBotCapabilitiesDescription(false);
    expect(description).toContain('Skill');
    expect(description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
    const registry = new XdtHelperToolRegistry();
    registerBotCapabilityTools(registry, {
      getSessionContext: () => ({ sessionId: 'current-bot', agentKind: 'codex', workingDir: '/w' }),
      callbacks: {
        list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
        select: vi.fn(async () => ({ ok: true as const, effective: 'next-turn' as const, joined: true })),
      },
      cindyAvailable: false,
    });
    expect(registry.list('bots').find((tool) => tool.name === 'find_teammate_capabilities')?.description).toBe(description);
    expect(registry.list('bots').find((tool) => tool.name === 'set_teammate_capability')?.description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
  });

  it('rewrites only find_teammate_capabilities at list time', () => {
    const tools = [
      { name: 'find_teammate_capabilities', description: buildFindBotCapabilitiesDescription() },
      { name: 'set_teammate_capability', description: 'join or leave' },
    ];
    expect(withCindyGatedBotToolDescriptions(tools, true)).toEqual(tools);
    const remote = withCindyGatedBotToolDescriptions(tools, false);
    expect(remote[0]?.description).toBe(buildFindBotCapabilitiesDescription(false));
    expect(remote[0]?.description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
    expect(remote[1]?.description).toBe('join or leave');
  });
});

describe('Bot self control', () => {
  it('binds profile updates to the current caller, validates patches, and preserves version conflicts', async () => {
    const registry = new XdtHelperToolRegistry();
    const updateProfile = vi.fn(async () => ({ ok: false as const, errorCode: 'BOT_PROFILE_UPDATE_FAILED', message: 'changed' }));
    registerBotCapabilityTools(registry, {
      getSessionContext: () => ({ sessionId: 'self', agentKind: 'pi', workingDir: '/w' }),
      callbacks: { ...fixture().callbacks, updateProfile },
    });
    expect((await registry.call('update_teammate_profile', { expectedVersion: 2, name: 'New name', botId: 'other' })).isError).toBe(true);
    expect((await registry.call('update_teammate_profile', { expectedVersion: 2, model: 'disabled' })).isError).toBe(true);
    expect((await registry.call('update_teammate_profile', { expectedVersion: 2 })).isError).toBe(true);
    expect(updateProfile).not.toHaveBeenCalled();
    const result = await registry.call('update_teammate_profile', { expectedVersion: 2, description: '' });
    expect(updateProfile).toHaveBeenCalledWith({ callerSessionId: 'self', expectedVersion: 2, description: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('BOT_PROFILE_UPDATE_FAILED') });
  });
});

it('advertises teammate names while accepting saved legacy helper calls', async () => {
  const { registry, callbacks } = fixture();
  expect(registry.list('bots').map(item => item.name)).toContain('find_teammate_capabilities');
  expect(registry.list('bots').map(item => item.name)).not.toContain('find_bot_capabilities');
  await registry.call('find_bot_capabilities', { kind: 'skill' });
  expect(callbacks.list).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'skill' });
});

it('exposes app default model operations with bound callers and propagates unconfirmed writes', async () => {
  const registry = new XdtHelperToolRegistry();
  const models = vi.fn(async () => ({ ok: true as const, current: null, available: [] }));
  const setDefaultModel = vi.fn(async () => ({ ok: false as const, errorCode: 'MODEL_DEFAULT_NOT_CONFIRMED', message: 'not saved' }));
  const ordinary = fixture().callbacks;
  registerBotCapabilityTools(registry, { getSessionContext: () => ({ sessionId: 'current-bot', agentKind: 'codex', workingDir: '/w' }),
    callbacks: { ...ordinary, models, setDefaultModel } });
  await registry.call('get_app_default_model', {});
  expect(models).toHaveBeenCalledWith({ callerSessionId: 'current-bot' });
  expect((await registry.call('set_app_default_model', { id: 'selected', callerSessionId: 'other' })).isError).toBe(true);
  expect(setDefaultModel).not.toHaveBeenCalled();
  expect((await registry.call('set_app_default_model', { id: 'selected', effort: 'medium' })).isError).toBe(true);
  expect(setDefaultModel).toHaveBeenCalledWith({ callerSessionId: 'current-bot', id: 'selected', effort: 'medium' });
});


it('accepts scoped model chains and reset through the existing profile tool without accepting foreign targets', async () => {
  const registry = new XdtHelperToolRegistry();
  const updateProfile = vi.fn(async () => ({ ok: true as const, effective: 'next-turn' as const }));
  registerBotCapabilityTools(registry, {
    getSessionContext: () => ({ sessionId: 'self', agentKind: 'codex', workingDir: '/w' }),
    callbacks: { ...fixture().callbacks, updateProfile },
  });
  const modelChain = [{ id: 'enabled-route', effort: 'low', fastMode: false }];
  for (const bad of [{ modelChain: [] }, { modelChain, botId: 'other' }, { modelChain, session_id: 'other' },
    { modelChain: [{ id: 'enabled-route', providerId: 'invented' }] }]) {
    expect((await registry.call('update_teammate_profile', { expectedVersion: 2, ...bad })).isError).toBe(true);
  }
  expect(updateProfile).not.toHaveBeenCalled();
  expect((await registry.call('update_teammate_profile', { expectedVersion: 2, modelChain })).isError).not.toBe(true);
  expect(updateProfile).toHaveBeenLastCalledWith({ callerSessionId: 'self', expectedVersion: 2, modelChain });
  expect((await registry.call('update_teammate_profile', { expectedVersion: 3, modelChain: null })).isError).not.toBe(true);
  expect(updateProfile).toHaveBeenLastCalledWith({ callerSessionId: 'self', expectedVersion: 3, modelChain: null });
});
