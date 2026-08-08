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
  it('documents route metadata as optional for older hosts', () => {
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, {
      listAvailableModels: async () => ({ ok: true }),
    });

    expect(registry.get('list_available_models')?.description).toContain(
      '旧 host 可能不返回此字段',
    );
  });

  it('preserves the aggregate list and exposes distinct provider routes', async () => {
    const listAvailableModels = vi.fn(async () => ({
      ok: true as const,
      codex: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
      routes: {
        codex: [
          {
            modelId: 'gpt-5.5',
            label: 'GPT-5.5',
            providerId: 'xd',
            providerName: 'Cindy AI',
            isDefault: true,
          },
          {
            modelId: 'gpt-5.5',
            label: 'GPT-5.5',
            providerId: 'openai',
            providerName: 'OpenAI',
            isDefault: false,
          },
        ],
      },
    }));
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, { listAvailableModels });

    const result = parse(await registry.call('list_available_models', { agent: 'codex' }));

    expect(listAvailableModels).toHaveBeenCalledWith({ agent: 'codex' });
    expect(result.codex).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5', tier: 'standard' }]);
    expect(result.routes.codex).toEqual([
      {
        model_id: 'gpt-5.5',
        label: 'GPT-5.5',
        tier: 'standard',
        provider_id: 'xd',
        provider_name: 'Cindy AI',
        is_default: true,
      },
      {
        model_id: 'gpt-5.5',
        label: 'GPT-5.5',
        tier: 'standard',
        provider_id: 'openai',
        provider_name: 'OpenAI',
        is_default: false,
      },
    ]);
  });

  it('keeps compatibility with hosts that do not return route metadata', async () => {
    const registry = new XdtHelperToolRegistry();
    registerListAvailableModelsTool(registry, {
      listAvailableModels: async () => ({
        ok: true,
        pi: [{ id: 'pi-model', label: 'Pi Model' }],
      }),
    });

    expect(parse(await registry.call('list_available_models', { agent: 'pi' }))).toEqual({
      ok: true,
      pi: [{ id: 'pi-model', label: 'Pi Model', tier: 'standard' }],
    });
  });
});
