/**
 * 测试价值
 * - 生产入口与可观察结果:`parseRelayJoinLink` / `buildRelayJoinLink` —— 扫码或粘贴的加入链接在这里变成
 *   Desktop / Mobile 要连接的中转地址与一次性加入码。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §5.1(加入链接格式)、§8(只接受 http(s)、不带账号密码,
 *   加入码不能被拼进别的参数)。
 * - 现有覆盖缺口:新增解析器;relay 包的加入流程测试只覆盖合法链接。
 * - 最小失败输入:见下方表格每一行(非 http 协议、URL 带凭据、未知 App、加入码过短、指向 /api 路径、
 *   缺主人公钥或配对秘密——旧格式链接加入不了需要设备签名的中转)。
 * - tier:unit,纯函数,无 IO。
 */
import { describe, expect, it } from 'vitest';
import { buildRelayJoinLink, parseRelayJoinLink } from '../selfHostedRelay';

const CODE = 'A'.repeat(43);
const OWNER = 'Q'.repeat(43);
const SECRET = 'C'.repeat(43);
const keys = { ownerPublicKey: OWNER, pairSecret: SECRET };
const keyQuery = `&o=${OWNER}&s=${SECRET}`;

describe('relay join links', () => {
  it('round-trips through every app scheme and the router path form', () => {
    for (const app of ['cindy', 'cindycn', 'cindydev'] as const) {
      const link = buildRelayJoinLink({ baseUrl: 'http://192.168.1.20:47820/', code: CODE, ...keys, app });
      expect(link.startsWith(`${app}://relay/join?`)).toBe(true);
      expect(parseRelayJoinLink(link)).toEqual({ baseUrl: 'http://192.168.1.20:47820', code: CODE, ...keys });
      // Expo Router native intent 只给路径部分。
      expect(parseRelayJoinLink(link.slice(link.indexOf('/relay/join')))).toEqual({
        baseUrl: 'http://192.168.1.20:47820',
        code: CODE,
        ...keys,
      });
    }
    expect(parseRelayJoinLink(buildRelayJoinLink({ baseUrl: 'https://relay.example.com/cindy', code: CODE, ...keys, app: 'cindy' })))
      .toEqual({ baseUrl: 'https://relay.example.com/cindy', code: CODE, ...keys });
  });

  it.each([
    ['non-http relay address', `cindy://relay/join?u=${encodeURIComponent('file:///etc/passwd')}&c=${CODE}${keyQuery}`],
    ['credentials embedded in the address', `cindy://relay/join?u=${encodeURIComponent('http://user:pw@10.0.0.2')}&c=${CODE}${keyQuery}`],
    ['address pointing inside the API', `cindy://relay/join?u=${encodeURIComponent('http://10.0.0.2/api/device-link')}&c=${CODE}${keyQuery}`],
    ['unknown app scheme', `evil://relay/join?u=${encodeURIComponent('http://10.0.0.2')}&c=${CODE}${keyQuery}`],
    ['join code too short', `cindy://relay/join?u=${encodeURIComponent('http://10.0.0.2')}&c=short${keyQuery}`],
    ['missing join code', `cindy://relay/join?u=${encodeURIComponent('http://10.0.0.2')}${keyQuery}`],
    ['missing owner key and pairing secret', `cindy://relay/join?u=${encodeURIComponent('http://10.0.0.2')}&c=${CODE}`],
    ['other deep link', `cindy://provider-share/join?u=${encodeURIComponent('http://10.0.0.2')}&c=${CODE}${keyQuery}`],
  ])('rejects %s', (_label, link) => {
    expect(parseRelayJoinLink(link)).toBeNull();
  });
});
