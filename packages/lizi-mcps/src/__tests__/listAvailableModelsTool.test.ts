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
  // Unit: choosing a remote Worker must discover from its work host rather
  // than the Lead's model computer; unsupported peers retain their error code.
  it.each([['execution_device_id', 'agent_device_id'], ['device', 'provider_device_id']])('forwards locations via %s/%s and preserves version errors', async (workKey, modelKey) => {
    const listAvailableModels = vi.fn(async () => ({ ok: false as const,
      errorCode: 'UNSUPPORTED_CAPABILITY', message: 'update work host' }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, {
      getSessionContext: () => ({ sessionId: 'lead-1' }), listAvailableModels,
    });
    const result = parse(await registry.call('list_available_models', {
      [workKey]: 'worker-pc', [modelKey]: 'model-pc', agent: 'codex',
    }));
    expect(listAvailableModels).toHaveBeenCalledWith({ callerSessionId: 'lead-1',
      executionDeviceId: 'worker-pc', agentDeviceId: 'model-pc', agent: 'codex' });
    expect(result).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
  });
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

  // #11865, unit: registry.call must expose each route's membership evidence.
  // Existing provider tests cover old hosts but lose modelDetails entirely. The
  // minimal regression is one Pi model offered by two accounts with different evidence.
  it('preserves per-provider Pi membership evidence without exposing other host metadata', async () => {
    const listAvailableModels = vi.fn(async () => ({
      ok: true as const,
      agentDeviceId: 'model-pc',
      pi: [{
        id: 'chatgpt/gpt-5.4-mini', label: 'GPT-5.4 Mini', defaultProviderId: 'account-a',
        providers: [
          { id: 'account-a', name: 'Account A', modelDetails: {
            membershipSource: 'public-catalog' as const,
            route: { baseUrl: 'https://private.invalid' },
          } },
          { id: 'account-b', name: 'Account B', modelDetails: { membershipSource: 'account-catalog' as const } },
          { id: 'manual', name: 'Manual', modelDetails: { membershipSource: 'user-configured' as const } },
          { id: 'legacy', name: 'Legacy' },
          // Simulate a newer or malformed host without claiming its unknown value is evidence.
          { id: 'unknown', name: 'Unknown', modelDetails: { membershipSource: 'future-value' as 'public-catalog' } },
        ],
      }, {
        id: 'chatgpt/gpt-6.2-sol', label: 'GPT-6.2 Sol', defaultProviderId: 'account-a',
        providers: [{ id: 'account-a', name: 'Account A', modelDetails: { membershipSource: 'account-catalog' as const } }],
      }, {
        id: 'chatgpt/hidden-manual', label: 'Manual model', defaultProviderId: 'account-a',
        providers: [{ id: 'account-a', name: 'Account A', modelDetails: { membershipSource: 'user-configured' as const } }],
      }],
    }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { listAvailableModels });

    const result = parse(await registry.call('list_available_models', { agent: 'pi', provider_device_id: 'model-pc' }));

    expect(result.provider_device_id).toBe('model-pc');
    expect(result.pi).toEqual([{
      id: 'chatgpt/gpt-5.4-mini', label: 'GPT-5.4 Mini', tier: 'standard', default_provider_id: 'account-a',
      providers: [
        { provider_id: 'account-a', provider_name: 'Account A', membership_source: 'public-catalog' },
        { provider_id: 'account-b', provider_name: 'Account B', membership_source: 'account-catalog' },
        { provider_id: 'manual', provider_name: 'Manual', membership_source: 'user-configured' },
        { provider_id: 'legacy', provider_name: 'Legacy' },
        { provider_id: 'unknown', provider_name: 'Unknown' },
      ],
    }, {
      id: 'chatgpt/gpt-6.2-sol', label: 'GPT-6.2 Sol', tier: 'standard', default_provider_id: 'account-a',
      providers: [{ provider_id: 'account-a', provider_name: 'Account A', membership_source: 'account-catalog' }],
    }, {
      id: 'chatgpt/hidden-manual', label: 'Manual model', tier: 'standard', default_provider_id: 'account-a',
      providers: [{ provider_id: 'account-a', provider_name: 'Account A', membership_source: 'user-configured' }],
    }]);
    expect(JSON.stringify(result)).not.toContain('private.invalid');
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
      { provider_device_id: 'device-b', agent_device_id: 'device-b', name: 'Mac mini' },
      { provider_device_id: 'share:s1', agent_device_id: 'share:s1', name: 'Claude · Alex' },
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
