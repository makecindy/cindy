import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerListAvailableModelsTool } from '../xdt-helper/list_available_models.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

describe('list_available_models tool', () => {
  it('returns provider-aware routes without removing the existing model fields', async () => {
    const listAvailableModels = vi.fn(async () => ({
      ok: true as const,
      codex: [{
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        providers: [{ id: 'xd', name: 'XD Gateway' }],
        defaultProviderId: 'xd',
      }],
    }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { listAvailableModels });

    const result = parse(await registry.call('list_available_models', { agent: 'codex' }));

    expect(result.codex).toEqual([{
      id: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      tier: 'standard',
      providers: [{ provider_id: 'xd', provider_name: 'XD Gateway' }],
      default_provider_id: 'xd',
    }]);
    // 没有调用方任务时参数与原来完全一致。
    expect(listAvailableModels).toHaveBeenCalledWith({ agent: 'codex' });
  });

  it('passes the calling task so a task whose agent runs on another computer lists that computer', async () => {
    const listAvailableModels = vi.fn(async () => ({ ok: true as const, codex: [] }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, {
      getSessionContext: () => ({ sessionId: 'lead-1' }),
      listAvailableModels,
    });

    await registry.call('list_available_models', { agent: 'codex' });

    expect(listAvailableModels).toHaveBeenCalledWith({ agent: 'codex', callerSessionId: 'lead-1' });
  });

  it('omits the caller when the MCP context has no task', async () => {
    const listAvailableModels = vi.fn(async () => ({ ok: true as const }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { getSessionContext: () => ({}), listAvailableModels });

    await registry.call('list_available_models', {});

    expect(listAvailableModels).toHaveBeenCalledWith({ agent: undefined });
  });

  it('lists another Worker Agent location and reports where it listed and what else is available', async () => {
    const listAvailableModels = vi.fn(async () => ({
      ok: true as const,
      agentDeviceId: null,
      locations: [{ agentDeviceId: 'device-b', name: 'Mac mini' }, { agentDeviceId: 'share:s1', name: 'Claude · Alex' }],
      codex: [],
    }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { listAvailableModels });

    const result = parse(await registry.call('list_available_models', { agent: 'codex', agent_device_id: 'local' }));

    // "local" = 任务所在电脑(host 侧 null)。
    expect(listAvailableModels).toHaveBeenCalledWith({ agent: 'codex', agentDeviceId: null });
    expect(result.agent_device_id).toBe('local');
    expect(result.locations).toEqual([
      { agent_device_id: 'device-b', name: 'Mac mini' },
      { agent_device_id: 'share:s1', name: 'Claude · Alex' },
    ]);

    await registry.call('list_available_models', { agent_device_id: 'device-b' });
    expect(listAvailableModels).toHaveBeenLastCalledWith({ agent: undefined, agentDeviceId: 'device-b' });
  });

  it('keeps the reason when that computer or share cannot be read', async () => {
    const listAvailableModels = vi.fn(async () => ({
      ok: false as const, errorCode: 'REMOTE_AGENT_SHARE_PAUSED', message: 'paused',
    }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { listAvailableModels });

    const result = parse(await registry.call('list_available_models', { agent_device_id: 'share:s1' }));

    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_AGENT_SHARE_PAUSED' });
  });
});
