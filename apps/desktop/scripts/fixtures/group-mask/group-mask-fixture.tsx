/** Isolated test adapter: no real account, messages, runtime, storage or permissions. */
import { useEffect, useRef, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AppFrame, ctx, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupChatView } from '../../../src/renderer/features/bots/BotGroupChatView';
import { BotGroupSettingsDrawer } from '../../../src/renderer/features/bots/BotGroupSettingsDrawer';
import { refreshBotGroups } from '../../../src/renderer/features/bots/botGroupStore';
import { GroupMaskContext, type GroupMaskSettings, type GroupMaskStatus, type GroupMaskPresentation, type GroupMaskMention } from '../../../src/renderer/features/bots/groupMaskPresentation';

const groupId = 'mask-preview-group';
const self = { id: 'self', name: 'Alex', avatar: '', avatarUrl: ctx.data.selfAvatar ? 'https://avatar.example.test/self.jpg' : undefined, avatarColor: 'gray' };
const companions = [{ id: 'personal-cindy', name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', avatarColor: 'gray' },
  { id: 'personal-vela', name: 'Vela', avatar: '🦉', avatarColor: 'gray' }];
const baseTime = new Date(2026, 9, 28, 14, 30).getTime();
const person = (id: string, name: string, isSelf = false) => ({ botId: id, actorId: id, actorKind: 'human', name,
  avatar: '', avatarColor: 'gray', isSelf, isOwned: isSelf, role: isSelf ? 'member' : id === 'nana' ? 'owner' : 'member', status: 'active',
  ...(isSelf ? { avatarUrl: self.avatarUrl } : {}) });
const message = (id: string, author: 'self' | 'nana', content: string, sequence: number, extra: Record<string, unknown> = {}) => ({
  id, sequence, kind: 'message', authorKind: 'user', authorBotId: author, authorActorId: author,
  authorName: author === 'self' ? 'Alex' : 'Nana', isSelf: author === 'self', content,
  mentions: { all: false, botIds: author === 'nana' ? ['self'] : [] }, noticeCode: null, planId: null, attachments: [],
  createdAt: baseTime - (6 - sequence) * 60_000, ...extra,
});
const threadReplies = [message('reply-1', 'self', '我先把问题记下，等确认时间后再回复。', 4),
  message('reply-2', 'nana', '@Alex 好，今天确定下来就可以。', 5)];
const root = message('question', 'nana', '@Alex 社区开始迁移的时间定了吗？', 2, {
  replyCount: 2, threadPreview: { replies: threadReplies.map(m => ({ ...m, text: m.content })) },
});
let group = {
  id: groupId, name: 'Cindy 讨论', topic: '', description: '', revision: 1, serverBacked: true, singleSpeaker: true,
  replyMode: 'mentioned', speakingMode: 'auto', members: [person('self', 'Alex', true), person('nana', 'Nana'), person('lin', 'Lin'),
    { botId: 'shared', actorId: 'shared', actorKind: 'bot', name: '公共助手', avatar: 'cindy://avatar/preset/cindy', avatarColor: 'gray', isOwned: false, role: 'member', status: 'active' }],
  organizerBotId: 'shared', projectDir: null, autoContinue: false, createdAt: baseTime, updatedAt: baseTime,
  lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, plans: [],
  messages: [message('opening', 'nana', '这周把社区迁移的安排定下来，邀请说明也一起过一下。', 1), root,
    message('answer', 'self', '目前计划周五开始邀请。具体开放时间还需要确认，我先记下这件事。', 3, {
      quote: { messageId: root.id, authorName: 'Nana', authorKind: 'user', excerpt: root.content, attachmentCount: 0, attachmentName: null, sequence: 2 },
    })],
  hasMoreBefore: false, round: { status: 'idle', speakers: [], canContinue: false },
};
const listeners = new Set<(event: { groupId: string; change: string }) => void>();
function changed() { for (const notify of listeners) notify({ groupId, change: 'message' }); void refreshBotGroups(); }
let sendPresence: (() => void) | undefined;
let counter = 10;

void mountPage({
  route: `/bots/groups/${groupId}`,
  host: () => ({
    maker: {
      resolveCompanionAvatar: async () => ctx.data.selfAvatar ?? null,
      listBotGroups: async () => ({ ok: true, groups: [group] }),
      getBotGroup: async () => ({ ok: true, group: { ...group, messages: [...group.messages] } }),
      onBotGroupChanged: (listener: (event: { groupId: string; change: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      // A local echo exercises the real composer/outbox. It never leaves this Electron page.
      sendBotGroupMessage: async (input: { text: string; quote?: { messageId: string } }) => {
        sendPresence?.();
        const quoted = group.messages.find(m => m.id === input.quote?.messageId);
        const row = message(`sent-${++counter}`, 'self', input.text, counter, quoted ? {
          quote: { messageId: quoted.id, authorName: quoted.authorName, authorKind: 'user', excerpt: quoted.content, attachmentCount: 0, attachmentName: null, sequence: quoted.sequence },
        } : {});
        group.messages = [...group.messages, row]; changed(); return { ok: true, messageId: row.id };
      },
      stopBotGroupRound: forbid('stopBotGroupRound'),
      updateBotGroup: async (input: { organizerBotId?: string; projectDir?: string | null; autoContinue?: boolean }) => {
        group = { ...group, ...input }; changed(); return { ok: true };
      },
      chatServer: {
        ownedBots: async () => ({ ok: true, bots: [] }),
        manage: async ({ action }: { action: { type: string; name?: string; nickname?: string } }) => {
          const me = group.members.find(m => m.botId === 'self')!;
          if (action.type !== 'nickname' && me.role !== 'owner') return { ok: false, errorCode: 'FORBIDDEN' };
          if (action.type === 'nickname') group = { ...group, members: group.members.map(m => m.botId === 'self' ? { ...m, name: action.nickname || 'Alex' } : m) };
          else if (action.type === 'update') group = { ...group, name: action.name || group.name, revision: group.revision + 1 };
          changed(); return { ok: true };
        },
        thread: async () => ({ ok: true, root, replies: [...threadReplies], following: false, hasMore: false }),
        followThread: async (input: { following: boolean }) => ({ ok: true, following: input.following }),
        reply: async (input: { text: string }) => { sendPresence?.(); const row = message(`reply-${++counter}`, 'self', input.text, counter); threadReplies.push(row); return { ok: true, messageId: row.id }; },
        react: forbid('chatServer.react'),
      },
    },
    deviceLink: { getState: async () => ({ controlledBy: [] }), onControlledState: subscription('controlledState') },
  }),
  render: () => <Fixture />,
});

function Fixture() {
  const [settings, setSettings] = useState<GroupMaskSettings>({ companionId: ctx.case === 'unbound' ? null : companions[0].id,
    enabled: ctx.case !== 'off', trigger: ctx.case === 'manual' ? 'manual' : ctx.case === 'scheduled' ? 'scheduled' : 'always',
    start: '15:00', end: '18:00', resumeMinutes: 15, collectTodos: true, digest: 'daily' });
  const [online, setOnline] = useState(ctx.case !== 'offline');
  const [manualRunning, setManual] = useState(false);
  const [lastParticipation, setPresence] = useState<number | null>(ctx.case === 'paused' ? baseTime : null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(baseTime);
  const [saving, setSaving] = useState(false), [error, setError] = useState(ctx.case === 'error');
  const [loading, setLoading] = useState(ctx.case === 'loading');
  const [owner, setOwner] = useState(false);
  const pending = useRef<Partial<GroupMaskSettings> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const generation = useRef(0), startedAt = useRef(Date.now());
  const [attributions, setAttributions] = useState<GroupMaskPresentation['attributions']>({ answer: { self, companion: companions[0] }, 'reply-1': { self, companion: companions[0] } });
  const [unreadMentions, setUnreadMentions] = useState<GroupMaskMention[]>([
    { messageId: 'question', authorName: 'Nana', text: root.content,
      reply: { companion: companions[0], text: group.messages.find(m => m.id === 'answer')!.content } },
    { messageId: 'reply-2', threadRootId: 'question', authorName: 'Nana', text: threadReplies[1].content },
  ]);
  const status = groupMaskStatus(settings, { online, lastParticipation, manualRunning, now });
  const liveStatus = useRef(status); liveStatus.current = status;
  useEffect(() => {
    void refreshBotGroups();
    const interval = setInterval(() => setNow(baseTime + Date.now() - startedAt.current + offset), 1000);
    return () => clearInterval(interval);
  }, [offset]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); sendPresence = undefined; }, []);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLoading(false), 1200); return () => clearTimeout(timer);
  }, [loading]);
  const participate = () => { generation.current++; liveStatus.current = 'paused'; setPresence(now); };
  sendPresence = participate;
  const save = (patch: Partial<GroupMaskSettings>, retry = false) => {
    if (saving) return;
    pending.current = patch;
    if (error && !retry) return;
    setSaving(true); setError(false);
    timers.current.push(setTimeout(() => {
      setSettings(current => ({ ...current, ...patch }));
      if (patch.trigger || patch.companionId !== undefined || patch.enabled !== undefined) {
        generation.current++; setPresence(null); setManual(false);
      }
      pending.current = null; setSaving(false);
    }, 250));
  };
  const advance = () => { const next = offset + settings.resumeMinutes * 60_000; setOffset(next); setNow(baseTime + Date.now() - startedAt.current + next); };
  const request = () => {
    const row = message(`incoming-${++counter}`, 'nana', '@Alex 这件事今天可以确定吗？', counter);
    group.messages = [...group.messages, row]; changed();
    setUnreadMentions(previous => [...previous, { messageId: row.id, authorName: row.authorName, text: row.content }]);
    if (status !== 'enabled') return;
    const ticket = generation.current;
    const companion = companions.find(c => c.id === settings.companionId)!;
    timers.current.push(setTimeout(() => {
      if (ticket !== generation.current || liveStatus.current !== 'enabled') return;
      const answer = message(`stand-in-${++counter}`, 'self', '我已记下这个问题。具体时间还需要本人确认，确认后再回复。', counter);
      setAttributions(previous => ({ ...previous, [answer.id]: { self, companion } }));
      group.messages = [...group.messages, answer]; changed();
      setUnreadMentions(previous => previous.map(entry => entry.messageId === row.id
        ? { ...entry, reply: { companion, text: answer.content } } : entry));
    }, 1200));
  };
  const value: GroupMaskPresentation = { groupId, self, companions, settings, status, saving, loading, error, update: save,
    retry: () => save(pending.current ?? {}, true), participate,
    resume: () => { generation.current++; setPresence(null); setManual(true); },
    stopManual: () => { generation.current++; setManual(false); setPresence(null); }, manualRunning, attributions, unreadMentions,
    markMentionsRead: ids => setUnreadMentions(previous => ids ? previous.filter(entry => !ids.includes(entry.messageId)) : []) };
  return <GroupMaskContext.Provider value={value}>
    <div className="flex h-screen min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border-default)] px-4 py-2 text-12 text-[var(--text-secondary)]" data-testid="mask-preview-controls">
        <span>测试版 · 示例群，不发送真实消息</span>
        <button type="button" onClick={request}>模拟 @ 我</button>
        <button type="button" onClick={advance}>模拟离开 {settings.resumeMinutes} 分钟</button>
        <button type="button" onClick={() => setOnline(v => !v)}>{online ? '模拟离线' : '恢复在线'}</button>
        <button type="button" onClick={() => { const next = !owner; setOwner(next); group = { ...group, members: group.members.map(m => m.botId === 'self' ? { ...m, role: next ? 'owner' : 'member' } : m) }; changed(); }}>{owner ? '群主视角' : '普通成员视角'}</button>
        <span className="ml-auto tabular-nums">{new Date(now).toLocaleTimeString(ctx.locale, { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div className="min-h-0 flex-1 [&_[data-ui-frame=window]]:h-full"><AppFrame><Routes><Route path="/bots/groups/:groupId" element={<BotGroupChatView />} /></Routes></AppFrame></div>
      <BotGroupSettingsDrawer />
    </div>
  </GroupMaskContext.Provider>;
}

/** Fixture-only simulation; production status comes from Chat Server. */
function groupMaskStatus(settings: GroupMaskSettings, runtime: {
  online: boolean; lastParticipation: number | null; manualRunning: boolean; now: number;
}): GroupMaskStatus {
  if (!settings.companionId) return 'unbound';
  if (!settings.enabled) return 'off';
  if (!runtime.online) return 'offline';
  if (runtime.lastParticipation !== null && (settings.trigger !== 'always'
    || runtime.now - runtime.lastParticipation < settings.resumeMinutes * 60_000)) return 'paused';
  if (settings.trigger === 'manual') return runtime.manualRunning ? 'enabled' : 'waiting';
  if (settings.trigger === 'scheduled') {
    const minutes = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
    const start = minutes(settings.start), end = minutes(settings.end), date = new Date(runtime.now);
    const now = date.getHours() * 60 + date.getMinutes();
    return (start < end ? now >= start && now < end : start > end && (now >= start || now < end)) ? 'enabled' : 'waiting';
  }
  return 'enabled';
}
