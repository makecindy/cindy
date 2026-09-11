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
  reconcilePendingSendOrder,
  type PendingSendOrder,
  pendingSendItemKey,
  pendingSendSpins,
  type MobilePendingSendActions,
} from '@/session/pendingSendItems';
import type { MobileOutboxDisplayItem } from '@/session/sessionOutbox';
import type { QueuedRemoteMessage, RemoteMessage } from '@/session/types';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';

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
  const userSendAt = '2026-07-30T00:00:02.000Z';
  function row(clientId: string, role: RemoteMessage['role'], createdAt: string): RemoteMessage {
    return { id: clientId, clientId, sessionId, role, createdAt,
      content: role === 'user' ? { text: 'Continue' } : 'Reply', toolUseId: null, agentMeta: null };
  }
  function push(message: RemoteMessage) {
    remoteSessionStore.applyRemotePush('dev', 'local-db:messages:created', { sessionId, message });
  }
  function render(
    pending: ReturnType<typeof build>,
    boundary: string | null = userSendAt,
    baselines: ReadonlyMap<string, string | null> = new Map([['sent', '2026-07-30T00:00:00.000Z']]),
  ) {
    return mergePendingSendItems(buildMobileMessageRenderItems(
      remoteSessionStore.getMessages(sessionId), { isSessionStreaming: true },
    ), pending, boundary, new Map([...baselines].map(([id, baseline]) => [id, { baseline }])));
  }
  afterEach(() => { remoteSessionStore.clear(); vi.useRealTimers(); });

  it.each(['settling', 'sending'])('keeps the %s bubble before an early reply and replaces it in place', (phase) => {
    push(row('old-user', 'user', '2026-07-30T00:00:00.000Z'));
    push(row('old-reply', 'assistant', '2026-07-30T00:00:01.000Z'));
    const pending = build({
      settling: phase === 'settling' ? [queued('sent')] : [],
      queue: phase === 'sending' ? [queued('sent'), queued('next')] : [queued('next')],
      sendingClientIds: new Set(phase === 'sending' ? ['sent'] : []),
      outbox: [outboxItem('upload', { attachmentCount: 1, uploadedCount: 0 })],
    });
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const before = render(pending);
    expect(before.map((item) => item.key)).toEqual([
      'message-old-user', 'message-old-reply', 'message-sent', 'message-reply', 'message-next', 'message-upload',
    ]);
    expect(before[2]).toBe(pending[0]);
    push(row('sent', 'user', userSendAt));
    // Deliberately keep the stale pending snapshot: no duplicate or position change.
    expect(render(pending).map((item) => item.key)).toEqual(before.map((item) => item.key));
    expect(render(pending)[2].type).toBe('message');
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    expect(render(pending).map((item) => item.key)).toEqual(before.map((item) => item.key));
  });

  it('keeps streaming deltas behind the pending user without consulting the phone clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01'));
    const pending = build({ settling: [queued('sent')] });
    remoteSessionStore.applyRemotePush('dev', 'maker:event', {
      sessionId, persistId: 'reply', event: { type: 'text', data: { text: 'Reply', isFinal: false } },
    });
    vi.advanceTimersByTime(100);
    expect(render(pending).map((item) => item.key)).toEqual(['message-sent', 'message-reply']);
    push(row('sent', 'user', userSendAt));
    expect(render(pending).map((item) => item.key)).toEqual(['message-sent', 'message-reply']);
  });

  it('places the boundary before folded work, not just before reply text', () => {
    push(row('old-user', 'user', '2026-07-30T00:00:00.000Z'));
    push(row('old-reply', 'assistant', '2026-07-30T00:00:01.000Z'));
    push({ ...row('thinking', 'thinking', userSendAt), content: { text: 'Thinking' } });
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const items = render(build({ settling: [queued('sent')] }));
    const work = items.find((item) => item.type === 'work_group');
    expect(work?.startedAtMs).toBeLessThan(Date.parse(userSendAt));
    expect(items[2].key).toBe('message-sent');
    expect(items[3]).toBe(work);
    expect(items.at(-1)?.key).toBe('message-reply');
  });

  it('skips a foreign settling item without blocking the matching local send', () => {
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const pending = build({ settling: [queued('foreign'), queued('sent')] });
    expect(render(pending).map((item) => item.key))
      .toEqual(['message-sent', 'message-reply', 'message-foreign']);
  });

  it.each(['first', 'second'])('keeps both turn positions when the %s echo arrives first', (firstEcho) => {
    const secondBoundary = '2026-07-30T00:00:04.000Z';
    let pending = build({ settling: [queued('sent'), queued('second')] });
    let order: ReadonlyMap<string, PendingSendOrder> = new Map([
      ['sent', { baseline: '2026-07-30T00:00:00.000Z' }],
      ['second', { baseline: userSendAt }],
    ]);
    const draw = (boundary = secondBoundary) => {
      order = reconcilePendingSendOrder(order, pending, boundary);
      return mergePendingSendItems(buildMobileMessageRenderItems(
        remoteSessionStore.getMessages(sessionId), { isSessionStreaming: true },
      ), pending, boundary, order).map((item) => item.key);
    };
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    push(row('second-reply', 'assistant', '2026-07-30T00:00:05.000Z'));
    const expected = ['message-sent', 'message-reply', 'message-second', 'message-second-reply'];
    expect(draw()).toEqual(expected);
    const echoedId = firstEcho === 'first' ? 'sent' : 'second';
    push(row(echoedId, 'user', echoedId === 'sent' ? userSendAt : secondBoundary));
    expect(draw()).toEqual(expected); // stale pending snapshot still deduplicates
    pending = pending.filter((item) => item.clientId !== echoedId);
    expect(draw()).toEqual(expected); // pruning the later baseline must not move the older bubble
    expect(order.has(echoedId)).toBe(false);
    expect(draw('2026-07-30T00:00:06.000Z')).toEqual(expected);
    const remaining = echoedId === 'sent' ? 'second' : 'sent';
    push(row(remaining, 'user', remaining === 'sent' ? userSendAt : secondBoundary));
    expect(draw()).toEqual(expected);
    expect(reconcilePendingSendOrder(order, [], secondBoundary).size).toBe(0);
  });

  it('pins an observed turn before a later send starts and never assigns queued work early', () => {
    let order: ReadonlyMap<string, PendingSendOrder> = new Map([['sent', { baseline: null }]]);
    let pending = build({ settling: [queued('sent')] });
    order = reconcilePendingSendOrder(order, pending, userSendAt);
    expect(order.get('sent')?.boundary).toBe(Date.parse(userSendAt));
    order = new Map([...order, ['next', { baseline: userSendAt }]]);
    pending = build({ settling: [queued('sent')], queue: [queued('next')] });
    const nextBoundary = '2026-07-30T00:00:04.000Z';
    order = reconcilePendingSendOrder(order, pending, nextBoundary);
    expect(order.get('sent')?.boundary).toBe(Date.parse(userSendAt));
    expect(order.get('next')?.boundary).toBeUndefined();
    pending = build({ settling: [queued('sent'), queued('next')] });
    order = reconcilePendingSendOrder(order, pending, nextBoundary);
    expect(order.get('next')?.boundary).toBe(Date.parse(nextBoundary));
    expect(reconcilePendingSendOrder(order, pending, nextBoundary)).toBe(order);
  });

  it('leaves a follow-up behind the current response when the current user is already visible', () => {
    push(row('current', 'user', userSendAt));
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const pending = build({ queue: [queued('next')], sendingClientIds: new Set(['next']) });
    expect(render(pending).map((item) => item.key)).toEqual(['message-current', 'message-reply', 'message-next']);
  });

  it('does not assign the same observed turn to two sends with the same baseline', () => {
    let order: ReadonlyMap<string, PendingSendOrder> = new Map([
      ['sent', { baseline: null }], ['next', { baseline: null }],
    ]);
    let pending = build({ settling: [queued('sent'), queued('next')] });
    order = reconcilePendingSendOrder(order, pending, userSendAt);
    expect(order.get('sent')?.boundary).toBe(Date.parse(userSendAt));
    expect(order.get('next')?.boundary).toBeUndefined();
    push(row('sent', 'user', userSendAt));
    pending = pending.filter((item) => item.clientId !== 'sent');
    order = reconcilePendingSendOrder(order, pending, userSendAt);
    order = reconcilePendingSendOrder(order, pending, userSendAt);
    expect(order.get('next')?.boundary).toBeUndefined();
    const secondBoundary = '2026-07-30T00:00:04.000Z';
    order = reconcilePendingSendOrder(order, pending, secondBoundary);
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    push(row('next-reply', 'assistant', '2026-07-30T00:00:05.000Z'));
    expect(mergePendingSendItems(buildMobileMessageRenderItems(
      remoteSessionStore.getMessages(sessionId), { isSessionStreaming: true },
    ), pending, secondBoundary, order).map((item) => item.key))
      .toEqual(['message-sent', 'message-reply', 'message-next', 'message-next-reply']);
  });

  it('does not promote a queued follow-up or an unsent outbox entry into the current turn', () => {
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const pending = build({ queue: [queued('next')], outbox: [outboxItem('local')] });
    expect(render(pending).map((item) => item.key)).toEqual(['message-reply', 'message-next', 'message-local']);
  });

  it('does not invent a boundary from missing or invalid host metadata', () => {
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const pending = build({ settling: [queued('sent')] });
    for (const boundary of [null, 'invalid']) {
      expect(render(pending, boundary).map((item) => item.key)).toEqual(['message-reply', 'message-sent']);
    }
  });

  it('does not mistake an unloaded old user row for the message just sent', () => {
    push(row('reply', 'assistant', '2026-07-30T00:00:03.000Z'));
    const pending = build({ queue: [queued('sent')], sendingClientIds: new Set(['sent']) });
    for (const baselines of [new Map<string, string | null>(), new Map([['sent', userSendAt]])]) {
      expect(render(pending, userSendAt, baselines).map((item) => item.key))
        .toEqual(['message-reply', 'message-sent']);
    }
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
