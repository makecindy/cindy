import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const hardBreakSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ComposerHardBreak.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput list continuation wiring contract', () => {
  it('imports the composer extension and only the direct Backspace helper', () => {
    expect(chatInputSource).toContain(
      "import { applyComposerHardBreak, ComposerHardBreak } from './ComposerHardBreak';",
    );
    expect(chatInputSource).toContain(
      "import { applyListBackspace } from '@/lib/composerListContinuation';",
    );
    expect(chatInputSource).toContain('applyComposerHardBreak(editorRef.current)');
    expect(chatInputSource).not.toContain('applyListContinuation(view)');
  });

  it('keeps Shift/Alt+Enter semantics inside ComposerHardBreak', () => {
    expect(hardBreakSource).toContain('export function applyComposerHardBreak(editor: Editor)');
    expect(hardBreakSource).toContain('applyListContinuation(editor.view)');
    expect(hardBreakSource).toContain('editor.commands.setHardBreak()');
    expect(hardBreakSource).not.toContain('replaceSelectionWith');
  });

  it('routes first modified Enter through the ComposerHardBreak command', () => {
    const block = extractBetween(
      chatInputSource,
      '// Shift/Alt+Enter belongs to ComposerHardBreak',
      '// Plain Enter keeps the existing queue semantics.',
    );
    expect(block).toContain("event.key === 'Enter'");
    expect(block).toContain('event.shiftKey || event.altKey');
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('applyComposerHardBreak(editorRef.current)');
  });

  it('consumes repeated Enter before the palette bridge', () => {
    const handler = extractBetween(chatInputSource, 'handleKeyDown(view, event) {', '      },\n    },');
    const repeatGuard = handler.indexOf("event.key === 'Enter' && event.repeat");
    const panelBridge = handler.indexOf('const bridge = panelBridgeRef.current;');
    expect(repeatGuard).toBeGreaterThanOrEqual(0);
    expect(panelBridge).toBeGreaterThan(repeatGuard);
  });

  it('intercepts bare Backspace for empty-item deletion, leaving modified backspace alone', () => {
    const block = extractBetween(
      chatInputSource,
      '// Backspace — 空列表项整体回删',
      '// Shift/Alt+Enter belongs to ComposerHardBreak',
    );
    expect(block).toContain("event.key === 'Backspace'");
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('!event.altKey');
    expect(block).toContain('!event.shiftKey');
    expect(block).toContain('!event.isComposing');
    expect(block).toContain('applyListBackspace(view)');
  });

  it('lets modified and composing Enter bypass an open command palette', () => {
    const block = extractBetween(
      chatInputSource,
      'captureKey: (e) => {',
      'switch (e.key) {',
    );
    expect(block).toContain("e.key === 'Enter'");
    expect(block).toContain('e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.isComposing');
    expect(block).toContain('return false;');
  });

  it('never intercepts first plain Enter for list continuation', () => {
    const plainEnterBlock = extractBetween(
      chatInputSource,
      '// Plain Enter keeps the existing queue semantics.',
      "void dispatchSendRef.current(wantsSteer ? 'steer' : 'queue');",
    );
    expect(plainEnterBlock).not.toContain('applyListContinuation');
    expect(plainEnterBlock).toContain(
      "event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.repeat",
    );
  });

  it('keeps tabular-nums on the editor so multi-line list prefixes align', () => {
    const attributesBlock = extractBetween(
      chatInputSource,
      "'w-full min-h-[22px] max-h-[186px] overflow-y-auto py-[3px] -my-[3px] pr-[11px]',",
      "'focus:outline-none',",
    );
    expect(attributesBlock).toContain('tabular-nums');
  });
});

function extractBetween(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start);
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = source.indexOf(end, startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}
