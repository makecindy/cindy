/**
 * 测试价值：收件箱把每个伙伴的主对话当成一行，分区取决于这里解析出的状态与稍后处理。
 * 规则：docs/product-rules/task-inbox.md「伙伴主对话」（2026-11-20 用户决定）。
 * 覆盖缺口：伙伴段把离线电脑显示为出错，收件箱沿用会让离线电脑上的伙伴全部进待处理；
 * 旧电脑不下发稍后处理字段时不能提供该操作。
 * 最小失败输入：一个离线且已读的远程伙伴；一个没有主对话或缺字段的伙伴。unit。
 */
import { expect, it } from 'vitest';

import type { BotProfile } from '../botStore';
import type { RemoteBot } from '../remoteBotRoster';
import { teammateInboxSection } from '@cindy/maker-shared/live-task-priority';
import { teammateInboxEntries } from '../teammateInbox';

const now = Date.parse('2026-11-20T08:00:00Z');
const local = (id: string, extra: Partial<BotProfile> = {}) => ({
  id, name: id, status: 'active', createdAt: 1, sessions: [{ id: `chat-${id}`, role: 'canonical', kind: 'chat', title: '', updatedAt: 1 }],
  ...extra,
}) as BotProfile;
const remote = (id: string, extra: Partial<RemoteBot> = {}): RemoteBot => ({
  id, deviceId: 'studio', deviceName: 'Studio', name: id, avatar: '', avatarColor: '', description: '', preview: '',
  activityAt: 5, sessionId: `chat-${id}`, online: true, connectionKnown: true, ...extra,
});
const entries = (bots: BotProfile[], remoteBots: RemoteBot[], unreadByBotId: Record<string, number> = {}) =>
  teammateInboxEntries({ bots, remoteBots, unreadByBotId, activities: new Map(), devices: [] });
const sections = (list: ReturnType<typeof entries>) =>
  Object.fromEntries(list.map((entry) => [entry.bot.id, teammateInboxSection(entry.status, entry.snooze, now)]));

it('lists a teammate by its turn and leaves idle, hidden and archived ones to the teammate section', () => {
  const list = entries([
    local('unread'), local('idle'), local('failed', { needsAttention: true }),
    local('hidden', { hiddenAt: 1 }), local('archived', { status: 'archived' }),
  ], [remote('working', { generation: { phase: 'processing', startedAt: 1 } }),
    remote('asks', { teammateActivity: { phase: 'needs-interaction' } })], { unread: 2, hidden: 1, archived: 1 });
  expect(sections(list)).toEqual({ unread: 'inbox', idle: null, failed: 'inbox', working: 'working', asks: 'inbox' });
  expect(list.find((entry) => entry.bot.id === 'working')).toMatchObject({
    key: 'teammate:studio:working', route: '/bots/remote/studio/working', deviceLabel: 'Studio' });
});

it('does not treat an unreachable computer as a request, only what its teammate left unread', () => {
  const list = entries([], [remote('read', { online: false }), remote('unread', { online: false, lastReplyAt: 9, readAt: 3 })]);
  expect(sections(list)).toEqual({ read: null, unread: 'inbox' });
});

it('snoozes only a conversation whose computer mirrors the snooze, and wakes it on new input', () => {
  const snoozed = { snoozedUntil: new Date(now + 60_000).toISOString(), snoozedAt: new Date(now - 1).toISOString(), userSendAt: null };
  const list = entries([
    local('snoozed', { inboxSnooze: snoozed }),
    local('woken', { inboxSnooze: { ...snoozed, userSendAt: new Date(now).toISOString() } }),
    local('no-chat', { sessions: [], inboxSnooze: snoozed }),
  ], [remote('older-host')], { snoozed: 1, woken: 1 });
  expect(sections(list)).toMatchObject({ snoozed: 'snoozed', woken: 'inbox', 'no-chat': null });
  expect(Object.fromEntries(list.map((entry) => [entry.bot.id, entry.snooze !== null])))
    .toEqual({ snoozed: true, woken: true, 'no-chat': false, 'older-host': false });
});
