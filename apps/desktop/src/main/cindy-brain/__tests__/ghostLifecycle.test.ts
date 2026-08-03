/**
 * ghostLifecycle.test.ts — 生命周期统一投影的纯函数测试。
 *
 * 覆盖:优先级链(blocked > degraded > unknown > reauth > setup > ready)、
 * 评估失败不折叠成 ready、单插件失败不拖垮整份清单、派生视图口径。
 */

import { describe, expect, it, vi } from 'vitest';

import type { GhostSetupAssessment } from '../../../shared/ghost';
import {
  isCallable,
  isDiscoverable,
  projectGhostLifecycle,
  projectGhostLifecycles,
  readinessSummary,
  type LifecycleProbes,
} from '../ghostLifecycle';

const READY: GhostSetupAssessment = { state: 'ready', revision: 1, groups: [] };

function requiredAssessment(itemState: 'missing' | 'expired'): GhostSetupAssessment {
  return {
    state: 'required',
    revision: 2,
    groups: [
      {
        id: 'manifest:1',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:api_key',
            kind: 'secret',
            label: 'API Key',
            state: itemState,
            actions: [],
          },
        ],
      },
    ],
  };
}

describe('projectGhostLifecycle 优先级链', () => {
  const base = {
    id: 'web-search',
    name: 'Web Search',
    enabled: true,
    accountAvailable: true,
    assessment: READY,
  };

  it('ready:启用 + 评估通过', () => {
    expect(projectGhostLifecycle(base).readiness).toBe('ready');
  });

  it('blocked 优先于一切(本地模式下的账号托管插件,不做评估)', () => {
    const entry = projectGhostLifecycle({
      ...base,
      accountAvailable: false,
      runtimeState: 'crashed',
      assessment: new Error('store unreadable'),
    });
    expect(entry.readiness).toBe('blocked');
    expect(entry.setup).toBeUndefined();
  });

  it('degraded 优先于 setup 判定(熔断中不谈配置)', () => {
    const entry = projectGhostLifecycle({
      ...base,
      runtimeState: 'fused',
      assessment: requiredAssessment('missing'),
    });
    expect(entry.readiness).toBe('degraded');
    expect(entry.runtimeState).toBe('fused');
  });

  it('crashed 仍保持可调用,由派发器按需重新拉起', () => {
    const entry = projectGhostLifecycle({
      ...base,
      runtimeState: 'crashed',
      assessment: READY,
    });
    expect(entry.readiness).toBe('ready');
    expect(entry.runtimeState).toBeUndefined();
    expect(isCallable(entry, false)).toBe(true);
  });

  it('评估失败 → unknown(显式降级,不折叠成 ready)', () => {
    const entry = projectGhostLifecycle({ ...base, assessment: new SyntaxError('bad store') });
    expect(entry.readiness).toBe('unknown');
    expect(entry.setup).toBeUndefined();
  });

  it('required + 全 missing → needs_setup', () => {
    const entry = projectGhostLifecycle({ ...base, assessment: requiredAssessment('missing') });
    expect(entry.readiness).toBe('needs_setup');
    expect(entry.setup?.state).toBe('required');
  });

  it('required + 任一 expired → needs_reauth(修复动作是重新连接)', () => {
    const entry = projectGhostLifecycle({ ...base, assessment: requiredAssessment('expired') });
    expect(entry.readiness).toBe('needs_reauth');
  });

  it('已满足组里的 expired 备选项不算数:只按未满足组判 needs_reauth', () => {
    // 组 A 已满足(satisfied + expired 备选项并存),组 B 纯缺失:
    // 修复动作是配组 B,不是重连组 A 的 expired key——与插件页评估器
    // 「只从未满足组列 reauth」同口径。
    const entry = projectGhostLifecycle({
      ...base,
      assessment: {
        state: 'required',
        revision: 2,
        groups: [
          {
            id: 'manifest:1',
            mode: 'any_of',
            items: [
              { ref: 'secret:old_key', kind: 'secret', label: 'Old Key', state: 'expired', actions: [] },
              { ref: 'secret:new_key', kind: 'secret', label: 'New Key', state: 'satisfied', actions: [] },
            ],
          },
          {
            id: 'manifest:2',
            mode: 'any_of',
            items: [
              { ref: 'kv:endpoint', kind: 'plugin_config', label: 'Endpoint', state: 'missing', actions: [] },
            ],
          },
        ],
      },
    });
    expect(entry.readiness).toBe('needs_setup');
  });
});

describe('projectGhostLifecycles 批量投影', () => {
  it('单插件评估抛错不拖垮整份清单', () => {
    const onError = vi.fn();
    const probes: LifecycleProbes = {
      isAccountAvailable: () => true,
      runtimeStateOf: () => undefined,
      assess: (id) => {
        if (id === 'broken') throw new SyntaxError('malformed store');
        return READY;
      },
    };
    const entries = projectGhostLifecycles(
      [
        { id: 'broken', name: 'Broken', enabled: true },
        { id: 'healthy', name: 'Healthy', enabled: true },
      ],
      probes,
      onError,
    );
    expect(entries.map((e) => e.readiness)).toEqual(['unknown', 'ready']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(SyntaxError));
  });
});

describe('派生视图', () => {
  const ready = projectGhostLifecycle({
    id: 'a',
    name: 'A',
    enabled: true,
    accountAvailable: true,
    assessment: READY,
  });
  const needsSetup = projectGhostLifecycle({
    id: 'b',
    name: 'B',
    enabled: true,
    accountAvailable: true,
    assessment: requiredAssessment('missing'),
  });
  const blocked = projectGhostLifecycle({
    id: 'c',
    name: 'C',
    enabled: true,
    accountAvailable: false,
    assessment: READY,
  });

  it('discoverable = 启用 && 非 workdir 停用(blocked 降级暴露仍可发现)', () => {
    expect(isDiscoverable(ready, false)).toBe(true);
    expect(isDiscoverable(ready, true)).toBe(false);
    expect(isDiscoverable({ ...ready, enabled: false }, false)).toBe(false);
    // blocked 降级暴露:花名册/ghost_list 可发现但零工具派发(2026-07-28
    // review 定案:发现层语义统一为「可发现、按 readiness 决定是否派发」)。
    expect(isDiscoverable(blocked, false)).toBe(true);
    // needs_setup 仍可发现(降级暴露:列出但不派发工具)
    expect(isDiscoverable(needsSetup, false)).toBe(true);
  });

  it('callable = discoverable && ready', () => {
    expect(isCallable(ready, false)).toBe(true);
    expect(isCallable(needsSetup, false)).toBe(false);
    expect(isCallable(blocked, false)).toBe(false);
    expect(isCallable(ready, true)).toBe(false);
  });

  it('readinessSummary:非 ready 给出处置指引,ready 无摘要', () => {
    expect(readinessSummary(ready)).toBeNull();
    expect(readinessSummary(needsSetup)).toContain('配置');
    expect(readinessSummary(blocked)).toContain('登录');
  });
});
