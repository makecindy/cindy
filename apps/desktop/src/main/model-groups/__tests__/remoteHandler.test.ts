/**
 * 测试价值
 * - 生产入口与可观察结果：handleModelGroupsRemote(被控电脑上 `model-groups:remote` 的实现)接真实的选路实例，
 *   回包经发起端真实的解析(parseModelGroupsRemoteList / parseModelGroupsRemoteResolve)——发起端看到的模式、
 *   选出的来源，以及「轮流」是否前进、说明是否写进任务记录。
 * - 规则依据：docs/product-rules/model-groups.md「在另一台电脑上开的新任务」与 §3(只有确实用上才前进)；
 *   docs/dev-rules/protocol-compatibility.md(请求与回包结构不对一律拒绝)。
 * - 现有覆盖缺口：pick.test.ts 只覆盖本机调用选路实例，不覆盖经隧道的请求解析、凭据校验与说明写入。
 * - 最小失败输入：发起端想要预览(dryRun)或指定运行位置；伪造或重复提交的凭据；说明里的原因超长；
 *   回包里路线缺了模型；那台的路线指向第三台电脑。
 * - tier：unit，真实选路实例与注入依赖。
 * - 实测耗时：单独运行约 1 秒。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import type { ModelGroupsConfig } from '../../../shared/modelGroups.js';
import { MODEL_GROUP_REMOTE_NOTE_LIMITS, parseModelGroupsRemoteList, parseModelGroupsRemoteResolve } from '../../../shared/modelGroupsRemote.js';
import { handleModelGroupsRemote } from '../remoteHandler.js';
import { createModelGroupResolver } from '../resolver.js';

const view = (id: string, name: string) => ({
  id, name, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
  models: { codex: [{ id: 'gpt', name: 'GPT-5.6', mode: 'chat', efforts: ['low', 'high'] }] },
}) as unknown as ProviderView;

const CONFIG: ModelGroupsConfig = {
  routes: [{
    id: 'r1', name: 'Daily', strategy: 'rotate',
    candidates: [{ agentKind: 'codex', providerId: 'a', model: 'gpt' }, { agentKind: 'codex', providerId: 'b', model: 'gpt' }],
  }],
};

function host() {
  const resolver = createModelGroupResolver({
    config: () => CONFIG,
    views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus')],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    quotaWindows: async () => new Map(),
    scope: () => 'owner',
    now: () => Date.UTC(2026, 10, 16),
  });
  const writeNote = vi.fn(async () => undefined);
  const resolve = vi.fn(resolver.resolve);
  const deps = { config: () => CONFIG, resolve, commit: resolver.commit, writeNote, warn: vi.fn() };
  return { deps, writeNote, resolve, call: (raw: unknown) => handleModelGroupsRemote(deps, raw) };
}

describe('model-groups:remote', () => {
  it('lists, routes and commits on the computer that runs the task', async () => {
    const pc = host();
    expect(parseModelGroupsRemoteList(await pc.call({ action: 'list' }))).toMatchObject(CONFIG);

    // 发起端带上预览或运行位置也只做真正的选路：结果一定带凭据，位置由那台自己的路线决定。
    const selection = { type: 'route', id: 'r1' };
    const first = parseModelGroupsRemoteResolve(await pc.call({ action: 'resolve', selection, dryRun: true, location: 'mac' }));
    expect(pc.resolve).toHaveBeenCalledWith({ selection });
    expect(first).toMatchObject({ outcome: 'routed', route: { providerId: 'a', model: 'gpt' }, sourceName: 'ChatGPT Pro' });
    expect(first.decisionId).toEqual(expect.any(String));

    const note = { sessionId: 's1', pluginName: 'Daily', outcome: 'routed', modelName: 'GPT-5.6 · ChatGPT Pro', effort: 'high' };
    await expect(pc.call({ action: 'commit', decisionId: first.decisionId, note })).resolves.toEqual({ committed: true });
    expect(pc.writeNote).toHaveBeenCalledExactlyOnceWith('s1', { pluginName: 'Daily', outcome: 'routed', modelName: 'GPT-5.6 · ChatGPT Pro', effort: 'high' });
    // 「轮流」在那台前进；同一凭据再交一次不算数，也不再写说明。
    await expect(pc.call({ action: 'commit', decisionId: first.decisionId, note })).resolves.toEqual({ committed: false });
    expect(parseModelGroupsRemoteResolve(await pc.call({ action: 'resolve', selection }))).toMatchObject({ route: { providerId: 'b' } });
    await expect(pc.call({ action: 'commit', decisionId: 'forged', note })).resolves.toEqual({ committed: false });
    expect(pc.writeNote).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed requests and replies instead of guessing', async () => {
    const pc = host();
    const tooLong = 'x'.repeat(MODEL_GROUP_REMOTE_NOTE_LIMITS.reason + 1);
    for (const raw of [
      null,
      { action: 'resolve' },
      { action: 'commit' },
      { action: 'commit', decisionId: 'd', note: { sessionId: 's', pluginName: 'Daily', outcome: 'kept', modelName: 'GPT', reason: tooLong } },
      { action: 'commit', decisionId: 'd', note: { sessionId: 's', pluginName: 'Daily', outcome: 'kept', modelName: 'GPT', why: 'failed' } },
      { action: 'write-config', config: CONFIG },
    ]) {
      await expect(pc.call(raw)).rejects.toThrow('[INVALID_PARAMS]');
    }

    const routed = { outcome: 'routed', groupName: 'Daily', modelName: 'GPT', sourceName: 'Pro', why: 'picked', trace: [] };
    expect(() => parseModelGroupsRemoteResolve({ ...routed, route: { agentKind: 'codex', providerId: 'a' } })).toThrow();
    expect(() => parseModelGroupsRemoteList({ routes: [] })).toThrow();
    // 运行位置按那台的说法原样带回(省略 = 那台自己)，交给那台建任务。
    expect(parseModelGroupsRemoteResolve({ ...routed, route: { agentKind: 'codex', providerId: 'a', model: 'gpt', agentDeviceId: 'gpu-box' } }))
      .toMatchObject({ route: { agentDeviceId: 'gpu-box' } });
  });
});
