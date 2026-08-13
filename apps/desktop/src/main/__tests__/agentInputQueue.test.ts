import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import {
  ANNOTATED_IMAGE_NOTE,
  buildMakerUserMessage,
  getAgentFacingText,
  reconcileSessionRefsForText,
  sanitizeQueuedMessageForPersistence,
  updateQueuedMessageContent,
  updateQueuedMessageText,
} from '../../shared/agentInputQueue.js';

function queuedMessage(files: AgentInputQueuedMessage['files']): AgentInputQueuedMessage {
  return {
    clientId: 'client-1',
    text: 'inspect attachment',
    persistedContent: 'inspect attachment',
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    files,
    chatMessage: {
      clientId: 'client-1',
      role: 'user',
      content: 'inspect attachment',
      isStreaming: false,
      createdAt: '2026-06-18T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
  };
}

describe('agentInputQueue', () => {
  it('sends queued GIF attachments as file blocks', () => {
    expect(
      buildMakerUserMessage(
        queuedMessage([
          {
            id: 'gif-1',
            name: 'clip.gif',
            path: '/repo/clip.gif',
            ext: '.gif',
            size: 128,
            category: 'image',
            mimeType: 'image/gif',
            url: 'xdt-image://session/clip.gif',
          },
        ]),
      ),
    ).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'file', path: 'xdt-image://session/clip.gif', mimeType: 'image/gif' },
      ],
    });
  });

  it('keeps queued non-GIF image attachments as image blocks', () => {
    expect(
      buildMakerUserMessage(
        queuedMessage([
          {
            id: 'image-1',
            name: 'shot.png',
            path: '/repo/shot.png',
            ext: '.png',
            size: 128,
            category: 'image',
            mimeType: 'image/png',
            pathOrigin: 'desktop-host',
            url: 'xdt-image://session/shot.png',
          },
        ]),
      ),
    ).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        {
          type: 'image',
          path: 'xdt-image://session/shot.png',
          mimeType: 'image/png',
          pathOrigin: 'desktop-host',
        },
      ],
    });
  });

  it('appends the hidden annotation note once after all blocks for annotated images', () => {
    expect(
      buildMakerUserMessage(
        queuedMessage([
          {
            id: 'image-1',
            name: 'shot.png',
            path: '/repo/shot.png',
            ext: '.png',
            size: 128,
            category: 'image',
            mimeType: 'image/png',
            url: 'xdt-image://session/shot.png',
            annotated: true,
          },
          {
            id: 'image-2',
            name: 'other.png',
            path: '/repo/other.png',
            ext: '.png',
            size: 64,
            category: 'image',
            mimeType: 'image/png',
            url: 'xdt-image://session/other.png',
            annotated: true,
          },
        ]),
      ),
    ).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'image', path: 'xdt-image://session/shot.png', mimeType: 'image/png' },
        { type: 'image', path: 'xdt-image://session/other.png', mimeType: 'image/png' },
        { type: 'text', text: ANNOTATED_IMAGE_NOTE },
      ],
    });
  });

  it('does not inject the annotation note for plain images or annotated GIF-as-file blocks', () => {
    expect(
      buildMakerUserMessage(
        queuedMessage([
          {
            id: 'image-1',
            name: 'shot.png',
            path: '/repo/shot.png',
            ext: '.png',
            size: 128,
            category: 'image',
            mimeType: 'image/png',
            url: 'xdt-image://session/shot.png',
          },
          {
            // GIF 进 file block(不做视觉标注语义),即便误带 annotated 也不注入。
            id: 'gif-1',
            name: 'clip.gif',
            path: '/repo/clip.gif',
            ext: '.gif',
            size: 128,
            category: 'image',
            mimeType: 'image/gif',
            url: 'xdt-image://session/clip.gif',
            annotated: true,
          },
        ]),
      ),
    ).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect attachment' },
        { type: 'image', path: 'xdt-image://session/shot.png', mimeType: 'image/png' },
        { type: 'file', path: 'xdt-image://session/clip.gif', mimeType: 'image/gif' },
      ],
    });
  });

  it('clears quote metadata when a queued quoted message is rewritten without markers', () => {
    const entry = queuedMessage(undefined);
    entry.text = '> <!-- cindy-composer-quote -->\n> quoted\n\nreply';
    entry.persistedContent = JSON.stringify({
      text: entry.text,
      images: [],
      files: [],
      quotesEncoded: true,
    });
    entry.chatMessage.content = entry.text;
    entry.chatMessage.quotesEncoded = true;

    const updated = updateQueuedMessageText(entry, '> quoted\n\nrevised reply');

    expect(JSON.parse(updated.persistedContent)).toEqual({
      text: '> quoted\n\nrevised reply',
      images: [],
      files: [],
      slashCommandRanges: [],
    });
    expect(updated.chatMessage.quotesEncoded).toBeUndefined();
  });

  it('preserves quote metadata when a queued rewrite still contains markers', () => {
    const entry = queuedMessage(undefined);
    entry.persistedContent = JSON.stringify({
      text: entry.text,
      quotesEncoded: true,
    });
    entry.chatMessage.quotesEncoded = true;
    const rewritten = '> <!-- cindy-composer-quote -->\n> revised quote\n\nreply';

    const updated = updateQueuedMessageText(entry, rewritten);

    expect(JSON.parse(updated.persistedContent)).toEqual({
      text: rewritten,
      quotesEncoded: true,
      slashCommandRanges: [],
    });
    expect(updated.chatMessage.quotesEncoded).toBe(true);
  });

  it('drops stale long-paste offsets when queued text is rewritten', () => {
    const entry = queuedMessage(undefined);
    entry.persistedContent = JSON.stringify({
      text: entry.text,
      images: [],
      files: [],
      pastedTextRanges: [{ start: 0, end: 7, display: 'Pasted text (1 line)' }],
    });
    entry.chatMessage.pastedTextRanges = [{ start: 0, end: 7, display: 'Pasted text (1 line)' }];

    const updated = updateQueuedMessageText(entry, 'rewritten');

    expect(JSON.parse(updated.persistedContent).pastedTextRanges).toBeUndefined();
    expect(updated.chatMessage.pastedTextRanges).toBeUndefined();
    expect(updated.sessionRefs).toBeUndefined();
    expect(updated.trustedSessionReferenceContexts).toBeUndefined();
    expect(updated.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
  });

  it('drops stale agent-reference offsets from both queued message copies', () => {
    const entry = queuedMessage(undefined);
    const reference = {
      kind: 'project' as const,
      start: 0,
      end: 12,
      href: 'cindy://project/repo',
      name: 'repo',
      workingDir: '/repo',
    };
    entry.agentReferences = [reference];
    entry.chatMessage.agentReferences = [reference];

    const updated = updateQueuedMessageText(entry, 'rewritten');

    expect(updated.agentReferences).toBeUndefined();
    expect(updated.chatMessage.agentReferences).toBeUndefined();
  });

  it('clears stale slash offsets but keeps the explicit no-legacy marker after a text rewrite', () => {
    const entry = queuedMessage(undefined);
    entry.persistedContent = JSON.stringify({
      text: '/git old',
      images: [],
      files: [],
      slashCommandRanges: [{ start: 0, end: 4 }],
    });
    entry.chatMessage.content = '/git old';
    entry.chatMessage.slashCommandRanges = [{ start: 0, end: 4 }];

    const updated = updateQueuedMessageText(entry, '/unknown rewritten');

    expect(JSON.parse(updated.persistedContent).slashCommandRanges).toEqual([]);
    expect(updated.chatMessage.slashCommandRanges).toEqual([]);
  });

  it('trims sentence punctuation from anchored session links', () => {
    expect(reconcileSessionRefsForText(
      '请查看 cindy://session/current?message=client-1.',
      undefined,
    )).toEqual([{ sessionId: 'current', messageClientId: 'client-1' }]);
  });

  it('strips trusted reference bodies from crash-recovery persistence', () => {
    const entry = queuedMessage(undefined);
    entry.sessionRefs = [{ sessionId: 'source', deviceId: 'source-device' }];
    entry.trustedSessionReferenceContexts = [{
      sessionId: 'source',
      source: 'device-link',
      deviceId: 'source-device',
      messages: [{ role: 'user', content: 'private referenced body' }],
      range: 'recent',
      messageCount: 1,
      truncated: false,
    }];

    const persisted = sanitizeQueuedMessageForPersistence(entry);

    expect(persisted.trustedSessionReferenceContexts).toBeUndefined();
    expect(persisted.sessionReferencesRequireTrustedSnapshot).toBe(true);
    expect(persisted.sessionRefs).toEqual(entry.sessionRefs);
    expect(JSON.stringify(persisted)).not.toContain('private referenced body');
    expect(entry.trustedSessionReferenceContexts).toHaveLength(1);
  });

  it('strips hydrated message-chip bodies from both queue reference copies', () => {
    const entry = queuedMessage(undefined);
    const href = 'cindy://session/source?message=message-1';
    const reference = {
      kind: 'message' as const,
      start: 0,
      end: href.length,
      href,
      sessionId: 'source',
      messageClientId: 'message-1',
      text: 'process-local referenced body',
      truncated: true,
    };
    entry.text = href;
    entry.agentReferences = [reference];
    entry.persistedContent = JSON.stringify({
      text: href,
      agentReferences: [reference],
    });

    const persisted = sanitizeQueuedMessageForPersistence(entry);

    expect(persisted.agentReferences?.[0]).not.toHaveProperty('text');
    expect(persisted.agentReferences?.[0]).not.toHaveProperty('truncated');
    expect(JSON.parse(persisted.persistedContent).agentReferences[0])
      .not.toHaveProperty('text');
    expect(JSON.parse(persisted.persistedContent).agentReferences[0])
      .not.toHaveProperty('truncated');
    expect(JSON.stringify(persisted)).not.toContain('process-local referenced body');
    expect(entry.agentReferences?.[0]).toHaveProperty('text', 'process-local referenced body');
  });

  it('reconciles both current and legacy session links on queue edits', () => {
    expect(
      reconcileSessionRefsForText(
        'cindy://session/current?message=client-1 and xdt-maker://session/legacy',
        undefined,
      ),
    ).toEqual([
      { sessionId: 'current', messageClientId: 'client-1' },
      { sessionId: 'legacy' },
    ]);
  });

  // 远程会话引用注入失败的回归:深链冻结的 `?device=` 必须在实时查表 miss
  // (被控端离线 / relay 重连窗口注册表被 clear)时仍能把引用判定为远程。
  it('binds the device frozen into the link even when the live lookup misses', () => {
    expect(
      reconcileSessionRefsForText(
        '看这个 cindy://session/remote-1?device=dev-studio',
        undefined,
        () => undefined,
      ),
    ).toEqual([{ sessionId: 'remote-1', deviceId: 'dev-studio' }]);
  });

  it('prefers the frozen link device over live lookup and previous hints', () => {
    expect(
      reconcileSessionRefsForText(
        'cindy://session/remote-1?message=client-1&device=dev-frozen.',
        [{ sessionId: 'remote-1', deviceId: 'dev-hint' }],
        () => 'dev-live',
      ),
    ).toEqual([
      { sessionId: 'remote-1', messageClientId: 'client-1', deviceId: 'dev-frozen' },
    ]);
  });

  it('falls back to live lookup then previous hints for links without a device parameter', () => {
    expect(
      reconcileSessionRefsForText('cindy://session/remote-1', undefined, () => 'dev-live'),
    ).toEqual([{ sessionId: 'remote-1', deviceId: 'dev-live' }]);
    expect(
      reconcileSessionRefsForText(
        'cindy://session/remote-1',
        [{ sessionId: 'remote-1', deviceId: 'dev-hint' }],
        () => undefined,
      ),
    ).toEqual([{ sessionId: 'remote-1', deviceId: 'dev-hint' }]);
  });

  it('treats an empty or malformed device parameter as absent', () => {
    expect(
      reconcileSessionRefsForText('cindy://session/remote-1?device=', undefined, () => undefined),
    ).toEqual([{ sessionId: 'remote-1' }]);
    expect(
      reconcileSessionRefsForText(
        'cindy://session/remote-1?device=%ZZ&message=client-1',
        undefined,
        () => undefined,
      ),
    ).toEqual([{ sessionId: 'remote-1', messageClientId: 'client-1' }]);
  });

  it('projects encoded quote markers for Agent use without changing queue or persistence wire', () => {
    const entry = queuedMessage(undefined);
    const text = '> <!-- cindy-composer-quote -->\n> selected\n\nreply';
    entry.text = text;
    entry.persistedContent = JSON.stringify({ text, quotesEncoded: true });
    entry.chatMessage.content = text;
    entry.chatMessage.quotesEncoded = true;

    expect(getAgentFacingText(entry)).toBe('> selected\n\nreply');
    expect(buildMakerUserMessage(entry)).toEqual({
      type: 'user',
      content: '> selected\n\nreply',
    });
    expect(entry.text).toBe(text);
    expect(entry.persistedContent).toBe(JSON.stringify({ text, quotesEncoded: true }));
    expect(entry.chatMessage).toMatchObject({ content: text, quotesEncoded: true });
  });

  it('keeps a hand-written marker when quotesEncoded is false', () => {
    const entry = queuedMessage(undefined);
    entry.text = '> <!-- cindy-composer-quote -->\n> hand written';
    entry.chatMessage.content = entry.text;

    expect(getAgentFacingText(entry)).toBe(entry.text);
  });

  it('expands a message chip to its full semantic body instead of sending only the deep link', () => {
    const entry = queuedMessage(undefined);
    const href = 'cindy://session/session-a?message=message-a';
    entry.text = `please inspect ${href}`;
    entry.chatMessage.content = entry.text;
    entry.agentReferences = [{
      kind: 'message',
      start: entry.text.indexOf(href),
      end: entry.text.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Complete target message body',
    }];

    const projected = getAgentFacingText(entry);
    expect(projected).toContain('Complete target message body');
    expect(projected).toContain('Session ID: session-a');
    expect(projected).toContain('Message ID: message-a');
    expect(projected).not.toContain(href);
  });

  it('leaves slash, long-paste text and file mentions unchanged for Agent delivery', () => {
    const entry = queuedMessage(undefined);
    entry.text = '/learn\nfull pasted body\n@"docs/spec.md"';
    entry.chatMessage.content = entry.text;
    entry.chatMessage.pastedTextRanges = [{
      start: 7,
      end: 23,
      display: 'Pasted text (2 lines)',
    }];
    entry.chatMessage.slashCommandRanges = [{ start: 0, end: 6 }];
    entry.mentions = [{ type: 'file', name: 'spec.md', path: 'docs/spec.md' }];

    expect(buildMakerUserMessage(entry)).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: entry.text },
        { type: 'mention', name: 'spec.md', path: 'docs/spec.md', kind: 'file' },
      ],
    });
  });

  it('replaces or clears structured reference offsets during queue content edits', () => {
    const old = queuedMessage(undefined);
    old.agentReferences = [{
      kind: 'session',
      start: 0,
      end: old.text.length,
      href: 'cindy://session/old',
      sessionId: 'old',
    }];
    const next = queuedMessage(undefined);
    next.text = 'plain replacement';
    next.persistedContent = JSON.stringify({
      text: next.text,
      images: [],
      files: [],
    });
    next.chatMessage.content = next.text;

    const updated = updateQueuedMessageContent(old, next);
    expect(updated.agentReferences).toBeUndefined();
    expect(updated.persistedContent).toBe(next.persistedContent);
  });
});
