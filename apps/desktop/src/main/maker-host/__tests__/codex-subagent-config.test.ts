import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  type SubagentModelSettings,
} from '../../../shared/subagentModelSettings';
import { buildCodexSubagentSpawnArgs } from '../codex-subagent-config';

function settings(partial: Partial<SubagentModelSettings> = {}): SubagentModelSettings {
  return { ...SUBAGENT_MODEL_SETTINGS_DEFAULTS, ...partial };
}

describe('buildCodexSubagentSpawnArgs', () => {
  it('emits nothing for all-default settings', () => {
    expect(buildCodexSubagentSpawnArgs(settings())).toEqual([]);
  });

  it('emits only agents.enabled=false when the master switch is off', () => {
    // 总开关关死后其余键无意义:即使其它护栏/模型都有值也不再注入。
    expect(
      buildCodexSubagentSpawnArgs(
        settings({
          codexSubagentsEnabled: false,
          codex: 'gpt-5.6-terra',
          codexEffort: 'high',
          codexMaxConcurrentSubagents: 3,
          codexAllowNestedSubagents: true,
        }),
      ),
    ).toEqual(['-c', 'agents.enabled=false']);
  });

  it('quotes string values and keeps numbers bare (TOML forms)', () => {
    expect(
      buildCodexSubagentSpawnArgs(
        settings({
          codex: 'gpt-5.6-terra',
          codexEffort: 'medium',
          codexMaxConcurrentSubagents: 3,
        }),
      ),
    ).toEqual([
      '-c',
      'agents.default_subagent_model="gpt-5.6-terra"',
      '-c',
      'agents.default_subagent_reasoning_effort="medium"',
      '-c',
      'agents.max_concurrent_threads_per_session=3',
    ]);
  });

  it('injects discounted-route model ids verbatim (no prefix stripping)', () => {
    // codex/ 前缀由 loopback proxy 在 HTTP 边界分流,剥前缀会把折扣路由静默改道。
    expect(buildCodexSubagentSpawnArgs(settings({ codex: 'codex/gpt-5.5' }))).toEqual([
      '-c',
      'agents.default_subagent_model="codex/gpt-5.5"',
    ]);
  });

  it('maps the nested-subagents switch to agents.max_depth=2', () => {
    expect(buildCodexSubagentSpawnArgs(settings({ codexAllowNestedSubagents: true }))).toEqual([
      '-c',
      'agents.max_depth=2',
    ]);
  });

  it('keeps concurrency bounds inclusive', () => {
    expect(
      buildCodexSubagentSpawnArgs(settings({ codexMaxConcurrentSubagents: 1 })),
    ).toEqual(['-c', 'agents.max_concurrent_threads_per_session=1']);
    expect(
      buildCodexSubagentSpawnArgs(settings({ codexMaxConcurrentSubagents: 8 })),
    ).toEqual(['-c', 'agents.max_concurrent_threads_per_session=8']);
  });

  it('never emits features.multi_agent_v2.* keys (regression guard)', () => {
    // 上游两个配置 struct 都 deny_unknown_fields,且 features 段与 agents 段的并发
    // 键语义不同(总线程 vs 子代理数)——同时写会产生双重语义,永远只写 agents.*。
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
      expect(arg).not.toContain('features.multi_agent_v2');
    }
    const disabled = buildCodexSubagentSpawnArgs(settings({ codexSubagentsEnabled: false }));
    for (const arg of disabled) {
      expect(arg).not.toContain('features.multi_agent_v2');
    }
  });

  it('escapes TOML-breaking characters defensively', () => {
    expect(buildCodexSubagentSpawnArgs(settings({ codex: 'weird"model\\id' }))).toEqual([
      '-c',
      'agents.default_subagent_model="weird\\"model\\\\id"',
    ]);
  });
});
