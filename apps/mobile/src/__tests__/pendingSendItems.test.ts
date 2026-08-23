/**
 * 待发送气泡 → 消息流渲染项的构造。
 *
 * 这些气泡原来挂在列表 footer,消息回流时跨 footer↔data 搬家,位置会跳(空会话时被撑满高度
 * 的居中同步占位顶到屏幕中间,实测差约 18% 屏高),用户看到「气泡在中间 → 消失 → 在底部
 * 重新出现」。改成消息流项后靠两点保证连续:key 与正式消息一致(`message-${clientId}`)、
 * 已回流的 clientId 立刻不再产出气泡(避免同一句话双显)。
 */
import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  buildMobileMessageListExtraData,
  buildPendingSendItems,
  isPendingSendItemSelected,
  pendingSendItemKey,
  pendingSendSpins,
  type MobilePendingSendActions,
} from '@/session/pendingSendItems';
import type { MobileOutboxDisplayItem } from '@/session/sessionOutbox';
import type { QueuedRemoteMessage } from '@/session/types';

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
    expect(bubbleSource).toContain('maxVisibleLines={selected ? undefined : 6}');
    // 徽标与正文必须属于同一个 Pressable，点击用户直觉中的左侧状态图标也能展开条目。
    const bubblePressableStart = bubbleSource.indexOf('<Pressable\n          accessibilityHint={item.hint');
    const bubblePressableEnd = bubbleSource.indexOf('\n        </Pressable>', bubblePressableStart);
    const bubblePressable = bubbleSource.slice(bubblePressableStart, bubblePressableEnd);
    expect(bubblePressableStart).toBeGreaterThan(-1);
    expect(bubbleSource.indexOf('testID={`pendingSend.badge.${item.phase}`}')).toBeLessThan(bubblePressableStart);
    expect(bubblePressable).toContain('hitSlop={{ left: iconSize.xl + spacing.sm }}');
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
