import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('ChatInput home-suggestion prompt preview', () => {
  it('never lets a keystroke edit or send the draft hidden behind the preview', () => {
    const keyDown = chatInputSource.slice(chatInputSource.indexOf('handleKeyDown(view, event) {'));
    // The preview guard runs before every other key handler (palette, Tab, Enter/send).
    expect(keyDown.indexOf('promptPreviewKeyGuardRef.current()')).toBeLessThan(
      keyDown.indexOf('panelBridgeRef.current'),
    );
    expect(chatInputSource).toContain('promptPreviewKeyGuardRef.current = () => {');
    expect(chatInputSource).toContain('setDismissedPreviewPrompt(previewPrompt ?? null);');
    expect(chatInputSource).toContain(
      '!!previewPrompt && previewPrompt !== dismissedPreviewPrompt && !composerMutationLocked;',
    );
  });

  it('clamps long previews to the composer viewport with an ellipsis instead of silently clipping', () => {
    expect(chatInputSource).toContain(
      "'pointer-events-none absolute inset-x-0 top-0 line-clamp-[8] py-[3px] pr-[11px]',",
    );
  });

  it('reports the composer mutation lock so external fills can stand down', () => {
    expect(chatInputSource).toContain('onMutationLockChange?.(composerMutationLocked);');
  });
});
