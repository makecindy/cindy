/**
 * 测试价值
 * - 生产入口与可观察结果：expandBotModelGroups → nextBotModelRoute（伙伴故障接替的下一个来源），
 *   botModelGroupsSignature（伙伴套用判断的配置键里的组配置）。组展开成此刻生效的组、原组的来源与存下的模型；
 *   出错时先在这一段里往后、再绕回前面，都试过才走备用链；改组的选法 / 例外会让伙伴重新选。
 * - 规则依据：model-groups.md §6.2；用户反馈 2026-11-20「模型组设置好，伙伴还是不能用」；PR #11683 评审
 *   （改选法不生效、时段例外改走的组没有接替、组用不了没有回到存下的模型）。
 * - 现有覆盖缺口：botModelChain.test.ts 只覆盖普通链；接替会把链截到 5 项。
 * - 最小失败输入：[组(a,b,c), 备用 d]，当前在 c → 期望 a，再到 d；组 g 在当前时段改走 n → 先试 n 的来源。
 * - tier：unit（纯函数）。
 */
import { describe, expect, it } from 'vitest';

import { normalizeBotModelChain, selectBotFallbackRoute, nextBotModelRoute, botModelRouteRuntimeKey, type BotModelRoute } from '../../../shared/botModelChain';
import type { ModelGroupRoute, ModelGroupsConfig } from '../../../shared/modelGroups';
import { botModelGroupsSignature, expandBotModelGroups } from '../botRoutes';

const plain = (model: string, extra: Partial<BotModelRoute> = {}): BotModelRoute =>
  ({ harness: 'codex', model, providerId: 'xd', effort: '', fastMode: false, ...extra });

const group: ModelGroupRoute = {
  id: 'g', name: 'Group', strategy: 'rotate', effort: 'high',
  candidates: [
    { agentKind: 'cc', providerId: 'sub', model: 'a' },
    { agentKind: 'codex', providerId: 'xd', model: 'b', agentDeviceId: 'mac-2' },
    { agentKind: 'pi', providerId: 'xd', model: 'off', off: true },
    { agentKind: 'pi', providerId: 'xd', model: 'c' },
  ],
};
const night: ModelGroupRoute = { id: 'n', name: 'Night', strategy: 'order', candidates: [{ agentKind: 'pi', providerId: 'xd', model: 'n1' }] };
const config: ModelGroupsConfig = { routes: [group] };
// Local 10:00; the hours exception below covers it.
const NOW = new Date(2026, 10, 20, 10).getTime();

const view = (chain: BotModelRoute[]) => chain.map((route) => [route.model, route.agentDeviceId ?? null, route.modelGroup ?? null, route.effort]);

describe('model groups in a companion model chain', () => {
  const saved = [plain('z', { modelGroup: 'g' }), plain('d'), plain('e'), plain('f'), plain('g2'), plain('h')];
  const expanded = expandBotModelGroups(saved, config, NOW);

  it('expands a group into its enabled sources, then the saved model; keeps location and effort; never cut at five', () => {
    expect(view(expanded)).toEqual([
      ['a', null, 'g', 'high'], ['b', 'mac-2', 'g', 'high'], ['c', null, 'g', 'high'], ['z', null, 'g', ''],
      ['d', null, null, ''], ['e', null, null, ''], ['f', null, null, ''], ['g2', null, null, ''], ['h', null, null, ''],
    ]);
  });

  it.each([
    { from: 'b', visited: [], next: 'c' },
    // The group's pick may start anywhere: the rest of the group, wrapping round, before the backups.
    { from: 'c', visited: [], next: 'z' },
    { from: 'z', visited: [], next: 'a' },
    { from: 'c', visited: ['a', 'b', 'z'], next: 'd' },
    { from: 'h', visited: [], next: null },
  ])('after $from (tried $visited) the next source is $next', ({ from, visited, next }) => {
    const current = expanded.find((route) => route.model === from)!;
    const keys = visited.map((model) => botModelRouteRuntimeKey(expanded.find((route) => route.model === model)!));
    expect(nextBotModelRoute(expanded, current, keys)?.model ?? null).toBe(next);
  });

  // #13206: a single saved smart route may still contain the former provider of a merged account.
  it('skips a merged local source within one smart route and keeps sources with their own accounts', () => {
    const current = plain('opus', { harness: 'claude', providerId: 'anthropic', modelGroup: 'g' });
    const primary = { agentKind: 'cc', providerId: 'anthropic', model: 'opus' } as const;
    const alias = { ...primary, providerId: 'subscription-a' };
    const backup = { agentKind: 'codex', providerId: 'openai', model: 'gpt' } as const;
    const select = (sources: ModelGroupRoute['candidates'], merged = true) => {
      const smartRoute = { ...group, strategy: 'order' as const, candidates: [primary, ...sources] };
      const routes = expandBotModelGroups(normalizeBotModelChain([current]), { routes: [smartRoute] }, NOW);
      return selectBotFallbackRoute(routes, current, [], null,
        id => merged && id === alias.providerId ? 'account-a' : undefined);
    };
    expect(select([alias, backup]).route?.providerId).toBe('openai');
    expect(select([alias])).toEqual({ route: null, routeLocked: true });
    expect(select([alias, backup], false).route?.providerId).toBe('subscription-a');
    expect(select([{ ...alias, agentDeviceId: 'mac-2' }, backup]).route?.agentDeviceId).toBe('mac-2');
  });

  it('tries the group a time-of-day exception switched to first, then the original group', () => {
    const withHours: ModelGroupsConfig = { routes: [{ ...group, exceptions: [{ when: { type: 'hours', from: 9, to: 12 }, use: { type: 'route', routeId: 'n' } }] }, night] };
    expect(view(expandBotModelGroups([plain('z', { modelGroup: 'g' })], withHours, NOW)).map(([model]) => model))
      .toEqual(['n1', 'a', 'b', 'c', 'z']);
  });

  // PR #11683 Codex review: the pick may have come from the exception's group in a window that has since ended.
  it('still tries the rest of a group a time-of-day exception can switch to after the window ends', () => {
    const g1: ModelGroupRoute = { id: 'g1', name: 'G1', strategy: 'order', candidates: [{ agentKind: 'pi', providerId: 'xd', model: 'A' }],
      exceptions: [{ when: { type: 'hours', from: 9, to: 12 }, use: { type: 'route', routeId: 'g2' } }] };
    const g2: ModelGroupRoute = { id: 'g2', name: 'G2', strategy: 'order', candidates: [
      { agentKind: 'pi', providerId: 'xd', model: 'B' }, { agentKind: 'pi', providerId: 'xd', model: 'C' }] };
    const afterWindow = new Date(2026, 10, 20, 15).getTime();
    const chain = expandBotModelGroups([plain('B', { harness: 'pi', modelGroup: 'g1' })], { routes: [g1, g2] }, afterWindow);
    expect(chain.map((route) => route.model)).toEqual(['A', 'B', 'C']);
    expect(nextBotModelRoute(chain, chain[1]!)?.model).toBe('C');
  });

  it.each([
    { name: 'a deleted group', groups: { routes: [] }, first: plain('saved') },
    { name: 'a group with every source turned off', groups: { routes: [{ ...group, candidates: group.candidates.map((item) => ({ ...item, off: true })) }] }, first: plain('saved', { modelGroup: 'g' }) },
  ])('runs the saved model for $name', ({ groups, first }) => {
    expect(expandBotModelGroups([plain('saved', { modelGroup: 'g' }), plain('d')], groups, NOW)).toEqual([first, plain('d')]);
  });

  it('leaves a chain without groups exactly as saved', () => {
    const chain = [plain('d'), plain('e', { agentDeviceId: 'mac-2', effort: 'low' })];
    expect(JSON.stringify(expandBotModelGroups(chain, config, NOW))).toBe(JSON.stringify(chain));
  });

  it('signs the rules that pick a source: none without groups, changes with the strategy or a reachable group, not with time', () => {
    const chain = [plain('z', { modelGroup: 'g' })];
    expect(botModelGroupsSignature([plain('d')], config)).toBeUndefined();
    const before = botModelGroupsSignature(chain, config);
    expect(botModelGroupsSignature(chain, { routes: [{ ...group, strategy: 'cheapest' }] })).not.toBe(before);
    const linked: ModelGroupsConfig = { routes: [{ ...group, exceptions: [{ when: { type: 'hours', from: 22, to: 6 }, use: { type: 'route', routeId: 'n' } }] }, night] };
    expect(botModelGroupsSignature(chain, { routes: [linked.routes[0]!, { ...night, strategy: 'rotate' }] }))
      .not.toBe(botModelGroupsSignature(chain, linked));
    // Unrelated groups do not re-pick this companion.
    expect(botModelGroupsSignature(chain, { routes: [group, { ...night, id: 'other' }] })).toBe(before);
  });
});
