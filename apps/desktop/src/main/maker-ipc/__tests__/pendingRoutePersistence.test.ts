import { describe, expect, it } from 'vitest';

import type { CatalogModel } from '@cindy/model-providers';

import { buildPendingRoutePatch } from '../pendingRoutePersistence.js';

/**
 * 固定档位模型（efforts = []，如未配置推理档位的自定义供应商模型）在
 * resolveSessionRuntimeAxes 下收敛出 effort: null。sessions.effort 是 NOT NULL
 * —— patch 必须省略 effort 键而不是写入 null（2026-10 事故：回滚到固定档位
 * 模型时 `NOT NULL constraint failed: sessions.effort` 让回滚失败、会话输入
 * 队列永久冻结，只能重启 App）。
 */
function fixedEffortModel(id: string): CatalogModel {
  return { id, name: id, efforts: [], defaultEffort: null, contextWindow: 200000 };
}

function reasoningModel(id: string, efforts: Array<'low' | 'high' | 'xhigh'>, defaultEffort: 'low' | 'high' | 'xhigh' | null = 'high'): CatalogModel {
  return { id, name: id, efforts, defaultEffort, supportsFastMode: true, contextWindow: 200000 };
}

describe('buildPendingRoutePatch', () => {
  it('omits the effort key when a fixed-effort catalog model resolves effort to null', () => {
    const { patch, effort, fastMode } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a', model: 'fixed-axis-model' },
      currentRow: { model: 'fixed-axis-model', effort: 'xhigh', fastMode: false },
      previousRoute: undefined,
      catalogModel: fixedEffortModel('fixed-axis-model'),
    });
    // 回归主断言:patch 里不允许出现 effort 键(值为 null 会撞 NOT NULL 约束)。
    expect('effort' in patch).toBe(false);
    expect(patch).toMatchObject({ providerId: 'custom-provider-a', model: 'fixed-axis-model', fastMode: false });
    // 内存侧仍返回 null:store 清除记录,resume 走默认,语义不变。
    expect(effort).toBeNull();
    expect(fastMode).toBe(false);
  });

  it('keeps the current valid effort for reasoning models', () => {
    const { patch, effort } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a', model: 'fixed-axis-model' },
      currentRow: { model: 'fixed-axis-model', effort: 'xhigh', fastMode: false },
      previousRoute: undefined,
      catalogModel: reasoningModel('fixed-axis-model', ['low', 'high', 'xhigh']),
    });
    expect(patch.effort).toBe('xhigh');
    expect(effort).toBe('xhigh');
  });

  it('reconciles an effort the target model does not offer down to its default', () => {
    const { patch, effort } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a', model: 'reasoning-axis-model' },
      currentRow: { model: 'reasoning-axis-model', effort: 'max', fastMode: false },
      previousRoute: undefined,
      catalogModel: reasoningModel('reasoning-axis-model', ['low', 'high'], 'high'),
    });
    expect(patch.effort).toBe('high');
    expect(effort).toBe('high');
  });

  it('restores the captured previous route axes verbatim on rollback', () => {
    const previous = { model: 'fixed-axis-model', providerId: 'custom-provider-a', effort: 'max', fastMode: true };
    const { patch, effort, fastMode } = buildPendingRoutePatch({
      route: { ...previous },
      currentRow: { model: 'fixed-axis-model', effort: 'low', fastMode: false },
      previousRoute: previous,
      catalogModel: undefined,
    });
    expect(patch.effort).toBe('max');
    expect(patch.fastMode).toBe(true);
    expect(effort).toBe('max');
    expect(fastMode).toBe(true);
  });

  it('falls back to the route effort when the sessions row is already gone', () => {
    const { patch, effort } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-b', model: 'reasoning-axis-model', effort: 'low' },
      currentRow: undefined,
      previousRoute: undefined,
      catalogModel: undefined,
    });
    expect(patch.effort).toBe('low');
    expect(effort).toBe('low');
  });

  it('omits effort when the row is gone and the route carries no usable effort', () => {
    const { patch } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-b', model: 'reasoning-axis-model', effort: 'bogus' },
      currentRow: undefined,
      previousRoute: undefined,
      catalogModel: undefined,
    });
    expect('effort' in patch).toBe(false);
  });

  it('writes the verified context window only alongside a model', () => {
    const withModel = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a', model: 'fixed-axis-model' },
      currentRow: { model: 'fixed-axis-model', effort: 'high', fastMode: false },
      catalogModel: undefined,
      verifiedWindow: 280000,
    });
    expect(withModel.patch.contextWindow).toBe(280000);
    const withoutModel = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a' },
      currentRow: { model: 'fixed-axis-model', effort: 'high', fastMode: false },
      catalogModel: undefined,
      verifiedWindow: 280000,
    });
    expect('model' in withoutModel.patch).toBe(false);
    expect('contextWindow' in withoutModel.patch).toBe(false);
  });

  it('reconciles fast mode off when the catalog model does not support it', () => {
    const model: CatalogModel = { ...reasoningModel('reasoning-axis-model', ['high']), supportsFastMode: false };
    const { patch, fastMode } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-a', model: 'reasoning-axis-model' },
      currentRow: { model: 'reasoning-axis-model', effort: 'high', fastMode: true },
      previousRoute: undefined,
      catalogModel: model,
    });
    expect(patch.fastMode).toBe(false);
    expect(fastMode).toBe(false);
  });

  it('ignores a previousRoute that only shares the model but not the provider', () => {
    const { patch } = buildPendingRoutePatch({
      route: { providerId: 'custom-provider-b', model: 'fixed-axis-model' },
      currentRow: { model: 'fixed-axis-model', effort: 'low', fastMode: false },
      previousRoute: { model: 'fixed-axis-model', providerId: 'custom-provider-a', effort: 'max' },
      catalogModel: undefined,
    });
    // provider 不同 = 不是回滚:沿用 DB 现值,不恢复 previousRoute.effort。
    expect(patch.effort).toBe('low');
  });
});
