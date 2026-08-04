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
      'const composerMutationLocked = composerEditorLocked || voiceInput.isBusy;',
    );
    expect(chatInputSource).toContain('editor?.setEditable(!composerMutationLocked);');
    expect(chatInputSource).toContain('if (composerMutationLockedRef.current) return true;');
    expect(chatInputSource).toContain('active={voiceInput.isBusy}');
  });

  it('keeps attachments locked while leaving permission mode available', () => {
    const extraDirsStart = chatInputSource.indexOf('<ExtraDirsButton');
    expect(extraDirsStart).toBeGreaterThanOrEqual(0);
    const extraDirsEnd = chatInputSource.indexOf('/>', extraDirsStart);
    expect(extraDirsEnd).toBeGreaterThan(extraDirsStart);
    const extraDirsBlock = chatInputSource.slice(extraDirsStart, extraDirsEnd);
    expect(extraDirsBlock).toContain('disabled={composerMutationLocked}');

    const permissionStart = chatInputSource.indexOf('<PermissionSelector');
    expect(permissionStart).toBeGreaterThanOrEqual(0);
    const permissionEnd = chatInputSource.indexOf('/>', permissionStart);
    expect(permissionEnd).toBeGreaterThan(permissionStart);
    const permissionBlock = chatInputSource.slice(permissionStart, permissionEnd);
    expect(permissionBlock).toContain('disabled={composerEditorLocked}');
    expect(permissionBlock).not.toContain('disabled={composerMutationLocked}');
  });

  it('lets an alert dialog consume Escape before voice cancellation', () => {
    expect(chatInputSource).toContain(
      "event.target instanceof Element &&\n        event.target.closest('[role=\"alertdialog\"]')",
    );
  });
});
