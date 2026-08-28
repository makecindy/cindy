import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  type SubagentModelSettings,
} from '../../../shared/subagentModelSettings';
import {
  buildCodexSubagentSpawnArgs,
  codexSubagentRouteResolutionFailed,
  resolveCodexSubagentHostCredentialPlan,
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

const DELEGATION_HINT_PREFIX = 'features.multi_agent_v2.multi_agent_mode_hint_text="';
const MODEL_OVERRIDE_PREFIX = 'features.multi_agent_v2.expose_spawn_agent_model_overrides=';

function expectDelegationArgs(args: string[], modelOverridesExposed = true): void {
  expect(args.some((arg) => arg.startsWith(DELEGATION_HINT_PREFIX))).toBe(true);
  expect(args).toContain(
    `${MODEL_OVERRIDE_PREFIX}${modelOverridesExposed ? 'true' : 'false'}`,
  );
}

/** 去掉默认 feature 键值对(连同配对的 '-c'),只留设置驱动的 agents.* 部分。 */
function withoutDelegationArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const kv = args[i + 1] ?? '';
    if (kv.startsWith(DELEGATION_HINT_PREFIX) || kv.startsWith(MODEL_OVERRIDE_PREFIX)) continue;
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
    const route = {
      providerId: 'openai',
      catalogModel: 'gpt-5.6-terra',
      reasoningEffort: 'high' as const,
    };
    const args = buildCodexSubagentSpawnArgs(
      settings({
        codexUseCindySubagentPolicy: false,
        codex: 'gpt-5.6-terra',
        codexEffort: 'high',
        codexMaxConcurrentSubagents: 4,
        codexAllowNestedSubagents: true,
      }),
      route,
    );
    expect(
      args.some((arg) =>
        arg.startsWith('features.multi_agent_v2.multi_agent_mode_hint_text='),
      ),
    ).toBe(false);
    expect(args).toContain('features.multi_agent_v2.expose_spawn_agent_model_overrides=false');
    expect(withoutDelegationArgs(args)).toEqual([
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

  it('keeps a locked model and effort out of Codex spawn args', () => {
    const configured = settings({
      codex: 'gpt-5.6-terra',
      codexProviderId: 'openai',
      codexEffort: 'medium',
      codexMaxConcurrentSubagents: 3,
    });
    const args = buildCodexSubagentSpawnArgs(
      configured,
      resolveCodexSubagentRouteSnapshot(configured),
    );
    expectDelegationArgs(args, false);
    expect(withoutDelegationArgs(args)).toEqual([
      '-c',
      'agents.max_concurrent_threads_per_session=3',
    ]);
  });

  it('never serializes a Provider-prefixed locked model into spawn_agent config', () => {
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
      const configured = settings({
        codex: 'vendor-a/model-a',
        codexProviderId: 'spawn-rewrite-provider',
      });
      expect(
        withoutDelegationArgs(buildCodexSubagentSpawnArgs(
          configured,
          resolveCodexSubagentRouteSnapshot(configured),
        )),
      ).toEqual([]);
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
      expect(
        arg.startsWith(DELEGATION_HINT_PREFIX) || arg.startsWith(MODEL_OVERRIDE_PREFIX),
      ).toBe(true);
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

  it('fails closed when a configured model has no enforceable route', () => {
    expect(
      withoutDelegationArgs(
        buildCodexSubagentSpawnArgs(settings({ codex: 'weird"model\\id' })),
      ),
    ).toEqual(['-c', 'agents.enabled=false']);
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

describe('resolveCodexSubagentRouteSnapshot', () => {
  it('resolves a provider-less native Codex model with the selector default source', () => {
    const configured = settings({
      codex: 'gpt-5.6-terra',
      codexProviderId: null,
      codexEffort: 'high',
    });
    const route = resolveCodexSubagentRouteSnapshot(
      configured,
      undefined,
      [
        providerView('xd', 'gpt-5.6-terra'),
        providerView('openai', 'gpt-5.6-terra'),
      ],
    );

    expect(route).toEqual({
      providerId: 'openai',
      catalogModel: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    });
    const args = buildCodexSubagentSpawnArgs(configured, route);
    expectDelegationArgs(args, false);
    expect(withoutDelegationArgs(args)).toEqual([]);
  });

  it('freezes the connected implicit Provider without rewriting the catalog model', () => {
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
        reasoningEffort: null,
      });
      expectDelegationArgs(buildCodexSubagentSpawnArgs(configured, route), false);
      expect(withoutDelegationArgs(buildCodexSubagentSpawnArgs(configured, route))).toEqual([]);
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

  it('strictly validates an explicitly saved Provider against the current catalog', () => {
    const configured = settings({
      codex: 'route/model-a',
      codexProviderId: 'explicit-provider',
      codexEffort: 'high',
    });
    expect(resolveCodexSubagentRouteSnapshot(
      configured,
      undefined,
      [providerView('explicit-provider', 'route/model-a', { source: 'user' })],
    )).toEqual({
      providerId: 'explicit-provider',
      catalogModel: 'route/model-a',
      reasoningEffort: 'high',
    });
    expect(resolveCodexSubagentRouteSnapshot(
      configured,
      undefined,
      [providerView('explicit-provider', 'other-model', { source: 'user' })],
    )).toBeUndefined();
    expect(resolveCodexSubagentRouteSnapshot(
      configured,
      undefined,
      [providerView('explicit-provider', 'route/model-a', {
        connected: false,
        source: 'user',
      })],
    )).toBeUndefined();
    expect(resolveCodexSubagentRouteSnapshot(
      configured,
      undefined,
      [providerView('fallback-provider', 'route/model-a', { source: 'user' })],
    )).toBeUndefined();
  });

  it('keeps Provider wire rewrites out of the frozen catalog identity', () => {
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
      expect(resolveCodexSubagentRouteSnapshot(settings({
        codex: 'route/model-a',
        codexProviderId: 'runtime-rewrite-provider',
        codexEffort: 'max',
      }))).toEqual({
        providerId: 'runtime-rewrite-provider',
        catalogModel: 'route/model-a',
        reasoningEffort: 'max',
      });
    } finally {
      setCustomProviders([]);
    }
  });

  it('preserves the Gateway budget model id verbatim for Proxy routing', () => {
    expect(resolveCodexSubagentRouteSnapshot(settings({
      codex: 'codex/gpt-5.6-sol',
      codexProviderId: 'xd',
      codexEffort: 'ultra',
    }))).toEqual({
      providerId: 'xd',
      catalogModel: 'codex/gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
  });

  it('fails closed when a configured local model has no resolved Provider route', () => {
    const configured = settings({ codex: 'gpt-5.6-terra' });
    const route = {
      providerId: 'openai',
      catalogModel: 'gpt-5.6-terra',
      reasoningEffort: null,
    };

    expect(codexSubagentRouteResolutionFailed(configured, undefined)).toBe(true);
    expect(codexSubagentRouteResolutionFailed(configured, route)).toBe(false);
    expect(codexSubagentRouteResolutionFailed(configured, undefined, {
      remoteHostId: 'remote-a',
    })).toBe(false);
    expect(codexSubagentRouteResolutionFailed(configured, undefined, {
      isReview: true,
    })).toBe(false);
    expect(codexSubagentRouteResolutionFailed(settings({ codex: null }), undefined)).toBe(false);
    expect(codexSubagentRouteResolutionFailed(settings({
      codex: 'gpt-5.6-terra',
      codexSubagentsEnabled: false,
    }), undefined)).toBe(false);
  });

  it('disables subagents when the frozen Provider route cannot be enforced', () => {
    const configured = settings({
      codex: 'codex/gpt-5.6-sol',
      codexProviderId: 'xd',
    });
    expect(
      withoutDelegationArgs(buildCodexSubagentSpawnArgs(configured, undefined, {
        forceDisableSubagents: true,
      })),
    ).toEqual(['-c', 'agents.enabled=false']);
    expect(
      withoutDelegationArgs(buildCodexSubagentSpawnArgs(configured, undefined)),
    ).toEqual(['-c', 'agents.enabled=false']);
    const route = resolveCodexSubagentRouteSnapshot(configured);
    const lockedArgs = buildCodexSubagentSpawnArgs(configured, route);
    expectDelegationArgs(lockedArgs, false);
    expect(withoutDelegationArgs(lockedArgs)).toEqual([]);
    expect(
      withoutDelegationArgs(buildCodexSubagentSpawnArgs(
        settings({ codex: 'gpt-5.6-terra', codexProviderId: 'openai' }),
        undefined,
        { forceDisableSubagents: true },
      )),
    ).toEqual(['-c', 'agents.enabled=false']);
  });
});

describe('resolveCodexSubagentHostCredentialPlan', () => {
  const openAiRoute = {
    providerId: 'openai',
    catalogModel: 'gpt-5.6-terra',
    reasoningEffort: null,
  };
  const openAiViews = [providerView('openai', 'gpt-5.6-terra')];

  it('upgrades a provider OAuth parent host for a connected ChatGPT locked route', () => {
    expect(resolveCodexSubagentHostCredentialPlan(
      openAiRoute,
      openAiViews,
      'provider-oauth',
      true,
    )).toEqual({
      forceDisableSubagents: false,
      requiredSpawnCredentialMode: 'oauth-bearer',
    });
  });

  it('fails closed when the ChatGPT locked route has no OAuth credential', () => {
    expect(resolveCodexSubagentHostCredentialPlan(
      openAiRoute,
      openAiViews,
      'provider-oauth',
      false,
    )).toEqual({ forceDisableSubagents: true });
  });
});
