import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);

describe('@ native resource picker wiring', () => {
  it('opens the native picker from the fixed resource row', () => {
    expect(chatInputSource).toContain("selectedItem.type === 'file-picker'");
    expect(chatInputSource).toContain('window.electronAPI.dialog.showOpenResource(');
    expect(chatInputSource).toContain(
      'filePickerEnabled={!!workingDir && localAttachmentPickerEnabled}',
    );
  });

  it('does not fall back to the removed in-composer file browser scope', () => {
    expect(chatInputSource).not.toContain('atFileBrowserScopeFrom');
    expect(chatInputSource).not.toContain('setAtFileBrowserScopeFrom');
  });

  it('drops a late picker result after the composer target changes', () => {
    expect(chatInputSource).toContain('const originDoc = editor.state.doc;');
    expect(chatInputSource).toContain('const originStorageKey = storageKey;');
    expect(chatInputSource).toContain('isAtResourceInsertTargetCurrent(');
    expect(chatInputSource).toContain('currentStorageKeyRef.current');
  });
});
