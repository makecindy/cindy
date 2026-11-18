/**
 * 测试价值
 * - 生产入口与可观察结果：AgentNetMembership（Desktop 与 Node Host 共用），交给 Agent-Net 连接的规则与读设备列表的次数。
 * - Bug／规则依据：Device Link 里删掉的设备要重新登录才能再连；官方 Agent-Net 不看那条删除记录，被删的电脑照样能经
 *   Agent-Net 建会话（docs/dev-rules/protocol-compatibility/agent-net-device-removal.md）。
 * - 现有覆盖缺口：新模块。连接层只认规则（socket.integration.test.ts），规则怎么来、多久读一次列表没有覆盖。
 * - 最小失败输入：名册里有、列表里没有的设备；本机刚删的设备和删除前开始读的列表；读失败；一直掉线重连的被删设备；
 *   别的电脑上删掉的设备（这台没有任何通知，2026-11-17 review：原来名册不变就永远不再读）；第一次读失败后的退避重试。
 * - tier：unit，假时钟，读列表用注入的端口。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PeerRule } from '@cindy/agent-net';
import { AgentNetMembership, MEMBERSHIP_PERIODIC_MS, MEMBERSHIP_READ_MIN_INTERVAL_MS, MEMBERSHIP_RECHECK_INTERVAL_MS,
  MEMBERSHIP_RETRY_FIRST_MS } from '@cindy/agent-net';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

function setup(lists: Array<readonly string[] | null | Error>, connection: { active: boolean } = { active: true }) {
  const applied: PeerRule[] = [];
  const reads = vi.fn(async () => {
    const next = lists.length > 1 ? lists.shift()! : lists[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const membership = new AgentNetMembership({ readDeviceLinkDeviceIds: reads, apply: (rule) => { applied.push(rule); },
    active: () => connection.active, random: () => 0.5 });
  return { membership, reads, applied };
}
const members = (...ids: string[]) => ids.map((deviceId) => ({ deviceId, online: true }));
const accepts = (rule: PeerRule, id: string) => !rule.refused.includes(id) && (rule.allowed === null || rule.allowed.includes(id));

it('refuses a directory member missing from the device list and lets it back once a later list has it', async () => {
  const { membership, reads, applied } = setup([['self', 'kept'], ['self', 'kept', 'back']]);
  expect(membership.rule()).toEqual({ allowed: null, refused: [] });
  membership.noteDirectory(members('self', 'kept', 'back'));
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(membership.hasDeviceList()).toBe(true));
  expect(accepts(applied.at(-1)!, 'back')).toBe(false);
  expect([...membership.excluded()]).toEqual(['back']);
  // Directory updates of known members do not read again; a new unlisted member waits for the interval.
  membership.noteDirectory(members('self', 'kept', 'back'));
  membership.noteDirectory(members('self', 'kept', 'back', 'new'));
  expect(reads).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_READ_MIN_INTERVAL_MS);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(accepts(membership.rule(), 'back')).toBe(true);
  expect(accepts(membership.rule(), 'new')).toBe(false);
});

it('refuses a device removed here at once, and only a list read started after the removal can let it back', async () => {
  const { membership } = setup([['self', 'gone']]);
  membership.noteDeviceList(['self', 'gone'], Date.now());
  vi.advanceTimersByTime(5);
  membership.noteRemoved('gone');
  expect(accepts(membership.rule(), 'gone')).toBe(false);
  membership.noteDeviceList(['self', 'gone'], Date.now() - 1);
  expect(accepts(membership.rule(), 'gone')).toBe(false);
  vi.advanceTimersByTime(5);
  membership.noteDeviceList(['self', 'gone'], Date.now());
  expect(accepts(membership.rule(), 'gone')).toBe(true);
});

it('keeps the previous rule when the list cannot be read, and accepts everyone before any list', async () => {
  const { membership } = setup([new Error('offline')]);
  membership.noteDirectory(members('self', 'other'));
  await membership.refresh();
  expect(membership.hasDeviceList()).toBe(false);
  expect(membership.rule().allowed).toBeNull();
  membership.noteDeviceList(['self']);
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_READ_MIN_INTERVAL_MS);
  await membership.refresh();
  expect(membership.rule().allowed).toEqual(['self']);
});

it('rechecks a refused device that keeps coming back online at most once a minute', async () => {
  // Only the directory-driven rechecks here; the background reads while connected are covered below.
  const { membership, reads } = setup([['self']], { active: false });
  membership.noteDeviceList(['self']);
  membership.noteDirectory(members('self', 'gone'));
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_READ_MIN_INTERVAL_MS);
  const before = reads.mock.calls.length;
  for (let i = 0; i < 20; i++) {
    membership.noteDirectory([{ deviceId: 'self', online: true }, { deviceId: 'gone', online: false }]);
    membership.noteDirectory(members('self', 'gone'));
    await vi.advanceTimersByTimeAsync(3_000);
  }
  expect(reads.mock.calls.length - before).toBeLessThanOrEqual(Math.ceil(60_000 / MEMBERSHIP_RECHECK_INTERVAL_MS) + 1);
  expect(accepts(membership.rule(), 'gone')).toBe(false);
});

it('keeps reading in the background while connected, so a device removed on another computer is refused, and stops when not', async () => {
  const connection = { active: true };
  const { membership, reads } = setup([['self', 'other'], ['self']], connection);
  membership.noteDirectory(members('self', 'other'));
  await vi.waitFor(() => expect(membership.hasDeviceList()).toBe(true));
  expect(accepts(membership.rule(), 'other')).toBe(true);
  // Removed on another computer: nothing tells this one, the directory does not change.
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_PERIODIC_MS);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(accepts(membership.rule(), 'other')).toBe(false);
  connection.active = false;
  await vi.advanceTimersByTimeAsync(6 * MEMBERSHIP_PERIODIC_MS);
  expect(reads).toHaveBeenCalledTimes(2);
});

it('retries a failed first read with backoff instead of waiting for the periodic interval', async () => {
  const { membership, reads } = setup([new Error('offline'), new Error('offline'), ['self']]);
  await membership.prime();
  expect(membership.hasDeviceList()).toBe(false);
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_RETRY_FIRST_MS);
  expect(reads).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2 * MEMBERSHIP_RETRY_FIRST_MS);
  expect(reads).toHaveBeenCalledTimes(3);
  expect(membership.rule().allowed).toEqual(['self']);
  // Read: back to the periodic interval.
  await vi.advanceTimersByTimeAsync(MEMBERSHIP_PERIODIC_MS / 2);
  expect(reads).toHaveBeenCalledTimes(3);
});
