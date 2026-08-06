import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';

import {
  resolveSerializedSessionMessageReferencesForSend,
  resolveSessionMessageReferencesForSend,
  sanitizeSessionChipTitle,
  pastedSessionChipAttrs,
  serializeSessionChipText,
  summarizeSessionMessageChipLabel,
  SESSION_MESSAGE_CHIP_LABEL_MAX_CHARS,
} from '../components/new-chat/sessionLinkPaste';

// 粘贴文本的分段(text / session / project / path)用例在 pastePipeline.test.ts;
// 本文件只覆盖 session 段落地后的专属逻辑(attrs 构造 / 标题清洗 / 序列化)。

const SESSION_URL = 'xdt-maker://session/ee59672a-5591-48a7-a44d-aa97e3808c64';
const SHORT_ID = 'ee59672a…8c64';
const MESSAGE_URL = `${SESSION_URL}?message=client-message-12345678`;

describe('sanitizeSessionChipTitle', () => {
  it('replaces ascii square brackets and collapses whitespace', () => {
    expect(sanitizeSessionChipTitle('[WIP] 修复  白屏')).toBe('WIP 修复 白屏');
    expect(sanitizeSessionChipTitle('  正常标题 ')).toBe('正常标题');
  });
});

describe('pastedSessionChipAttrs', () => {
  it('uses the explicit label as a titled chip', () => {
    expect(pastedSessionChipAttrs({ href: SESSION_URL, label: '修复白屏' })).toEqual({
      kind: 'session',
      label: '修复白屏',
      path: SESSION_URL,
      titled: true,
    });
  });

  it('falls back to the short session id while untitled', () => {
    expect(pastedSessionChipAttrs({ href: SESSION_URL, label: null })).toEqual({
      kind: 'session',
      label: SHORT_ID,
      path: SESSION_URL,
      titled: false,
    });
  });

  it('ignores a conversation title for message anchors while resolving their content', () => {
    expect(pastedSessionChipAttrs({ href: MESSAGE_URL, label: 'Conversation title' })).toEqual({
      kind: 'session',
      label: 'client-m…5678',
      path: MESSAGE_URL,
      titled: false,
    });
  });
});

describe('serializeSessionChipText', () => {
  it('serializes titled chips to markdown links and untitled to the bare href', () => {
    expect(
      serializeSessionChipText({
        kind: 'session',
        label: '修复白屏',
        path: SESSION_URL,
        titled: true,
      }),
    ).toBe(`[修复白屏](${SESSION_URL})`);
    expect(
      serializeSessionChipText({
        kind: 'session',
        label: SHORT_ID,
        path: SESSION_URL,
        titled: false,
      }),
    ).toBe(SESSION_URL);
  });

  it('keeps resolved message text out of the persisted deep-link wire', () => {
    expect(
      serializeSessionChipText({
        kind: 'session',
        label: 'The referenced message body',
        path: MESSAGE_URL,
        titled: true,
      }),
    ).toBe(MESSAGE_URL);
  });
});

describe('summarizeSessionMessageChipLabel', () => {
  it('collapses whitespace and caps draft metadata for long message links', () => {
    const summary = summarizeSessionMessageChipLabel(` first\n\n${'x'.repeat(400)} `);
    expect(summary).toHaveLength(SESSION_MESSAGE_CHIP_LABEL_MAX_CHARS);
    expect(summary.startsWith('first x')).toBe(true);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('resolveSessionMessageReferencesForSend', () => {
  it('waits for the full message body and patches semantic attrs before submit serialization', async () => {
    const chip = {
      type: { name: 'mentionChip' },
      attrs: pastedSessionChipAttrs({ href: MESSAGE_URL, label: null }),
    };
    const transaction = {
      setMeta: () => transaction,
      setNodeMarkup: (_pos: number, _type: unknown, attrs: unknown) => {
        chip.attrs = attrs as typeof chip.attrs;
        return transaction;
      },
    };
    const editor = {
      isDestroyed: false,
      state: {
        doc: {
          descendants: (visit: (node: typeof chip, pos: number) => void) => visit(chip, 1),
        },
        tr: transaction,
      },
      view: { dispatch: () => undefined },
    } as unknown as Editor;
    let release!: (value: string | null) => void;
    const resolved = new Promise<string | null>((resolve) => {
      release = resolve;
    });

    const pending = resolveSessionMessageReferencesForSend(editor, async () => resolved);
    expect(chip.attrs.agentText).toBeUndefined();
    release('Full cross-device message body');
    await pending;

    expect(chip.attrs).toMatchObject({
      label: 'Full cross-device message body',
      titled: true,
      agentText: 'Full cross-device message body',
    });
  });

  it('hydrates an immutable click-time reference snapshot without mutating later composer state', async () => {
    const frozenReferences = [
      {
        kind: 'message' as const,
        start: 0,
        end: MESSAGE_URL.length,
        href: MESSAGE_URL,
        sessionId: 'ee59672a-5591-48a7-a44d-aa97e3808c64',
        messageClientId: 'client-message-12345678',
      },
    ];
    const liveReferences = [...frozenReferences];
    let release!: (value: string | null) => void;
    const messageText = new Promise<string | null>((resolve) => {
      release = resolve;
    });

    const pending = resolveSerializedSessionMessageReferencesForSend(
      frozenReferences,
      async () => messageText,
    );
    liveReferences.splice(0, 1, {
      ...frozenReferences[0],
      href: `${SESSION_URL}?message=new-live-message`,
      messageClientId: 'new-live-message',
    });
    release('Body captured for the original click');

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        href: MESSAGE_URL,
        messageClientId: 'client-message-12345678',
        text: 'Body captured for the original click',
      }),
    ]);
    expect(frozenReferences[0]).not.toHaveProperty('text');
    expect(liveReferences[0]?.messageClientId).toBe('new-live-message');
  });
});
