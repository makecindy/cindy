/**
 * 本地 ChatInput 切换来源时的 effort 能力必须按 `(provider, agent, model)` 解析。
 * picker 的模型清单是跨来源 first-wins；同 id 的内置 Pi 与 BYOM 能力不同时，不能把
 * 内置档位误当成 BYOM 可发送档位。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveProviderSwitchEffort,
  type Effort,
  type ProviderView,
} from '@cindy/model-providers';

import { resolveProviderModelEfforts } from '@/lib/providerModels';

function piProvider(params: {
  id: string;
  source: 'builtin' | 'user';
  efforts: Effort[];
  defaultEffort: Effort | null;
}): ProviderView {
  const { id, source, efforts, defaultEffort } = params;
  return {
    id,
    name: id,
    source,
    connected: true,
    agents: ['pi'],
    auth: { method: 'apiKey' },
    routing: { pi: { upstream: `https://${id}.example`, authStrategy: 'api-key-header' } },
    models: {
      pi: [
        {
          id: 'shared-reasoner',
          name: 'Shared Reasoner',
          contextWindow: 200_000,
          efforts,
          defaultEffort,
        },
      ],
    },
  } as ProviderView;
}

describe('resolveProviderModelEfforts', () => {
  it('Pi BYOM 与内置模型同 id 时只采用目标 BYOM 显式 effort，发送前回落到其唯一档位', () => {
    const providers = [
      piProvider({
        id: 'openai',
        source: 'builtin',
        efforts: ['minimal', 'low', 'medium', 'high'],
        defaultEffort: 'high',
      }),
      piProvider({
        id: 'my-byom',
        source: 'user',
        efforts: ['low'],
        defaultEffort: 'low',
      }),
    ];

    const target = resolveProviderModelEfforts({
      providers,
      providerId: 'my-byom',
      modelId: 'shared-reasoner',
      agentKind: 'pi',
    });

    expect(target).toEqual({ efforts: ['low'], defaultEffort: 'low' });
    expect(
      resolveProviderSwitchEffort({
        ...target!,
        // 模拟来自同 id 内置来源的旧记忆/当前档；二者都不得进入 BYOM 请求。
        providerEffort: 'high',
        preferred: 'high',
        fallbackEffort: 'high',
      }),
    ).toBe('low');
  });

  it('ChatInput 把目标 provider 贯穿换源与跨引擎 effort 解析后才组装 setModel 选择', () => {
    const source = readFileSync(
      resolve(__dirname, '../../components/new-chat/ChatInput.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const switchResolverStart = source.indexOf('const resolveSwitchEffort = useCallback(');
    const providerChangeStart = source.indexOf('const performProviderChange = useCallback(');
    const providerChangeEnd = source.indexOf('const handleProviderChange = useCallback(');
    const agentSwitchStart = source.indexOf('const performAgentSwitch = useCallback(');
    const agentSwitchEnd = source.indexOf('const performModelChange = useCallback(');

    expect(switchResolverStart).toBeGreaterThan(-1);
    expect(providerChangeStart).toBeGreaterThan(switchResolverStart);
    expect(providerChangeEnd).toBeGreaterThan(providerChangeStart);
    expect(agentSwitchStart).toBeGreaterThan(-1);
    expect(agentSwitchEnd).toBeGreaterThan(agentSwitchStart);
    expect(source.slice(switchResolverStart, providerChangeStart)).toContain(
      'resolveModelEfforts(targetModelId, providerId)',
    );
    expect(source.slice(providerChangeStart, providerChangeEnd)).toContain(
      'resolveModelEfforts(activeModel, newProviderId)',
    );
    expect(source.slice(agentSwitchStart, agentSwitchEnd)).toContain(
      'resolveModelEfforts(\n          newModelId,\n          providerId,\n          targetAgentKind,\n        )',
    );
    expect(source.slice(providerChangeStart, providerChangeEnd)).toContain(
      '{ effort: eff, fastMode: restoredFast }',
    );
  });
});
