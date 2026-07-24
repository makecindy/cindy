import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { assessGhostHostSetupRequirements } from '../ghostHostSetupRequirements';

function manifest(id: string, cindy = false): GhostManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    version: '1',
    kind: 'chip',
    entry: 'main.js',
    slots: cindy ? ['tool', 'cindy'] : ['tool'],
    tools: [{ name: 'run', description: 'run' }],
    ...(cindy ? { cindy: { image: ['generate' as const] } } : {}),
  };
}

describe('assessGhostHostSetupRequirements', () => {
  it('maps any declared Host media capability to a generic client_config action', () => {
    const groups = assessGhostHostSetupRequirements(manifest('media-plugin', true), {
      clientConfigReady: () => false,
    });
    expect(groups).toEqual([
      {
        id: 'host:client_config:model-provider',
        mode: 'any_of',
        items: [
          {
            ref: 'client_config:model-provider',
            kind: 'client_config',
            label: 'AI 模型服务',
            description: '使用插件声明的图片或视频能力前，需要先连接可用的模型服务',
            state: 'missing',
            actions: [
              {
                id: 'open_client_settings:client_config:model-provider',
                kind: 'open_client_settings',
              },
            ],
          },
        ],
      },
    ]);
  });

  it('reports ready without an executable action when the owning subsystem is ready', () => {
    const groups = assessGhostHostSetupRequirements(manifest('another-media-plugin', true), {
      clientConfigReady: (configId) => configId === 'model-provider',
    });
    expect(groups[0].items[0]).toMatchObject({ state: 'satisfied', actions: [] });
  });

  it('does not impose Host configuration on plugins without the declared capability', () => {
    expect(
      assessGhostHostSetupRequirements(manifest('gmail'), {
        clientConfigReady: () => false,
      }),
    ).toEqual([]);
  });
});
