import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  type SubagentModelSettings,
} from '../../../shared/subagentModelSettings';
import {
  buildCodexSubagentSpawnArgs,
  codexSubagentRuntimeModelId,
  resolveCodexSubagentModelFallback,
  resolveCodexSubagentRouteSnapshot,
} from '../codex-subagent-config';
import { setCustomProviders } from '../active-catalog';

function settings(partial: Partial<SubagentModelSettings> = {}): SubagentModelSettings {
  return { ...SUBAGENT_MODEL_SETTINGS_DEFAULTS, ...partial };
}

function providerView(
  id: string,
  modelId: string,
  options: { connected?: boolean; source?: 'builtin' | 'user' } = {},
): ProviderView {
  return {
    id,
    name: id,
    source: options.source ?? 'builtin',
    connected: options.connected ?? true,
    agents: ['codex'],
    auth: { method: 'none' },
    routing: {
      codex: {
        upstream: `https://${id}.invalid/v1`,
        authStrategy: 'oauth-passthrough',
      },
    },
    models: {
      codex: [{ id: modelId, name: modelId }],
    },
  } as unknown as ProviderView;
}

// 默认设置注入的两个 features 段键(Cindy 策略 + spawn 模型覆盖)。
const DELEGATION_ARGS_PREFIXES = [
  'features.multi_agent_v2.multi_agent_mode_hint_text="',
  'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
] as const;

function expectDelegationArgs(args: string[]): void {
  for (const prefix of DELEGATION_ARGS_PREFIXES) {
    expect(args.some((arg) => arg.startsWith(prefix))).toBe(true);
  }
}

/** 去掉默认 feature 键值对(连同配对的 '-c'),只留设置驱动的 agents.* 部分。 */
function withoutDelegationArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const kv = args[i + 1] ?? '';
    if (DELEGATION_ARGS_PREFIXES.some((prefix) => kv.startsWith(prefix))) continue;
    out.push(args[i]!, kv);
  }
  return out;
}

describe('buildCodexSubagentSpawnArgs', () => {
  it('emits only the delegation defaults for all-default settings', () => {
    const args = buildCodexSubagentSpawnArgs(settings());
    // 形态:两条 '-c' + 值的键值对,无 agents.* 键。
    expect(args.filter((a) => a === '-c')).toHaveLength(2);
    expectDelegationArgs(args);
    for (const arg of args) {
      expect(arg).not.toContain('agents.');
    }
  });

  it('uses Codex native scheduling when the Cindy policy is off', () => {
    const args = buildCodexSubagentSpawnArgs(
      settings({
        codexUseCindySubagentPolicy: false,
        codex: 'gpt-5.6-terra',
        codexEffort: 'high',
        codexMaxConcurrentSubagents: 4,
        codexAllowNestedSubagents: true,
      }),
    );
    expect(
      args.some((arg) =>
        arg.startsWith('features.multi_agent_v2.multi_agent_mode_hint_text='),
      ),
    ).toBe(false);
    expect(args).toContain('features.multi_agent_v2.expose_spawn_agent_model_overrides=true');
    expect(withoutDelegationArgs(args)).toEqual([
      '-c',
      'agents.default_subagent_model="gpt-5.6-terra"',
      '-c',
      'agents.default_subagent_reasoning_effort="high"',
      '-c',
      'agents.max_concurrent_threads_per_session=4',
      '-c',
      'agents.max_depth=2',
    ]);
  });

  it('keeps the delegation hint within the upstream 400-token budget', () => {
    // 上游 MULTI_AGENT_MODE_MAX_TOKENS=400;粗算 4 chars/token,留足余量。
    const hintArg = buildCodexSubagentSpawnArgs(settings()).find((arg) =>
      arg.startsWith('features.multi_agent_v2.multi_agent_mode_hint_text='),
    );
    expect(hintArg).toBeDefined();
    expect(hintArg!.length).toBeLessThan(1400);
  });

  it('emits only agents.enabled=false when the master switch is off', () => {
    // 总开关关死后其余键无意义:即使其它护栏/模型都有值也不再注入。
    expect(
      buildCodexSubagentSpawnArgs(
        settings({
          codexSubagentsEnabled: false,
          codexUseCindySubagentPolicy: false,
          codex: 'gpt-5.6-terra',
          codexEffort: 'high',
          codexMaxConcurrentSubagents: 3,
          codexAllowNestedSubagents: true,
        }),
      ),
    ).toEqual(['-c', 'agents.enabled=false']);
  });

  it('quotes string values and keeps numbers bare (TOML forms)', () => {
    const args = buildCodexSubagentSpawnArgs(
      settings({
        codex: 'gpt-5.6-terra',
        codexEffort: 'medium',
        codexMaxConcurrentSubagents: 3,
      }),
    );
    expectDelegationArgs(args);
    expect(withoutDelegationArgs(args)).toEqual([
      '-c',
      'agents.default_subagent_model="gpt-5.6-terra"',
      '-c',
      'agents.default_subagent_reasoning_effort="medium"',
      '-c',
      'agents.max_concurrent_threads_per_session=3',
    ]);
  });

  it('uses the selected Provider rewrite for the runtime slug accepted by spawn_agent', () => {
    setCustomProviders([{
      id: 'spawn-rewrite-provider',
      name: 'Spawn Rewrite Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-responses',
          upstream: 'https://spawn-rewrite.invalid/v1',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'vendor-a/' },
        },
      },
      models: { codex: [{ id: 'vendor-a/model-a', name: 'Model A' }] },
    } as never]);
    try {
      expect(
        withoutDelegationArgs(buildCodexSubagentSpawnArgs(settings({
          codex: 'vendor-a/model-a',
          codexProviderId: 'spawn-rewrite-provider',
        }))),
      ).toEqual(['-c', 'agents.default_subagent_model="model-a"']);
    } finally {
      setCustomProviders([]);
    }
  });

  it('maps the nested-subagents switch to agents.max_depth=2', () => {
    expect(
      withoutDelegationArgs(
        buildCodexSubagentSpawnArgs(settings({ codexAllowNestedSubagents: true })),
      ),
    ).toEqual(['-c', 'agents.max_depth=2']);
  });

  it('keeps concurrency bounds inclusive', () => {
    expect(
      withoutDelegationArgs(
        buildCodexSubagentSpawnArgs(settings({ codexMaxConcurrentSubagents: 1 })),
      ),
    ).toEqual(['-c', 'agents.max_concurrent_threads_per_session=1']);
    expect(
      withoutDelegationArgs(
        buildCodexSubagentSpawnArgs(settings({ codexMaxConcurrentSubagents: 8 })),
      ),
    ).toEqual(['-c', 'agents.max_concurrent_threads_per_session=8']);
  });

  it('only emits the two allowlisted features.multi_agent_v2.* keys (regression guard)', () => {
    // 上游两个配置 struct 都 deny_unknown_fields;并发键在 features 段语义为总线程
    // (=N+1)且优先级更高——并发数永远只写 agents.*,features 段只允许 hint 与
    // expose 两个无 agents 等价物的键。
    const exhaustive = buildCodexSubagentSpawnArgs(
      settings({
        codexSubagentsEnabled: true,
        codex: 'gpt-5.6-sol',
        codexEffort: 'ultra',
        codexMaxConcurrentSubagents: 8,
        codexAllowNestedSubagents: true,
      }),
    );
    for (const arg of exhaustive) {
      if (!arg.startsWith('features.multi_agent_v2')) continue;
      expect(DELEGATION_ARGS_PREFIXES.some((prefix) => arg.startsWith(prefix))).toBe(true);
    }
    expect(
      exhaustive.some((arg) => arg.includes('features.multi_agent_v2.max_concurrent')),
    ).toBe(false);
  });

  it('emits no features.multi_agent_v2.* keys when the master switch is off', () => {
    // 总开关关闭 = agents.enabled=false 已压住一切,委托策略不再注入。
    const disabled = buildCodexSubagentSpawnArgs(settings({ codexSubagentsEnabled: false }));
    for (const arg of disabled) {
      expect(arg).not.toContain('features.multi_agent_v2');
    }
  });

  it('escapes TOML-breaking characters defensively', () => {
    expect(
      withoutDelegationArgs(
        buildCodexSubagentSpawnArgs(settings({ codex: 'weird"model\\id' })),
      ),
    ).toEqual(['-c', 'agents.default_subagent_model="weird\\"model\\\\id"']);
  });
});

describe('resolveCodexSubagentModelFallback', () => {
  it('preserves the configured catalog model for display and proxy routing', () => {
    expect(resolveCodexSubagentModelFallback(settings({ codex: 'codex/gpt-5.5' }))).toBe(
      'codex/gpt-5.5',
    );
  });

  it('does not project a local model setting onto an SSH remote daemon', () => {
    expect(
      resolveCodexSubagentModelFallback(
        settings({ codex: 'codex/gpt-5.5' }),
        'remote-host-1',
      ),
    ).toBeUndefined();
  });

  it('returns no fallback when Codex subagents are disabled', () => {
    expect(
      resolveCodexSubagentModelFallback(
        settings({ codexSubagentsEnabled: false, codex: 'codex/gpt-5.5' }),
      ),
    ).toBeUndefined();
  });
});

describe('codexSubagentRuntimeModelId', () => {
  it('resolves a provider-less native Codex model with the selector default source', () => {
    const route = resolveCodexSubagentRouteSnapshot(
      settings({ codex: 'gpt-5.6-terra', codexProviderId: null }),
      undefined,
      [
        providerView('xd', 'gpt-5.6-terra'),
        providerView('openai', 'gpt-5.6-terra'),
      ],
    );

    expect(route).toEqual({
      providerId: 'openai',
      catalogModel: 'gpt-5.6-terra',
      runtimeModel: 'gpt-5.6-terra',
    });
    expect(withoutDelegationArgs(buildCodexSubagentSpawnArgs(
      settings({ codex: 'gpt-5.6-terra', codexProviderId: null }),
      route,
    ))).toEqual(['-c', 'agents.default_subagent_model="gpt-5.6-terra"']);
  });

  it('uses the connected implicit Provider rewrite for provider-less stored settings', () => {
    setCustomProviders([{
      id: 'implicit-rewrite-provider',
      name: 'Implicit Rewrite Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-responses',
          upstream: 'https://implicit-rewrite.invalid/v1',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'route/' },
        },
      },
      models: { codex: [{ id: 'route/model-a', name: 'Model A' }] },
    } as never]);
    try {
      const configured = settings({ codex: 'route/model-a', codexProviderId: null });
      const route = resolveCodexSubagentRouteSnapshot(
        configured,
        undefined,
        [providerView('implicit-rewrite-provider', 'route/model-a', { source: 'user' })],
      );

      expect(route).toEqual({
        providerId: 'implicit-rewrite-provider',
        catalogModel: 'route/model-a',
        runtimeModel: 'model-a',
      });
      expect(withoutDelegationArgs(buildCodexSubagentSpawnArgs(configured, route))).toEqual([
        '-c',
        'agents.default_subagent_model="model-a"',
      ]);
    } finally {
      setCustomProviders([]);
    }
  });

  it('does not resolve a provider-less route from disconnected sources', () => {
    expect(resolveCodexSubagentRouteSnapshot(
      settings({ codex: 'route/model-a', codexProviderId: null }),
      undefined,
      [providerView('disconnected-provider', 'route/model-a', { connected: false })],
    )).toBeUndefined();
  });

  it('applies an arbitrary Provider-declared model rewrite without prefix hardcoding', () => {
    setCustomProviders([{
      id: 'runtime-rewrite-provider',
      name: 'Runtime Rewrite Provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          wireProtocol: 'openai-responses',
          upstream: 'https://runtime-rewrite.invalid/v1',
          authStrategy: 'api-key-header',
          modelIdRewrite: { stripPrefix: 'route/' },
        },
      },
      models: { codex: [{ id: 'route/model-a', name: 'Model A' }] },
    } as never]);
    try {
      expect(codexSubagentRuntimeModelId(' route/model-a ', 'runtime-rewrite-provider'))
        .toBe('model-a');
      expect(codexSubagentRuntimeModelId('model-a', 'runtime-rewrite-provider'))
        .toBe('model-a');
      expect(resolveCodexSubagentRouteSnapshot(settings({
        codex: 'route/model-a',
        codexProviderId: 'runtime-rewrite-provider',
      }))).toEqual({
        providerId: 'runtime-rewrite-provider',
        catalogModel: 'route/model-a',
        runtimeModel: 'model-a',
      });
    } finally {
      setCustomProviders([]);
    }
  });
});
