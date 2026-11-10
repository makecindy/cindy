/**
 * 测试价值
 * - 生产入口与结果：中转共享模块判断「这个网络是不是这个账号的」（sharing.ts certified 用的 sameAccount）。
 * - Bug 依据：2026-11-10 实机，国内账号的中转分享给海外账号后，海外账号列「我分享的供应商」一直 PERMISSION_DENIED：
 *   中转把另一区域的账号记为 `x:global:<ID>`，对方网络证书里是原始 `<ID>`（self-hosted-relay-plan.md §5.5）。
 * - 最小失败输入：其他账号网络 + `x:global:<同一 ID>`；反例为主人网络、ID 不同、前缀伪造。
 * - tier：unit，纯函数，无网络与磁盘。
 */
import { expect, it } from 'vitest';
import { sameAccount } from '../sharing.js';

it('accepts a peer-region account only for its own network on a shared relay', () => {
  expect(sameAccount({ subject: 'abc' }, 'abc')).toBe(true);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:global:abc')).toBe(true);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:cn:abc')).toBe(true);
  // 主人自己的网络只认本区域账号；ID 不同或前缀不是区域的一律不认。
  expect(sameAccount({ subject: 'abc' }, 'x:global:abc')).toBe(false);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:global:abd')).toBe(false);
  expect(sameAccount({ subject: 'abc', tenant: true }, 'x:eu:abc')).toBe(false);
});
