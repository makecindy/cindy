/**
 * 测试价值
 * - 生产入口与结果：clientAddressOf / trustedProxies，即中转限流按哪个客户端地址计数。
 * - Bug 依据：2026-11-26 cooker02 生成分享链接 429。官方中转经负载均衡回源后所有用户按负载均衡地址合并限流；
 *   本仓自建中转副本则完全不读回环 ingress 追加的客户端，所有访客按 127.0.0.1 合并。
 * - 覆盖缺口：集成测试只能从回环发请求，测不到「对端是负载均衡内网地址」与「对端不可信」。新模块的纯函数单测，
 *   与本包其他 unit 文件（身份、分享账号、CLI）的被测模块无关，所以单独成文件。
 * - 最小失败输入：对端 10.1.2.3（已配置为可信代理）+ X-Forwarded-For「伪造项, 真实客户端」。
 * - tier：unit，纯函数，无网络与磁盘。实测耗时见 PR 验证记录。
 */
import { expect, it } from 'vitest';
import { clientAddressOf, trustedProxies } from '../clientAddress.js';

it('attributes a request to the client a trusted proxy appended, never to entries the client wrote', () => {
  const trusted = trustedProxies(['10.0.0.0/8']);
  expect(clientAddressOf('10.1.2.3', '203.0.113.50, 198.51.100.7', trusted)).toBe('198.51.100.7');
  expect(clientAddressOf('::ffff:10.1.2.3', '198.51.100.7', trusted)).toBe('198.51.100.7');
  // A local proxy in front of the balancer: both hops are skipped.
  expect(clientAddressOf('127.0.0.1', '198.51.100.7, 10.0.0.9', trusted)).toBe('198.51.100.7');
  // A peer that is not a trusted proxy is the client, whatever it claims.
  expect(clientAddressOf('203.0.113.9', '198.51.100.7', trusted)).toBe('203.0.113.9');
  // Unconfigured: a balancer is the client, while a loopback ingress is still believed.
  expect(clientAddressOf('10.1.2.3', '198.51.100.7', trustedProxies())).toBe('10.1.2.3');
  expect(clientAddressOf('::1', '198.51.100.7', trustedProxies())).toBe('198.51.100.7');
  // Nothing usable appended: count the proxy itself.
  expect(clientAddressOf('10.1.2.3', 'not-an-ip', trusted)).toBe('10.1.2.3');
  expect(clientAddressOf('10.1.2.3', undefined, trusted)).toBe('10.1.2.3');
});

it('rejects proxy entries that are not an address or a valid CIDR', () => {
  for (const entry of ['alb.example.test', '10.0.0.0/33', '::/129', '10.0.0.0/8/1', '10.0.0.0/x', ''])
    expect(() => trustedProxies([entry]), entry).toThrow('INVALID_TRUSTED_PROXY');
  expect(() => trustedProxies(['192.0.2.7', 'fd00::/8'])).not.toThrow();
});
