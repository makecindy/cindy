/**
 * 测试价值
 * - 生产入口与可观察结果:`withRelayAccountOffer` / `parseRelayAccountOffers` / `parseRelayAccountJoinBoard` ——
 *   同账号的电脑和手机读写同一份账号记录,据此列出「我的中转」、登记加入申请、取回主人电脑回写的链接。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §5.4(每台主人电脑只改自己那一条;申请与链接 10 分钟后作废;
 *   回写必须是合法的分享链接,不合法就当没有回写)。
 * - 现有覆盖缺口:新增格式;Desktop / Mobile 的读写都依赖这里的合并与清理规则。
 * - 最小失败输入:另一台电脑的条目被覆盖;过期申请仍被当成待处理;回写的不是分享链接却被当成可加入。
 * - tier:unit,纯函数,无 IO。
 */
import { describe, expect, it } from 'vitest';
import {
  parseRelayAccountJoinBoard,
  parseRelayAccountOffers,
  RELAY_ACCOUNT_JOIN_TTL_MS,
  withRelayAccountOffer,
} from '../relayAccountDirectory';
import { buildRelayJoinLink } from '../selfHostedRelay';

const OWNER = 'Q'.repeat(43);
const RELAY_A = '11111111-1111-4111-8111-111111111111';
const RELAY_B = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const offer = (relayId: string) => ({
  ownerDeviceName: 'Studio', relayId, name: 'Home relay', baseUrl: 'https://relay.example.com', ownerPublicKey: OWNER, kind: 'server' as const,
});

describe('relay account directory', () => {
  it('replaces only this computer\'s offer and keeps the other computers\' offers', () => {
    const first = withRelayAccountOffer(null, 'mac', offer(RELAY_A), 1);
    const both = withRelayAccountOffer(first, 'pc', offer(RELAY_B), 2);
    const switched = withRelayAccountOffer(both, 'mac', null, 3);
    expect(parseRelayAccountOffers(both).map((item) => [item.ownerDeviceId, item.relayId])).toEqual([['mac', RELAY_A], ['pc', RELAY_B]]);
    expect(parseRelayAccountOffers(switched).map((item) => item.ownerDeviceId)).toEqual(['pc']);
    // 一条坏数据(没有主人公钥)不挡住其余的。
    expect(parseRelayAccountOffers({ v: 1, offers: { bad: { ...offer(RELAY_A), ownerPublicKey: 'x' }, pc: both.offers.pc } }))
      .toHaveLength(1);
  });

  it('drops expired requests and replies that are not a valid share link', () => {
    const now = 1_000_000;
    const link = buildRelayJoinLink({
      baseUrl: 'https://relay.example.com', code: 'A'.repeat(43), ownerPublicKey: OWNER, pairSecret: 'C'.repeat(43), app: 'cindy',
    });
    const request = { requestId: REQUEST, deviceName: 'Phone', platform: 'ios', relayId: RELAY_A, ownerDeviceId: 'mac', publicKey: OWNER };
    const board = parseRelayAccountJoinBoard({
      v: 1,
      requests: {
        phone: { ...request, createdAt: now - 1_000 },
        old: { ...request, createdAt: now - RELAY_ACCOUNT_JOIN_TTL_MS - 1 },
      },
      invites: {
        phone: { requestId: REQUEST, relayId: RELAY_A, link, expiresAt: now + 1_000 },
        forged: { requestId: REQUEST, relayId: RELAY_A, link: 'https://evil.example.com/join', expiresAt: now + 1_000 },
        gone: { requestId: REQUEST, relayId: RELAY_A, error: 'RELAY_UNAVAILABLE', expiresAt: now + 1_000 },
        // 主人电脑回的「收到」;同一条里既说收到又带了别的链接的不认。
        acked: { requestId: REQUEST, relayId: RELAY_A, pending: true, expiresAt: now + 1_000 },
        mixed: { requestId: REQUEST, relayId: RELAY_A, pending: true, link: 'https://evil.example.com/join', expiresAt: now + 1_000 },
      },
    }, now);
    expect(Object.keys(board.requests)).toEqual(['phone']);
    expect(Object.keys(board.invites)).toEqual(['phone', 'gone', 'acked']);
    expect(board.invites.phone.link).toBe(link);
    expect(board.invites.acked).toEqual({ requestId: REQUEST, relayId: RELAY_A, pending: true, expiresAt: now + 1_000 });
  });

  it('keeps a shared relay\'s sharer name and drops unknown kinds', () => {
    const shared = withRelayAccountOffer(null, 'mac', { ...offer(RELAY_A), kind: 'shared', sharedBy: 'Alice' }, 1);
    expect(parseRelayAccountOffers(shared)).toEqual([expect.objectContaining({ kind: 'shared', sharedBy: 'Alice' })]);
    expect(parseRelayAccountOffers({ v: 1, offers: { mac: { ...shared.offers.mac, kind: 'tenant' } } })).toEqual([]);
  });
});
