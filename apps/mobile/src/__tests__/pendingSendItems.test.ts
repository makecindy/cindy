/**
 * 待发送气泡 → 消息流渲染项的构造。
 *
 * 这些气泡原来挂在列表 footer,消息回流时跨 footer↔data 搬家,位置会跳(空会话时被撑满高度
 * 的居中同步占位顶到屏幕中间,实测差约 18% 屏高),用户看到「气泡在中间 → 消失 → 在底部
 * 重新出现」。改成消息流项后靠两点保证连续:key 与正式消息一致(`message-${clientId}`)、
 * 已回流的 clientId 立刻不再产出气泡(避免同一句话双显)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  appendPendingSendItems,
  buildMobileMessageListExtraData,
  buildPendingSendItems,
  isPendingSendItemSelected,
  mergePendingSendItems,
  pendingSendItemKey,
  pendingSendSpins,
  type MobilePendingSendActions,
} from '@/session/pendingSendItems';
import type { MobileOutboxDisplayItem } from '@/session/sessionOutbox';
import type { QueuedRemoteMessage, RemoteMessage } from '@/session/types';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import { buildMobileStreamingRenderWindow } from '@/session/messageRenderStreamingCache';
import { appendOptimisticUserMessage, projectOptimisticUserMessages, reconcileOptimisticUserMessages, type OptimisticUserMessage } from '@/session/optimisticUserMessages';

const NO_IDS: ReadonlySet<string> = new Set();
const NO_PRESENTATION: ReadonlyMap<string, { actions: MobilePendingSendActions; hint: string | null }> = new Map();

function queued(clientId: string, text = `text-${clientId}`): QueuedRemoteMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'm',
    effort: '',
    permissionMode: 'ask',
    workingDir: '/tmp',
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    createOpts: { agentKind: 'codex', workingDir: '/tmp' },
  } as unknown as QueuedRemoteMessage;
}

function outboxItem(clientId: string, overrides: Partial<MobileOutboxDisplayItem> = {}): MobileOutboxDisplayItem {
  return {
    clientId,
    text: `outbox-${clientId}`,
    quotesEncoded: false,
    attachmentCount: 0,
    uploadedCount: 0,
    thumbnails: [],
    fileCount: 0,
    failed: false,
    errorText: null,
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildPendingSendItems>[0]> = {}) {
  return buildPendingSendItems({
    queue: [],
    settling: [],
    outbox: [],
    hiddenClientIds: NO_IDS,
    sendingClientIds: NO_IDS,
    editingClientId: null,
    steeringClientIds: NO_IDS,
    presentationByClientId: NO_PRESENTATION,
    ...overrides,
  });
}

describe('appendPendingSendItems', () => {
  it.each(['text', 'image'])('replaces %s pending rows when history arrives before queue reconciliation', (kind) => {
    const pending = build({ outbox: [outboxItem('sent', kind === 'image' ? {
      text: '', attachmentCount: 1, uploadedCount: 1,
      thumbnails: [{ key: 'sent-slot-0', uri: 'file:///image.png', ossRef: null, uploading: false }],
    } : {}), outboxItem('next')] });
    const previous = { key: 'message-previous', type: 'message' };
    const delivered = { key: pendingSendItemKey('sent'), type: 'message' };
    expect(appendPendingSendItems([previous], pending)).toEqual([previous, ...pending]);
    // The history snapshot advanced, but raw-store token / pending snapshot did not.
    const during = appendPendingSendItems([previous, delivered], pending);
    expect(during).toEqual([previous, delivered, pending[1]]);
    expect(new Set(during.map((row) => row.key)).size).toBe(during.length);
    expect(appendPendingSendItems([previous, delivered], pending.slice(1))).toEqual(during);
  });

  it('retains the rendered list when no optimistic rows remain', () => {
    const rendered = [{ key: pendingSendItemKey('sent') }];
    expect(appendPendingSendItems(rendered, [])).toBe(rendered);
    expect(appendPendingSendItems(rendered, build({ queue: [queued('sent')] }))).toBe(rendered);
  });
});

describe('reply before user echo', () => {
  const sessionId = 'reply-order';
  function row(clientId: string, role: RemoteMessage['role'], seconds: number): RemoteMessage {
    return { id: clientId, clientId, sessionId, role,
      createdAt: new Date(Date.UTC(2026, 6, 30, 0, 0, seconds)).toISOString(),
      content: role === 'user' ? { text: 'Continue' } : 'Reply', toolUseId: null, agentMeta: null };
  }
  function push(message: RemoteMessage) {
    remoteSessionStore.applyRemotePush('dev', 'local-db:messages:created', { sessionId, message });
  }
  function reserve(current: readonly OptimisticUserMessage[] = [], clientId = 'sent') {
    return appendOptimisticUserMessage(current, remoteSessionStore.getMessages(sessionId), queued(clientId), sessionId);
  }
  function render(pending: ReturnType<typeof build>, slots: readonly OptimisticUserMessage[]) {
    const messages = remoteSessionStore.getMessages(sessionId);
    const echoed = new Set(messages.map((message) => message.clientId));
    return mergePendingSendItems(buildMobileMessageRenderItems(
      projectOptimisticUserMessages(messages, slots), { isSessionStreaming: true, preserveSourceOrder: true },
    ), pending, new Set(slots.map((entry) => entry.message.clientId).filter((id) => !echoed.has(id))));
  }
  afterEach(() => { remoteSessionStore.clear(); vi.useRealTimers(); });

  it('invalidates the streaming prefix when a local user introduces a new turn boundary', () => {
    const old = [row('old-user', 'user', 0), { ...row('old-thinking', 'thinking', 1), content: { text: 'Old thought' } }];
    const previous = buildMobileStreamingRenderWindow({
      cacheKey: 'en', messages: old, messageStructureToken: {},
      options: { isSessionStreaming: true, sessionId },
    });
    const slots = appendOptimisticUserMessage([], old, queued('sent'), sessionId);
    const current = [...old, { ...row('new-thinking', 'thinking', 3), content: { text: 'New thought' } }];
    const next = buildMobileStreamingRenderWindow({
      cacheKey: 'en', messages: projectOptimisticUserMessages(current, slots),
      messageStructureToken: {}, previousPrefix: previous.prefix,
      options: { isSessionStreaming: true, preserveSourceOrder: true, sessionId },
    });
    expect(next.items.map((item) => item.key)).toEqual([
      'message-old-user', 'work-old-thinking', 'message-sent', 'work-new-thinking',
    ]);
  });

  it.each(['settling', 'sending'])('keeps the %s bubble before an early reply and replaces it in place', (phase) => {
    push(row('old-user', 'user', 0));
    push(row('old-reply', 'assistant', 1));
    const slots = reserve(); // The production send path reserves BEFORE enqueue.
    const pending = build({
      settling: phase === 'settling' ? [queued('sent')] : [],
      queue: phase === 'sending' ? [queued('sent'), queued('next')] : [queued('next')],
      sendingClientIds: new Set(phase === 'sending' ? ['sent'] : []),
      outbox: [outboxItem('upload', { attachmentCount: 1, uploadedCount: 0 })],
    });
    push(row('reply', 'assistant', 3));
    const before = render(pending, slots);
    expect(before.map((item) => item.key)).toEqual([
      'message-old-user', 'message-old-reply', 'message-sent', 'message-reply', 'message-next', 'message-upload',
    ]);
    expect(before[2]).toBe(pending[0]);
    push(row('sent', 'user', 2));
    expect(render(pending, slots).map((item) => item.key)).toEqual(before.map((item) => item.key));
    expect(render(pending, slots)[2].type).toBe('message');
  });

  it.each(['2020-01-01', '2030-01-01'])('ignores a phone clock set to %s', (clock) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(clock));
    const source = queued('sent');
    source.chatMessage.createdAt = new Date().toISOString();
    const slots = appendOptimisticUserMessage([], [], source, sessionId);
    const pending = build({ settling: [source] });
    remoteSessionStore.applyRemotePush('dev', 'maker:event', {
      sessionId, persistId: 'reply', event: { type: 'text', data: { text: 'Reply', isFinal: false } },
    });
    vi.advanceTimersByTime(100);
    expect(render(pending, slots).map((item) => item.key)).toEqual(['message-sent', 'message-reply']);
    push(row('sent', 'user', 2));
    expect(render(pending, slots).map((item) => item.key)).toEqual(['message-sent', 'message-reply']);
  });

  it('separates new folded work from the previous turn before grouping', () => {
    push(row('old-user', 'user', 0));
    push({ ...row('old-thinking', 'thinking', 1), content: { text: 'Old thought' } });
    const slots = reserve();
    push({ ...row('thinking', 'thinking', 3), content: { text: 'New thought' } });
    const items = render(build({ settling: [queued('sent')] }), slots);
    expect(items.map((item) => item.key)).toEqual([
      'message-old-user', 'work-old-thinking', 'message-sent', 'work-thinking',
    ]);
  });

  it.each(['image', 'synthetic'])('retains the reserved %s bubble before reply grouping', (kind) => {
    const source = queued('sent', kind === 'synthetic' ? '[UI_ACTION_TRIGGER] hidden action' : '');
    if (kind === 'image') source.chatMessage.images = [{ url: 'https://example.com/image.png', name: 'image.png' }];
    const slots = appendOptimisticUserMessage([], [], source, sessionId);
    push(row('reply', 'assistant', 3));
    const pending = build({ settling: [source] });
    const items = render(pending, slots);
    expect(items.map((item) => item.key)).toEqual(['message-sent', 'message-reply']);
    expect(items[0]).toBe(pending[0]);
    expect(JSON.stringify(items[0])).not.toContain('hidden action');
  });

  it.each(['sent', 'second'])('keeps two reserved positions when %s echoes first', (firstEcho) => {
    let slots = reserve();
    push(row('reply', 'assistant', 3));
    slots = reserve(slots, 'second');
    push(row('second-reply', 'assistant', 5));
    let pending = build({ settling: [queued('sent'), queued('second')] });
    const expected = ['message-sent', 'message-reply', 'message-second', 'message-second-reply'];
    expect(render(pending, slots).map((item) => item.key)).toEqual(expected);
    push(row(firstEcho, 'user', firstEcho === 'sent' ? 2 : 4));
    expect(render(pending, slots).map((item) => item.key)).toEqual(expected);
    pending = pending.filter((item) => item.clientId !== firstEcho);
    slots = reconcileOptimisticUserMessages(slots, remoteSessionStore.getMessages(sessionId),
      new Set(pending.map((item) => item.clientId)), new Set([firstEcho]));
    expect(render(pending, slots).map((item) => item.key)).toEqual(expected);
  });

  it('keeps a busy follow-up and unsent outbox at the tail until dispatch', () => {
    push(row('current', 'user', 0));
    const pending = build({ queue: [queued('next')], sendingClientIds: new Set(['next']), outbox: [outboxItem('upload')] });
    push(row('reply', 'assistant', 3));
    expect(render(pending, []).map((item) => item.key))
      .toEqual(['message-current', 'message-reply', 'message-next', 'message-upload']);
    const slots = reserve([], 'next');
    push(row('next-reply', 'assistant', 5));
    expect(render(build({ settling: [queued('next')] }), slots).map((item) => item.key))
      .toEqual(['message-current', 'message-reply', 'message-next', 'message-next-reply']);
  });

  it('drops failed, cancelled, and rolled-back queue reservations', () => {
    const slots = reserve();
    expect(reconcileOptimisticUserMessages(slots, [], NO_IDS, NO_IDS)).toEqual([]);
    expect(reconcileOptimisticUserMessages(slots, [], new Set(['sent']), NO_IDS)).toBe(slots);
    expect(reconcileOptimisticUserMessages(slots, [row('sent', 'user', 2)], NO_IDS, NO_IDS)).toBe(slots);
    expect(reconcileOptimisticUserMessages(slots, [row('sent', 'user', 2)], NO_IDS, new Set(['sent']))).toEqual([]);
  });

  it('preserves prepended history and does not use timestamps to reanchor the send', () => {
    push(row('old-reply', 'assistant', 1));
    const slots = reserve();
    push(row('older-user', 'user', 0));
    push(row('reply', 'assistant', 3));
    expect(render(build({ settling: [queued('sent')] }), slots).map((item) => item.key))
      .toEqual(['message-older-user', 'message-old-reply', 'message-sent', 'message-reply']);
  });
});

describe('buildPendingSendItems', () => {
  it('shares the message item key so the bubble and the real message land in one place', () => {
    const [item] = build({ queue: [queued('abc')] });
    expect(item.key).toBe(pendingSendItemKey('abc'));
    expect(item.key).toBe('message-abc');
  });

  it('orders settling first, queue next, local outbox last', () => {
    const items = build({
      settling: [queued('settled')],
      queue: [queued('q1'), queued('q2')],
      outbox: [outboxItem('local')],
    });
    expect(items.map((entry) => entry.clientId)).toEqual(['settled', 'q1', 'q2', 'local']);
    expect(items.map((entry) => entry.phase)).toEqual(['settling', 'queued', 'queued', 'sending']);
  });

  it('drops anything whose real message already came back (no double bubble)', () => {
    const items = build({
      settling: [queued('done')],
      queue: [queued('live')],
      hiddenClientIds: new Set(['done']),
    });
    expect(items.map((entry) => entry.clientId)).toEqual(['live']);
  });

  it('prefers the queue entry when an item is both settling and back in the queue', () => {
    const items = build({
      settling: [queued('same')],
      queue: [queued('same')],
      presentationByClientId: new Map([['same', {
        actions: {
          remove: { disabled: false, disabledReason: null },
          edit: { disabled: false, disabledReason: null },
          steer: { disabled: false, disabledReason: null },
        },
        hint: null,
      }]]),
    });
    expect(items).toHaveLength(1);
    expect(items[0].phase).toBe('queued');
    // 回到队列的条目重新可操作(取消 / 编辑 / 插队)。
    expect(items[0].actions).not.toBeNull();
    expect(items[0].queueIndex).toBe(1);
  });

  it('marks in-flight enqueue and steering as sending, editing as editing', () => {
    const items = build({
      queue: [queued('a'), queued('b'), queued('c')],
      sendingClientIds: new Set(['a']),
      steeringClientIds: new Set(['b']),
      editingClientId: 'c',
    });
    expect(items.map((entry) => entry.phase)).toEqual(['sending', 'sending', 'editing']);
  });

  it('derives outbox phases from upload progress and failure', () => {
    const items = build({
      outbox: [
        outboxItem('uploading', { attachmentCount: 2, uploadedCount: 1 }),
        outboxItem('ready', { attachmentCount: 2, uploadedCount: 2 }),
        outboxItem('broken', { failed: true, errorText: 'boom' }),
      ],
    });
    expect(items.map((entry) => entry.phase)).toEqual(['uploading', 'sending', 'failed']);
    expect(items[2].errorText).toBe('boom');
    // 失败条目不给队列操作(它还没入队),重试 / 删除走 outbox 侧动作。
    expect(items[2].actions).toBeNull();
  });

  it('never exposes queue actions for items that left the queue', () => {
    const [settling] = build({ settling: [queued('gone')] });
    expect(settling.actions).toBeNull();
    expect(settling.queueIndex).toBeNull();
  });

  it('keeps queue atom metadata for the optimistic chip renderer', () => {
    const quote = formatQuoteForSend({ text: 'quoted context' });
    const text = `${quote}\n\n/help\n\nfull pasted payload`;
    const slashStart = text.indexOf('/help');
    const pastedStart = text.indexOf('full pasted payload');
    const queuedItem = queued('atoms', text);
    queuedItem.chatMessage.quotesEncoded = true;
    queuedItem.chatMessage.slashCommandRanges = [{ start: slashStart, end: slashStart + 5 }];
    queuedItem.chatMessage.pastedTextRanges = [{
      start: pastedStart,
      end: text.length,
      display: 'Pasted text (1 line)',
    }];

    const [item] = build({ queue: [queuedItem] });
    expect(item.sentInlineTokens.map((token) => token.kind)).toEqual([
      'quote',
      'slash',
      'text',
      'pasted',
    ]);
  });

  it('keeps outbox atom metadata while attachments are still uploading', () => {
    const text = '/help full pasted payload';
    const outbox = outboxItem('outbox-atoms', {
      text,
      quotesEncoded: false,
      slashCommandRanges: [{ start: 0, end: 5 }],
      pastedTextRanges: [{ start: 6, end: text.length, display: 'Pasted text (1 line)' }],
      attachmentCount: 1,
      uploadedCount: 0,
    });

    const [item] = build({ outbox: [outbox] });
    expect(item.phase).toBe('uploading');
    expect(item.sentInlineTokens.map((token) => token.kind)).toEqual(['slash', 'text', 'pasted']);
  });
});

describe('pending_send 渲染接线', () => {
  it('changes the list refresh signal and exposes queue actions when a bubble is selected', () => {
    const [item] = build({
      queue: [queued('selected')],
      presentationByClientId: new Map([['selected', {
        actions: {
          remove: { disabled: false, disabledReason: null },
          edit: { disabled: false, disabledReason: null },
          steer: { disabled: false, disabledReason: null },
        },
        hint: null,
      }]]),
    });
    const collapsed = buildMobileMessageListExtraData(null, false);
    const expanded = buildMobileMessageListExtraData(item.clientId, false);

    expect(expanded).not.toEqual(collapsed);
    expect(isPendingSendItemSelected(item, collapsed.pendingSendSelectedClientId)).toBe(false);
    expect(isPendingSendItemSelected(item, expanded.pendingSendSelectedClientId)).toBe(true);
  });

  it('keeps pendingSend on the renderer actions object', async () => {
    // 回归防线:MessageRenderer 的 actions 是显式组装的 useMemo。漏掉这一项时 props 和
    // 类型都还对(interface 上有、JSX 也传了),但 actions.pendingSend 是 undefined,渲染
    // 分支直接 null —— 气泡整个不画,乐观显示凭空消失(实测踩过)。
    const { readFileSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    const source = readFileSync(
      resolvePath(process.cwd(), 'src/session/MessageRenderer.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const actionsStart = source.indexOf('const actions: MessageActions');
    const actionsEnd = source.indexOf('viewportLayout.contentWidth,\n  ]);', actionsStart);
    const actionsBlock = source.slice(actionsStart, actionsEnd);
    expect(actionsBlock).toContain('pendingSend,');
    expect(source).toContain('buildMobileMessageListExtraData(');
    expect(source).toContain('extraData={messageListExtraData}');
    // 渲染分支存在,且 items 的联合类型里有这一支。
    expect(source).toContain("case 'pending_send':");
    expect(source).toContain('actions={actions.pendingSend}');
    const bubbleSource = readFileSync(
      resolvePath(process.cwd(), 'src/session/PendingSendBubble.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(bubbleSource).toContain('<SentInlineAtomBody');
    expect(bubbleSource).toContain('interactiveAtoms={false}');
    expect(bubbleSource).toContain('maxVisibleLines={collapsedLines}');
    expect(bubbleSource).toContain('LONG_USER_MESSAGE_COLLAPSED_LINES');
    // 队列操作仅由状态徽标承接，Markdown 横向滚动不嵌套在 Pressable 中。
    const badgeStart = bubbleSource.indexOf('<Pressable\n          accessibilityHint={item.hint');
    const badgeEnd = bubbleSource.indexOf('\n        </Pressable>', badgeStart);
    expect(badgeStart).toBeGreaterThan(-1);
    const badge = bubbleSource.slice(badgeStart, badgeEnd);
    expect(badge).toContain('testID={`pendingSend.badge.${item.phase}`}');
    expect(badge).toContain('actions.onSelect(selected ? null : item.clientId)');
    expect(badge).not.toContain('renderText(');
    expect(badge).toContain('badgePosition');
    expect(bubbleSource).toContain('event.nativeEvent.layout.x - 28 - spacing.sm');
    expect(bubbleSource).toContain('onLayout={hasAttachments ? undefined : measureBadgeAnchor}');
    expect(bubbleSource.indexOf('testID={`pendingSend.bubble.${item.clientId}`}')).toBeGreaterThan(badgeEnd);
    expect(bubbleSource).toContain('const collapseLatched = collapseLatchBody === displayBody;');
    expect(bubbleSource).toContain('if (collapseResolved && !collapseLatched) setCollapseLatchBody(displayBody);');
    expect(bubbleSource).toContain('(measureBody && collapseLatched) || collapseResolved');
    const actionPillStart = bubbleSource.indexOf('  actionPill: {');
    const actionPillEnd = bubbleSource.indexOf('\n  },', actionPillStart);
    const actionPillStyle = bubbleSource.slice(actionPillStart, actionPillEnd);
    expect(actionPillStart).toBeGreaterThan(-1);
    expect(actionPillStyle).toContain('minHeight: 44');
    // 粘贴时已上传到媒体总仓的图(cindy-media://blobs/…)本地没有文件,气泡要靠远端取件
    // 才有缩略图 —— 漏传 resolver 就只能画空占位格。
    expect(source).toContain('resolveRemoteMedia={actions.onResolveRemoteMedia}');
  });
});

describe('pendingSendSpins', () => {
  it('spins only while the message has not been confirmed as queued', () => {
    expect(pendingSendSpins('sending')).toBe(true);
    expect(pendingSendSpins('settling')).toBe(true);
    expect(pendingSendSpins('uploading')).toBe(true);
    expect(pendingSendSpins('queued')).toBe(false);
    expect(pendingSendSpins('editing')).toBe(false);
    expect(pendingSendSpins('failed')).toBe(false);
  });
});
