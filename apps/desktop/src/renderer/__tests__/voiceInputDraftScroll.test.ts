import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const chatInput = readFileSync(path.join(root, 'components/new-chat/ChatInput.tsx'), 'utf8');
const draftDecoration = readFileSync(
  path.join(root, 'components/new-chat/VoiceInputDraftDecoration.ts'),
  'utf8',
);

describe('voice input draft scroll anchoring', () => {
  it('scrolls the live draft to the saved insertion range instead of the bottom', () => {
    const effectStart = chatInput.indexOf('setVoiceInputDraftDecoration(');
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = chatInput.indexOf('// Route changes such as Chat -> Settings', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const effectBlock = chatInput.slice(effectStart, effectEnd);

    expect(effectBlock).toContain('voiceInput.draftRange');
    expect(effectBlock).toContain('scrollVoiceInputDraftEndIntoView(editor)');
    expect(effectBlock).not.toContain('scrollEditorToBottom');
  });

  it('keeps an explicit draft decoration anchor from following later selection changes', () => {
    expect(draftDecoration).toContain('anchorLocked');
    expect(draftDecoration).toContain('const anchorLocked = Boolean(range)');
    expect(draftDecoration).toContain('if (!old.anchorLocked)');
  });
});
