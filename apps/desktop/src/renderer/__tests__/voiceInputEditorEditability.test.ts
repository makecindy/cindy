import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput voice lifecycle locks', () => {
  it('keeps the editor read-only for the entire voice lifecycle', () => {
    expect(chatInputSource).toContain(
      'const composerMutationLocked = composerEditorLocked || voiceBusyOnCurrentComposer;',
    );
    expect(chatInputSource).toContain('editor?.setEditable(!composerMutationLocked);');
    expect(chatInputSource).toContain('if (composerMutationLockedRef.current) return true;');
    expect(chatInputSource).toContain('active={voiceBusyOnCurrentComposer}');
  });

  it('keeps attachments locked while leaving permission mode available', () => {
    const extraDirsStart = chatInputSource.indexOf('<ExtraDirsButton');
    expect(extraDirsStart).toBeGreaterThanOrEqual(0);
    const permissionStart = chatInputSource.indexOf('<PermissionSelector');
    expect(permissionStart).toBeGreaterThanOrEqual(0);
    const extraDirsBlock = chatInputSource.slice(extraDirsStart, permissionStart);
    expect(extraDirsBlock).toContain('disabled={composerMutationLocked}');

    const permissionEnd = chatInputSource.indexOf('/>', permissionStart);
    expect(permissionEnd).toBeGreaterThan(permissionStart);
    const permissionBlock = chatInputSource.slice(permissionStart, permissionEnd);
    expect(permissionBlock).toContain('disabled={composerEditorLocked || settingsLocked}');
    expect(permissionBlock).not.toContain('disabled={composerMutationLocked}');
  });

  it('lets top-level permission surfaces consume Escape before voice cancellation', () => {
    const shortcutHandlerStart = chatInputSource.indexOf(
      'const handleKeyDown = (event: KeyboardEvent) => {',
    );
    expect(shortcutHandlerStart).toBeGreaterThanOrEqual(0);
    const shortcutHandlerEnd = chatInputSource.indexOf(
      'const enterIntent = resolveComposerEnterIntent(',
      shortcutHandlerStart,
    );
    expect(shortcutHandlerEnd).toBeGreaterThan(shortcutHandlerStart);
    const shortcutHandlerBlock = chatInputSource.slice(shortcutHandlerStart, shortcutHandlerEnd);

    expect(shortcutHandlerBlock).toContain('[role="alertdialog"]');
    expect(shortcutHandlerBlock).toContain('[data-morph-side]');
    const voiceCancelStart = shortcutHandlerBlock.indexOf('voiceInputCancelRef.current()');
    expect(voiceCancelStart).toBeGreaterThanOrEqual(0);
    expect(shortcutHandlerBlock.indexOf('[data-morph-side]')).toBeLessThan(
      voiceCancelStart,
    );
    expect(shortcutHandlerBlock).toContain('voiceOwnsCurrentComposer');
  });
});
