/**
 * 组内电脑的运行数(provider-groups.md §5、§10)：分享来的电脑报来本账号在那台实际跑着几个(含不经组直接用的)，
 * 设置页与分配用同一个数，取它与经组计数中较大的。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupBinding } from '../bindings';
import type { ProviderGroupDirectory, ResolvedProviderGroupMember } from '../directory';
import { createProviderGroupRouter } from '../router';

const MODEL = 'claude-opus-5-5';

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null, limit = 4): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const SHARE_A = member('share:a:anthropic', 'share', 'share:a', 2);
const SHARE_B = member('share:b:anthropic', 'share', 'share:b');

function harness(reported: Record<string, number>, bindings: Record<string, ProviderGroupBinding> = {}, running: string[] = []) {
  const config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [SHARE_A, SHARE_B, LOCAL] };
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => ({
        member: m,
        label: m.key,
        state: 'ok',
        view: view(m.providerId),
        ...(reported[m.key] !== undefined ? { reportedRunning: reported[m.key] } : {}),
      }));
    },
    async listCandidates() {
      return [];
    },
    async readDeviceCatalog() {
      return [];
    },
    async probe() {
      return 'ok' as const;
    },
    memberLabel: (m) => m.key,
    invalidate: () => undefined,
  };
  return createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => bindings,
    isTurnRunning: (sessionId) => running.includes(sessionId),
    now: () => 1_000,
    random: () => 0,
  });
}

describe('provider group running count', () => {
  it('shows what a shared computer reports for this account, including tasks that did not go through the group', async () => {
    const router = harness({ [SHARE_A.key]: 2, [SHARE_B.key]: 1 });
    const members = (await router.view('anthropic')).members;
    expect(members.map((m) => [m.key, m.running, m.state])).toEqual([
      [SHARE_A.key, 2, 'full'],
      [SHARE_B.key, 1, 'available'],
      [LOCAL.key, 0, 'available'],
    ]);
  });

  it('keeps counting tasks the group assigned that the report does not include yet', async () => {
    const router = harness(
      { [SHARE_B.key]: 0 },
      { t1: { providerId: 'anthropic', memberKey: SHARE_B.key, at: 1 } },
      ['t1'],
    );
    const shareB = (await router.view('anthropic')).members.find((m) => m.key === SHARE_B.key);
    expect(shareB?.running).toBe(1);
  });

  it('assigns new tasks by the same count the settings page shows', async () => {
    // 两台分享来的电脑经组都没分过任务，但 A 上本账号已经直接跑着 1 个：最少占用选本机或 B，不选 A。
    const router = harness({ [SHARE_A.key]: 1, [SHARE_B.key]: 0 }, {}, []);
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL });
    expect(pick).toMatchObject({ kind: 'member', member: { key: SHARE_B.key } });
  });
});
