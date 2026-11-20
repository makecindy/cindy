/**
 * 测试价值
 * - 生产入口与可观察结果：expandBotModelGroups（伙伴应用首选与故障接替读到的链）→ nextBotModelRoute（下一个接替的来源）。
 *   伙伴模型链里的模型组展开成组内来源；出错时先在组内往后、再绕回前面，组内用尽才走备用链；组被删或全部停用时按存下的模型。
 * - 规则依据：model-groups.md §6.2；用户反馈 2026-11-20「模型组设置好，伙伴还是不能用」。
 * - 现有覆盖缺口：botModelChain.test.ts 只覆盖普通链；接替会把链截到 5 项，展开后的组会被截断。
 * - 最小失败输入：[组(a,b,c), 备用 d]，当前在 b → 期望 c、a、d；旧逻辑不认识组，链里没有 a/b/c。
 * - tier：unit（纯函数）。
 */
import { describe, expect, it } from 'vitest';

import { nextBotModelRoute, botModelRouteRuntimeKey, type BotModelRoute } from '../../../shared/botModelChain';
import type { ModelGroupsConfig } from '../../../shared/modelGroups';
import { expandBotModelGroups } from '../botRoutes';

const plain = (model: string, extra: Partial<BotModelRoute> = {}): BotModelRoute =>
  ({ harness: 'codex', model, providerId: 'xd', effort: '', fastMode: false, ...extra });

const config: ModelGroupsConfig = {
  routes: [{
    id: 'g', name: 'Group', strategy: 'rotate', effort: 'high',
    candidates: [
      { agentKind: 'cc', providerId: 'sub', model: 'a' },
      { agentKind: 'codex', providerId: 'xd', model: 'b', agentDeviceId: 'mac-2' },
      { agentKind: 'pi', providerId: 'xd', model: 'off', off: true },
      { agentKind: 'pi', providerId: 'xd', model: 'c' },
    ],
  }],
};

describe('model groups in a companion model chain', () => {
  const saved = [plain('a', { harness: 'claude', providerId: 'sub', modelGroup: 'g' }), plain('d'), plain('e'), plain('f'), plain('g2'), plain('h')];
  const expanded = expandBotModelGroups(saved, config);

  it('expands a group into its enabled sources, keeping location and the group effort; never cut at five', () => {
    expect(expanded.map((route) => [route.harness, route.model, route.agentDeviceId ?? null, route.modelGroup ?? null, route.effort]))
      .toEqual([
        ['claude', 'a', null, 'g', 'high'],
        ['codex', 'b', 'mac-2', 'g', 'high'],
        ['pi', 'c', null, 'g', 'high'],
        ['codex', 'd', null, null, ''], ['codex', 'e', null, null, ''], ['codex', 'f', null, null, ''],
        ['codex', 'g2', null, null, ''], ['codex', 'h', null, null, ''],
      ]);
  });

  it.each([
    { from: 'b', visited: [], next: 'c' },
    // The group's pick may start anywhere: the rest of the group, wrapping round, before the backups.
    { from: 'c', visited: [], next: 'a' },
    { from: 'c', visited: ['a', 'b'], next: 'd' },
    { from: 'h', visited: [], next: null },
  ])('after $from (tried $visited) the next source is $next', ({ from, visited, next }) => {
    const current = expanded.find((route) => route.model === from)!;
    const keys = visited.map((model) => botModelRouteRuntimeKey(expanded.find((route) => route.model === model)!));
    expect(nextBotModelRoute(expanded, current, keys)?.model ?? null).toBe(next);
  });

  it.each([
    { name: 'a deleted group', groups: { routes: [] } },
    { name: 'a group with every source turned off', groups: { routes: [{ ...config.routes[0]!, candidates: config.routes[0]!.candidates.map((item) => ({ ...item, off: true })) }] } },
  ])('runs the saved model for $name', ({ groups }) => {
    expect(expandBotModelGroups([plain('saved', { modelGroup: 'g' }), plain('d')], groups)).toEqual([plain('saved'), plain('d')]);
  });

  it('leaves a chain without groups exactly as saved (no spurious re-apply for existing companions)', () => {
    const chain = [plain('d'), plain('e', { agentDeviceId: 'mac-2', effort: 'low' })];
    expect(JSON.stringify(expandBotModelGroups(chain, config))).toBe(JSON.stringify(chain));
  });
});
