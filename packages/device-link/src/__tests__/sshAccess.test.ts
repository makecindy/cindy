import { describe, expect, it } from 'vitest';
import {
  REMOTE_INVOKE_ALLOWLIST,
  SSH_ACCESS_ANNOUNCE_CHANNEL,
  SSH_ACCESS_CHANNEL,
  SSH_ACCESS_EXAMPLES,
  isSshAccessHost,
  isUnlinkedPushChannel,
  parseSshAccessAnnounce,
  parseSshAccessRequest,
  parseSshAccessStatus,
  parseSshEd25519PublicKey,
  resolveInvokePriority,
  sshAccessErrorCode,
} from '../index.js';

// 测试价值
// - 生产入口与可观察结果：sshAccess.ts 的四个 parser（目标端与控制端各自调用）、allowlist / invokePolicy / client 的
//   通道登记。断言共享的有效 / 无效样例逐条得到约定的解析结果或 null，以及 invoke 只走白名单 + 后台优先级、announce 不需要
//   控制链路。
// - Bug／规则依据：protocol-compatibility.md §1「两端用相同的有效／无效 fixture」；device-link-ssh-access.md 的字段约定；
//   控制端会把 endpoint 写进 SSH config，换行或空格注入必须被丢弃。
// - 现有覆盖缺口：新通道，此前没有任何解析或登记测试。
// - 最小失败输入：`from="…" ssh-ed25519 …`（带 options）、多行 key、`user: 'root\nHost *'`、未知 blocked 值。
// - tier：unit（纯函数表驱动，无 I/O，单文件 <1s）。
describe('SSH access wire protocol', () => {
  it('parses every shared valid example to its expected value and rejects every invalid one', () => {
    for (const row of SSH_ACCESS_EXAMPLES.publicKey.valid) expect(parseSshEd25519PublicKey(row.input), row.input).toEqual(row.expected);
    for (const input of SSH_ACCESS_EXAMPLES.publicKey.invalid) expect(parseSshEd25519PublicKey(input), JSON.stringify(input)).toBeNull();
    for (const row of SSH_ACCESS_EXAMPLES.request.valid) expect(parseSshAccessRequest(row.input)).toEqual(row.expected);
    for (const input of SSH_ACCESS_EXAMPLES.request.invalid) expect(parseSshAccessRequest(input), JSON.stringify(input)).toBeNull();
    for (const row of SSH_ACCESS_EXAMPLES.status.valid) expect(parseSshAccessStatus(row.input)).toEqual(row.expected);
    for (const input of SSH_ACCESS_EXAMPLES.status.invalid) expect(parseSshAccessStatus(input), JSON.stringify(input)).toBeNull();
    for (const row of SSH_ACCESS_EXAMPLES.announce.valid) expect(parseSshAccessAnnounce(row.input)).toEqual(row.expected);
    for (const input of SSH_ACCESS_EXAMPLES.announce.invalid) expect(parseSshAccessAnnounce(input), JSON.stringify(input)).toBeNull();
  });

  it('accepts only host names and addresses that cannot carry SSH config syntax', () => {
    for (const host of ['10.0.0.5', '203.0.113.7', 'fd00::5', '2001:db8::1', 'studio.local', 'host-1.example.com.'])
      expect(isSshAccessHost(host), host).toBe(true);
    for (const host of ['', 'a b', 'a.local\nHostName x', '-bad.example', '999.1.1.1', 'fe80::1%en0', 'x'.repeat(254), '1.2.3'])
      expect(isSshAccessHost(host), JSON.stringify(host)).toBe(false);
  });

  it('reads only the defined SSH access error codes out of an IPC error message', () => {
    expect(sshAccessErrorCode('[SSH_ACCESS_KEY_IN_USE] key belongs to another device')).toBe('SSH_ACCESS_KEY_IN_USE');
    expect(sshAccessErrorCode('[SSH_ACCESS_SOMETHING_NEW] x')).toBeNull();
    expect(sshAccessErrorCode('[AGENT_NET_SWITCH_BUSY] x')).toBeNull();
    expect(sshAccessErrorCode(undefined)).toBeNull();
  });

  // 协议契约：通道必须在白名单里(否则新被控端也只回 CHANNEL_NOT_ALLOWED)，后台优先级(登记不能挤占用户正在等的请求)，
  // announce 不需要控制链路(否则控制端没开过远程控制就永远收不到)。
  it('registers the invoke as an allowlisted background request and the announce as a link-free push', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(SSH_ACCESS_CHANNEL)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(SSH_ACCESS_ANNOUNCE_CHANNEL)).toBe(false);
    expect(resolveInvokePriority(SSH_ACCESS_CHANNEL, undefined, [{ action: 'enroll' }])).toBe('background');
    expect(isUnlinkedPushChannel(SSH_ACCESS_ANNOUNCE_CHANNEL)).toBe(true);
    expect(isUnlinkedPushChannel(SSH_ACCESS_CHANNEL)).toBe(false);
  });
});
