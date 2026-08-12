import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);
const suggestionSource = readFileSync(
  resolve(__dirname, '..', 'lib', 'composerSuggestion.ts'),
  'utf8',
);

describe('@ / + file entry unification', () => {
  it('keeps one attachment action instead of a duplicate native file-picker row', () => {
    expect(chatInputSource).toContain("id: 'attach-files'");
    expect(chatInputSource).toContain('suggestionFileInputRef.current?.click()');
    expect(chatInputSource).not.toContain('AT_FILE_PICKER_RESOURCE');
    expect(chatInputSource).not.toContain('window.electronAPI.dialog.showOpenResource(');
    expect(suggestionSource).not.toContain("item.type === 'file-picker'");
  });

  it('does not fall back to the removed in-composer file browser scope', () => {
    expect(chatInputSource).not.toContain('atFileBrowserScopeFrom');
    expect(chatInputSource).not.toContain('setAtFileBrowserScopeFrom');
  });

  it('keeps directory mentions available through scanned resource selection', () => {
    expect(chatInputSource).toContain('getAtDirectoryCompletionQuery(selectedItem)');
    expect(chatInputSource).toContain("selectedItem.type === 'agent'");
  });
});
