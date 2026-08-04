import { describe, expect, it, vi } from 'vitest';
import {
  buildQueuePanelSummary,
  buildQueueRowPresentation,
  buildQueuedTextMessage,
  createQueueEditTextState,
  isOrcaQueueItem,
  normalizeInputProjection,
  queuedMessageHasEncodedQuotes,
  queueMoveTargetIndex,
  resolveQueueEditTextSubmission,
  stopOptionsForProjection,
} from '@/session/inputProjection';
import { buildMobileUploadedAttachment } from '@/session/attachments';
import { parseAttachmentOssRef } from '@/session/attachmentOssRef';
import { textComposerDocument } from '@/session/composerDocument';
import type { RemoteSession } from '@/session/types';

const ATTACHMENT_SHA256 = 'a'.repeat(64);

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'u1',
    title: 'Session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: true,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('inputProjection', () => {
  it('builds a text-only queued message that matches the desktop coordinator payload shape', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
    const queued = buildQueuedTextMessage(session(), '  hello mobile  ', new Date(), 'q-1');

    expect(queued).toMatchObject({
      clientId: 'q-1',
      text: 'hello mobile',
      persistedContent: JSON.stringify({ text: 'hello mobile', images: [], files: [] }),
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'ask',
      workingDir: '/repo',
      chatMessage: {
        clientId: 'q-1',
        role: 'user',
        content: 'hello mobile',
        isStreaming: false,
      },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
        permissionMode: 'ask',
        fastMode: true,
        displayReasoning: 'summarized',
      },
    });
    // 新会话无 sdkSessionId / providerId / remoteHostId → createOpts 不携带对应键
    expect('resumeSessionId' in queued.createOpts).toBe(false);
    expect('providerId' in queued.createOpts).toBe(false);
    expect('remoteHostId' in queued.createOpts).toBe(false);
  });

  it.each([undefined, '', 'future-mode'])('fails closed to ask for invalid permission mode %j', (permissionMode) => {
    const queued = buildQueuedTextMessage(
      session({ permissionMode: permissionMode as RemoteSession['permissionMode'] }),
      'hello',
    );

    expect(queued.permissionMode).toBe('ask');
    expect(queued.createOpts.permissionMode).toBe('ask');
  });

  it('carries resume / provider / remote-host identity into createOpts for lazy-create', () => {
    // 被控端 lazy-create(桌面重启后)直接用 createOpts 起会话,不从 DB 兜底:
    // 缺 resumeSessionId 会另起全新 SDK thread(上文全丢),缺 remoteHostId 会把
    // 远端 workingDir 当本地路径(review P1,对齐桌面 buildQueuedMessage 构造)。
    const queued = buildQueuedTextMessage(session({
      sdkSessionId: 'sdk-abc',
      providerId: 'prov-1',
      remoteHostId: 'host-9',
    }), 'continue please', new Date('2026-01-01T00:00:05.000Z'), 'q-resume');

    expect(queued.createOpts).toMatchObject({
      resumeSessionId: 'sdk-abc',
      providerId: 'prov-1',
      remoteHostId: 'host-9',
    });
  });

  it('persists the quote encoding flag for desktop and keeps it on the optimistic chat row', () => {
    const queued = buildQueuedTextMessage(
      session(),
      '> <!-- cindy-composer-quote -->\n> selected\n\nreply',
      new Date('2026-01-01T00:00:05.000Z'),
      'q-quote',
      { quotesEncoded: true },
    );

    expect(JSON.parse(queued.persistedContent)).toEqual({
      text: '> <!-- cindy-composer-quote -->\n> selected\n\nreply',
      images: [],
      files: [],
      quotesEncoded: true,
    });
    expect(queued.chatMessage.quotesEncoded).toBe(true);
    expect(queuedMessageHasEncodedQuotes(queued)).toBe(true);
    expect(queuedMessageHasEncodedQuotes({ persistedContent: '{broken' })).toBe(false);
  });

  it('hides private markers in queue edits and only preserves encoding while text is unchanged', () => {
    const encoded = '> <!-- cindy-composer-quote -->\n> selected\n\nreply';
    const queued = buildQueuedTextMessage(
      session(),
      encoded,
      new Date('2026-01-01T00:00:05.000Z'),
      'q-edit-quote',
      { quotesEncoded: true },
    );
    const state = createQueueEditTextState(queued);

    expect(state.visibleText).toBe('reply');
    expect(state.document.nodes.map((node) => node.type)).toEqual(['quote', 'text']);
    expect(resolveQueueEditTextSubmission(state, state.document)).toEqual({
      text: encoded,
      quotesEncoded: true,
      agentReferences: [],
    });
    expect(resolveQueueEditTextSubmission(state, {
      nodes: state.document.nodes.map((node) => ({ ...node })),
      version: 1,
    })).toEqual({
      text: encoded,
      quotesEncoded: true,
      agentReferences: [],
    });
    expect(resolveQueueEditTextSubmission(state, {
      version: 1,
      nodes: [state.document.nodes[0], { type: 'text', text: 'edited' }],
    })).toEqual({
      text: '> <!-- cindy-composer-quote -->\n> selected\n\nedited',
      quotesEncoded: true,
      agentReferences: [],
      slashCommandRanges: [],
    });
  });

  it('persists structured references through queue creation and queue editing', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `inspect ${href}`;
    const reference = {
      kind: 'message' as const,
      start: text.indexOf(href),
      end: text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    };
    const queued = buildQueuedTextMessage(
      session(),
      text,
      new Date('2026-01-01T00:00:05.000Z'),
      'q-reference',
      { agentReferences: [reference] },
    );

    expect(queued.agentReferences).toEqual([reference]);
    expect(JSON.parse(queued.persistedContent).agentReferences).toEqual([reference]);
    const state = createQueueEditTextState(queued);
    expect(state.agentReferences).toEqual([reference]);
    expect(resolveQueueEditTextSubmission(state, state.document).agentReferences)
      .toEqual([reference]);

    expect(resolveQueueEditTextSubmission(state, textComposerDocument('plain edit')))
      .toMatchObject({
        text: 'plain edit',
        agentReferences: [],
      });
  });

  it('builds queued messages with desktop-compatible remote file attachments', () => {
    const queued = buildQueuedTextMessage(session(), 'see attached', new Date('2026-01-01T00:00:04.000Z'), 'q-file', {
      attachments: [{
        id: 'file-1',
        name: 'spec.pdf',
        path: '/repo/spec.pdf',
        ext: '.pdf',
        size: 2048,
        category: 'pdf',
        mimeType: 'application/pdf',
      }],
    });

    expect(queued.persistedContent).toBe(JSON.stringify({
      text: 'see attached',
      images: [],
      files: [{ name: 'spec.pdf', path: '/repo/spec.pdf' }],
    }));
    expect(queued.files).toEqual([{
      id: 'file-1',
      name: 'spec.pdf',
      path: '/repo/spec.pdf',
      ext: '.pdf',
      size: 2048,
      category: 'pdf',
      mimeType: 'application/pdf',
    }]);
    expect(queued.chatMessage.files).toEqual([{ name: 'spec.pdf', path: '/repo/spec.pdf' }]);
  });

  it('allows attachment-only queued messages', () => {
    const queued = buildQueuedTextMessage(session(), '   ', new Date('2026-01-01T00:00:04.000Z'), 'q-file-only', {
      attachments: [{
        id: 'file-1',
        name: 'notes.md',
        path: '/repo/notes.md',
        ext: '.md',
        size: 0,
        category: 'text',
        mimeType: 'text/plain',
      }],
    });

    expect(queued.text).toBe('');
    expect(queued.chatMessage.content).toBe('');
    expect(JSON.parse(queued.persistedContent)).toEqual({
      text: '',
      images: [],
      files: [{ name: 'notes.md', path: '/repo/notes.md' }],
    });
    expect(queued.files?.[0]).toMatchObject({ path: '/repo/notes.md', category: 'text' });
  });

  it('keeps uploaded mobile OSS refs in every desktop materialization slot', () => {
    const attachment = buildMobileUploadedAttachment({
      id: 'mobile-upload-1',
      ossKey: 'cindy/device-link/user-1/spec.pdf',
      name: 'spec.pdf',
      size: 2048,
      sha256: ATTACHMENT_SHA256,
      mimeType: 'application/pdf',
    });
    expect(attachment).not.toBeNull();

    const queued = buildQueuedTextMessage(session(), 'use this file', new Date('2026-01-01T00:00:04.000Z'), 'q-upload', {
      attachments: [attachment!],
    });
    const persisted = JSON.parse(queued.persistedContent) as { files: Array<{ name: string; path: string }> };

    expect(parseAttachmentOssRef(queued.files?.[0]?.path ?? '')).toMatchObject({
      ossKey: 'cindy/device-link/user-1/spec.pdf',
    });
    expect(persisted.files).toEqual([
      {
        name: 'spec.pdf',
        path: attachment!.path,
        size: 2048,
        sha256: ATTACHMENT_SHA256,
      },
    ]);
    expect(queued.chatMessage.files).toEqual(persisted.files);
  });

  it('persists image attachments in images[] while keeping files[] for desktop materialization', () => {
    const attachment = buildMobileUploadedAttachment({
      id: 'mobile-upload-image',
      ossKey: 'cindy/device-link/user-1/photo.png',
      name: 'photo.png',
      size: 1024,
      sha256: ATTACHMENT_SHA256,
      mimeType: 'image/png',
    });
    expect(attachment).not.toBeNull();

    const queued = buildQueuedTextMessage(session(), 'see image', new Date('2026-01-01T00:00:04.000Z'), 'q-image', {
      attachments: [attachment!],
    });
    const persisted = JSON.parse(queued.persistedContent) as {
      images: Array<{ url: string; originalName?: string; mimeType?: string }>;
      files: Array<{ name: string; path: string }>;
    };

    expect(parseAttachmentOssRef(queued.files?.[0]?.url ?? '')).toMatchObject({
      ossKey: 'cindy/device-link/user-1/photo.png',
    });
    // originalName(而非 name)是桌面 ImageRef schema 的字段;写错字段名
    // 会让桌面 renderer 静默丢弃图片引用(手机贴图桌面不显示,2026-07 实踩)。
    expect(persisted.images).toEqual([
      {
        url: attachment!.url,
        originalName: 'photo.png',
        mimeType: 'image/png',
        size: 1024,
        sha256: ATTACHMENT_SHA256,
      },
    ]);
    expect(persisted.files).toEqual([]);
    expect(queued.chatMessage.images).toEqual(persisted.images);
    expect(queued.chatMessage.files).toBeUndefined();
  });

  it('persists remote-path images as image refs instead of file refs', () => {
    const queued = buildQueuedTextMessage(session(), '', new Date('2026-01-01T00:00:04.000Z'), 'q-remote-image', {
      attachments: [{
        id: 'remote-image',
        name: 'screen.png',
        path: '/repo/screen.png',
        ext: '.png',
        size: 0,
        category: 'image',
        mimeType: 'image/png',
      }],
    });
    const persisted = JSON.parse(queued.persistedContent) as {
      images: Array<{ url: string; originalName?: string; mimeType?: string }>;
      files: Array<{ name: string; path: string }>;
    };

    expect(persisted.images).toEqual([{
      url: '/repo/screen.png',
      originalName: 'screen.png',
      mimeType: 'image/png',
    }]);
    expect(persisted.files).toEqual([]);
    expect(queued.files?.[0]).toMatchObject({ path: '/repo/screen.png', category: 'image' });
    expect(queued.chatMessage.images).toEqual(persisted.images);
  });

  it('normalizes input projection payloads and drops malformed queue rows', () => {
    const queued = buildQueuedTextMessage(session({ agentKind: 'codex' }), 'run tests', new Date(), 'q-1');
    const projection = normalizeInputProjection({
      sessionId: 's1',
      pendingQueue: [queued, { clientId: 'broken' }],
      steeringQueueClientIds: ['q-2', 3],
      queuePaused: true,
      queueExpanded: true,
      queueInteractionLocks: ['drag'],
      queueEditLocks: ['q-1'],
      queueAbortPending: true,
      error: 'failed',
      errorRetryText: 'retry',
      autoResumePending: { error: 'socket hang up', attempt: 2, maxAttempts: 5, sessionTotal: 3 },
    });

    expect(projection).toMatchObject({
      sessionId: 's1',
      pendingQueue: [queued],
      steeringQueueClientIds: ['q-2'],
      queuePaused: true,
      queueExpanded: true,
      queueInteractionLocks: ['drag'],
      queueEditLocks: ['q-1'],
      queueAbortPending: true,
      error: 'failed',
      errorRetryText: 'retry',
      autoResumePending: { error: 'socket hang up', attempt: 2, maxAttempts: 5, sessionTotal: 3 },
    });
  });

  it('preserves and pauses queue only when Stop sees queued rows', () => {
    const queued = buildQueuedTextMessage(session(), 'later', new Date(), 'q-1');

    expect(stopOptionsForProjection({ pendingQueue: [] })).toBeUndefined();
    expect(stopOptionsForProjection({ pendingQueue: [queued] })).toEqual({
      keepQueue: true,
      pauseQueue: true,
    });
  });

  it('summarizes mobile queue panel state for paused, stopped, errored, and collapsed queues', () => {
    const rows = [
      buildQueuedTextMessage(session(), 'one', new Date(), 'q-1'),
      buildQueuedTextMessage(session(), 'two', new Date(), 'q-2'),
      buildQueuedTextMessage(session(), 'three', new Date(), 'q-3'),
      buildQueuedTextMessage(session(), 'four', new Date(), 'q-4'),
    ];

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: rows,
      queueAbortPending: false,
      queueExpanded: false,
      queuePaused: false,
    })).toMatchObject({
      detail: '4 条消息 · 按桌面端顺序发送',
      hiddenCount: 1,
      hint: '可调整顺序、插话、编辑或删除普通队列消息。',
      title: '待发送队列',
      visibleCount: 3,
    });

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: rows.slice(0, 2),
      queueAbortPending: false,
      queueExpanded: false,
      queuePaused: true,
    })).toMatchObject({
      detail: '2 条消息等待恢复',
      hint: '点“继续”后会按当前顺序继续发送到桌面端。',
      title: '队列已暂停',
    });

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: [],
      queueAbortPending: true,
      queueExpanded: false,
      queuePaused: false,
    })).toMatchObject({
      detail: '等待桌面端确认停止',
      title: '停止处理中',
      visibleCount: 0,
    });

    expect(buildQueuePanelSummary({
      error: 'send failed',
      errorRetryText: 'retry',
      pendingQueue: rows,
      queueAbortPending: false,
      queueExpanded: true,
      queuePaused: false,
    }, '协作模式手机版第一版为只读安全降级。')).toMatchObject({
      detail: '发送失败 · 可重试',
      hint: '协作模式手机版第一版为只读安全降级。',
      hiddenCount: 0,
      title: '队列需要处理',
      visibleCount: 4,
    });
  });

  it('matches the desktop pending queue insertion-index contract for up/down moves', () => {
    expect(queueMoveTargetIndex(0, 3, 'up')).toBeNull();
    expect(queueMoveTargetIndex(1, 3, 'up')).toBe(0);
    expect(queueMoveTargetIndex(1, 3, 'down')).toBe(3);
    expect(queueMoveTargetIndex(2, 3, 'down')).toBeNull();
    expect(queueMoveTargetIndex(-1, 3, 'up')).toBeNull();
    expect(queueMoveTargetIndex(3, 3, 'down')).toBeNull();
  });

  it('detects Orca queue origins so mobile can keep collaboration rows read-only', () => {
    expect(isOrcaQueueItem({ origin: { kind: 'orca', leadSessionId: 'lead-1' } })).toBe(true);
    expect(isOrcaQueueItem({ origin: { kind: 'user' } })).toBe(false);
    expect(isOrcaQueueItem({ origin: undefined })).toBe(false);
  });

  it('projects mobile queue row action state from the shared queue model', () => {
    const first = buildQueuedTextMessage(session(), 'first', new Date(), 'q-1');
    const second = buildQueuedTextMessage(session(), 'second', new Date(), 'q-2');
    const projection = normalizeInputProjection({
      sessionId: 's1',
      pendingQueue: [first, second],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      errorRetryText: null,
    });

    const firstRow = buildQueueRowPresentation({
      item: first,
      originalIndex: 0,
      projection,
      queueLength: projection.pendingQueue.length,
    });
    expect(firstRow.title).toBe('队列 1');
    expect(firstRow.actions.moveUp).toMatchObject({
      disabled: true,
      disabledReason: '已经是队列第一条。',
      targetIndex: null,
    });
    expect(firstRow.actions.moveDown).toMatchObject({
      disabled: false,
      targetIndex: 2,
    });

    const locked = buildQueueRowPresentation({
      item: second,
      originalIndex: 1,
      projection: {
        ...projection,
        queueEditLocks: ['q-2'],
      },
      queueLength: projection.pendingQueue.length,
    });
    expect(locked.hint).toBe('这条消息正在编辑中,桌面端会暂停自动发送。');
    expect(locked.actions.edit.disabledReason).toBe('这条队列消息正在编辑中，完成后再操作。');
  });

  it('strips trusted session-reference bodies from every mobile projection', () => {
    const queued = buildQueuedTextMessage(session(), 'cindy://session/source', new Date(), 'q-ref');
    queued.sessionRefs = [{ sessionId: 'source', deviceId: 'dev-source' }];
    queued.trustedSessionReferenceContexts = [{
      sessionId: 'source',
      source: 'device-link',
      deviceId: 'dev-source',
      messages: [{ role: 'user', content: 'trusted body' }],
      range: 'recent',
      messageCount: 1,
      truncated: false,
    }];
    queued.sessionReferencesRequireTrustedSnapshot = true;

    const [projected] = normalizeInputProjection({
      sessionId: 's1',
      pendingQueue: [queued],
    }).pendingQueue;

    expect(projected.sessionRefs).toEqual([{ sessionId: 'source', deviceId: 'dev-source' }]);
    expect(projected.trustedSessionReferenceContexts).toBeUndefined();
    expect(projected.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
  });
});

describe('normalizeInputProjection — credentialSwitchWait', () => {
  it('passes through the desktop credential-switch wait state', () => {
    const projection = normalizeInputProjection({
      sessionId: 's1',
      pendingQueue: [],
      credentialSwitchWait: { clientId: 'c1', blockedBySessionIds: ['a', 'b'] },
    });
    expect(projection.credentialSwitchWait).toEqual({ clientId: 'c1', blockedBySessionIds: ['a', 'b'] });
  });

  it('defaults credentialSwitchWait to null when absent or malformed', () => {
    expect(normalizeInputProjection({ sessionId: 's1' }).credentialSwitchWait).toBeNull();
    expect(normalizeInputProjection({ sessionId: 's1', credentialSwitchWait: 'nope' }).credentialSwitchWait).toBeNull();
  });

  it('treats an empty or missing blockedBySessionIds list as no wait', () => {
    // 退化载荷({clientId} 无挡路列表)若返回 truthy 对象,会渲染出无法消除的
    // 常驻等待横幅——空列表必须归一化为 null。
    expect(
      normalizeInputProjection({ sessionId: 's1', credentialSwitchWait: { clientId: 'c1' } }).credentialSwitchWait,
    ).toBeNull();
    expect(
      normalizeInputProjection({
        sessionId: 's1',
        credentialSwitchWait: { clientId: 'c1', blockedBySessionIds: [] },
      }).credentialSwitchWait,
    ).toBeNull();
  });
});
