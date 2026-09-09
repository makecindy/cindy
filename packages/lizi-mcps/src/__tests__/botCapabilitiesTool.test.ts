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
    await registry.call('find_bot_capabilities', { kind: 'mcp', query: 'docs' });
    expect(callbacks.list).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', query: 'docs' });
    const result = await registry.call('set_bot_capability', { kind: 'mcp', id: 'docs', joined: true });
    expect(callbacks.select).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', id: 'docs', joined: true });
    expect(result.content[0]).toMatchObject({ text: JSON.stringify({ ok: true, effective: 'next-turn', joined: true }) });
  });

  it('rejects attempts to select capabilities for another caller', async () => {
    const { registry, callbacks } = fixture();
    const result = await registry.call('set_bot_capability', { kind: 'skill', id: 'release', joined: true, callerSessionId: 'another-bot' });
    expect(result.isError).toBe(true);
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it('does not call the host without a bound session', async () => {
    const { registry, callbacks } = fixture('');
    expect((await registry.call('find_bot_capabilities', { kind: 'skill' })).isError).toBe(true);
    expect((await registry.call('set_bot_capability', { kind: 'skill', id: 'release', joined: false })).isError).toBe(true);
    expect(callbacks.list).not.toHaveBeenCalled();
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it('keeps plugin discovery in the default find_bot_capabilities description', () => {
    const description = buildFindBotCapabilitiesDescription();
    expect(description).toContain('ghost_list');
    expect(description).toContain('ghost_info');
    expect(buildFindBotCapabilitiesDescription(true)).toBe(description);
    const { registry } = fixture();
    expect(registry.list('bots').find((tool) => tool.name === 'find_bot_capabilities')?.description).toBe(description);
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
    expect(registry.list('bots').find((tool) => tool.name === 'find_bot_capabilities')?.description).toBe(description);
    expect(registry.list('bots').find((tool) => tool.name === 'set_bot_capability')?.description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
  });

  it('rewrites only find_bot_capabilities at list time', () => {
    const tools = [
      { name: 'find_bot_capabilities', description: buildFindBotCapabilitiesDescription() },
      { name: 'set_bot_capability', description: 'join or leave' },
    ];
    expect(withCindyGatedBotToolDescriptions(tools, true)).toEqual(tools);
    const remote = withCindyGatedBotToolDescriptions(tools, false);
    expect(remote[0]?.description).toBe(buildFindBotCapabilitiesDescription(false));
    expect(remote[0]?.description).not.toMatch(/ghost_list|ghost_info|ghost_call/);
    expect(remote[1]?.description).toBe('join or leave');
  });
});
