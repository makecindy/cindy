/**
 * 本地 ChatInput 切换来源时的 effort 能力必须按 `(provider, agent, model)` 解析。
 * picker 的模型清单是跨来源 first-wins；同 id 的内置 Pi 与 BYOM 能力不同时，不能把
 * 内置档位误当成 BYOM 可发送档位。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveEffort,
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

  it('model-only 切换在 BYOM defaultEffort=null 时仍只从该来源的显式档位回落', () => {
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
        efforts: ['low', 'high'],
        defaultEffort: null,
      }),
    ];

    const target = resolveProviderModelEfforts({
      providers,
      providerId: 'my-byom',
      modelId: 'shared-reasoner',
      agentKind: 'pi',
    });

    expect(target).toEqual({ efforts: ['low', 'high'], defaultEffort: null });
    expect(
      resolveEffort({
        ...target!,
        // 内置来源支持的 medium 不能穿进 BYOM；null 默认应回落到 BYOM 首个显式档位。
        activeEffort: 'medium',
        providerEffort: 'medium',
        rememberedEffort: 'medium',
      }),
    ).toBe('low');
  });

  it('ChatInput 把目标 provider 贯穿 model-only、换源与跨引擎 effort 解析后才组装 setModel 选择', () => {
    const source = readFileSync(
      resolve(__dirname, '../../components/new-chat/ChatInput.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const switchResolverStart = source.indexOf('const resolveSwitchEffort = useCallback(');
    const providerChangeStart = source.indexOf('const performProviderChange = useCallback(');
    const providerChangeEnd = source.indexOf('const handleProviderChange = useCallback(');
    const agentSwitchStart = source.indexOf('const performAgentSwitch = useCallback(');
    const agentSwitchEnd = source.indexOf('const performModelChange = useCallback(');
    const modelChangeStart = agentSwitchEnd;
    const modelChangeEnd = source.indexOf('const handleModelChange = useCallback(');

    expect(switchResolverStart).toBeGreaterThan(-1);
    expect(providerChangeStart).toBeGreaterThan(switchResolverStart);
    expect(providerChangeEnd).toBeGreaterThan(providerChangeStart);
    expect(agentSwitchStart).toBeGreaterThan(-1);
    expect(agentSwitchEnd).toBeGreaterThan(agentSwitchStart);
    expect(modelChangeStart).toBeGreaterThan(-1);
    expect(modelChangeEnd).toBeGreaterThan(modelChangeStart);
    expect(source.slice(switchResolverStart, providerChangeStart)).toContain(
      'resolveModelEfforts(targetModelId, providerId)',
    );
    expect(source.slice(providerChangeStart, providerChangeEnd)).toContain(
      'resolveModelEfforts(activeModel, newProviderId)',
    );
    expect(source.slice(agentSwitchStart, agentSwitchEnd)).toContain(
      'resolveModelEfforts(\n          newModelId,\n          providerId,\n          targetAgentKind,\n        )',
    );
    expect(source.slice(modelChangeStart, modelChangeEnd)).toMatch(
      /resolveModelEfforts\(\s*newModelId,\s*effectiveSourceId\s*\)/,
    );
    expect(source.slice(providerChangeStart, providerChangeEnd)).toContain(
      '{ effort: eff, fastMode: restoredFast }',
    );
  });
});
