/**
 * 测试价值
 * - 生产入口与结果：中转共享模块判断「这个网络是不是这个账号的」（sharing.ts certified 用的 sameAccount）。
 * - Bug 依据：2026-11-10 实机，国内账号的中转分享给海外账号后，海外账号列「我分享的供应商」一直 PERMISSION_DENIED：
 *   中转把另一区域的账号记为 `x:global:<ID>`，对方网络证书里是原始 `<ID>`（self-hosted-relay-plan.md §5.5）。
 * - 最小失败输入：其他账号网络 + `x:global:<同一 ID>`；反例为主人网络、ID 不同、前缀伪造。
 * - tier：unit，纯函数，无网络与磁盘。
 * - 新增回归：真实 createAgentNetSharing.handle /provider-shares/received 进入领域列表；一个访客在两个
 *   网络收到同机多个供应商时，先过滤网络，再按主机合并状态查询，避免新增副本 HTTP 扇出。
 *   最小输入是网络 B 的绑定在前、网络 A 同机两份分享；既有账号匹配函数测试覆盖不到此调用链。
 * - 实测耗时：2026-11-13 与 cluster 文件同次运行时测试体 5 ms；单独墙钟见 PR 验证记录。
 */
import { expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { emptySharingState, type SharingState } from '@cindy/device-link-sharing/repositories';
import { createAgentNetSharing, sameAccount } from '../sharing.js';

it('accepts a peer-region account only for its own network on a shared relay', () => {
  expect(sameAccount({ subject: 'abc' }, 'abc')).toBe(true);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:global:abc')).toBe(true);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:cn:abc')).toBe(true);
  // 主人自己的网络只认本区域账号；ID 不同或前缀不是区域的一律不认。
  expect(sameAccount({ subject: 'abc' }, 'x:global:abc')).toBe(false);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:global:abd')).toBe(false);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:eu:abc')).toBe(false);
});

it('filters received providers by network before querying each host once per request', async () => {
  const state: SharingState = emptySharingState();
  const person = { displayName: 'Unit person', avatarUrl: null, region: 'global' as const };
  for (const [shareId, networkId] of [['share-b', 'network-b'], ['share-a1', 'network-a'], ['share-a2', 'network-a']]) {
    state.bindings.push({ kind: 'provider-share', resourceId: shareId, networkId });
    state.shares.push({ shareId, ownerAccountId: 'owner-account', hostDeviceId: 'same-host', providerId: shareId,
      providerLabel: shareId, deviceName: 'Unit host', owner: person, status: 'active', createdAt: Date.now(),
      members: [{ memberId: 'member-' + shareId, guestKey: 'guest-account', guest: person, status: 'active',
        version: 1, deviceIds: ['visitor'], joinedAt: Date.now() }] });
  }
  let networkId = 'network-a';
  const hostStatus = vi.fn(async (_device: string, network: string) => ({ online: network === 'network-a', capabilities: ['provider-share-v1'] }));
  const sharing = createAgentNetSharing({ authenticate: async () => ({ accountId: 'guest-account', deviceId: 'visitor', networkId }),
    providers: { hostCapability: 'provider-share-v1', identityCards: {
      verify: async () => { throw new Error('No identity card on received list'); },
      inspect: async () => { throw new Error('No identity card on received list'); },
    } } }, {
    storage: { read: () => structuredClone(state), transaction: async work => work(structuredClone(state)) },
    hostStatus, now: Date.now, requests: () => [], saveRequest: async () => undefined, changed: () => undefined,
    member: async () => { throw new Error('No host proof on received list'); },
    grant: () => { throw new Error('No transport grant on received list'); },
    rootPublicKey: () => { throw new Error('Fixture authenticator owns identity'); }, remember: () => undefined,
  });
  const request = { method: 'GET', url: '/api/agent-net/sharing/provider-shares/received', headers: {} } as IncomingMessage;
  const received = await sharing.handle(request, Buffer.alloc(0)) as { shares: { shareId: string; hostOnline: boolean; hostCapable: boolean }[] };
  expect(received.shares).toMatchObject([{ shareId: 'share-a1', hostOnline: true, hostCapable: true },
    { shareId: 'share-a2', hostOnline: true, hostCapable: true }]);
  expect(hostStatus.mock.calls).toEqual([['same-host', 'network-a']]);
  networkId = 'network-b';
  expect(await sharing.handle(request, Buffer.alloc(0))).toMatchObject({ shares: [{ shareId: 'share-b', hostOnline: false, hostCapable: false }] });
  expect(hostStatus.mock.calls).toEqual([['same-host', 'network-a'], ['same-host', 'network-b']]);
});
