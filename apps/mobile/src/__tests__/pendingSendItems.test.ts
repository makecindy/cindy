/**
 * 待发送气泡 → 消息流渲染项的构造。
 *
 * 这些气泡原来挂在列表 footer,消息回流时跨 footer↔data 搬家,位置会跳(空会话时被撑满高度
 * 的居中同步占位顶到屏幕中间,实测差约 18% 屏高),用户看到「气泡在中间 → 消失 → 在底部
 * 重新出现」。改成消息流项后靠两点保证连续:key 与正式消息一致(`message-${clientId}`)、
 * 已回流的 clientId 立刻不再产出气泡(避免同一句话双显)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPendingSendItems,
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
});

describe('pending_send 渲染接线', () => {
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
    // 渲染分支存在,且 items 的联合类型里有这一支。
    expect(source).toContain("case 'pending_send':");
    expect(source).toContain('actions={actions.pendingSend}');
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
