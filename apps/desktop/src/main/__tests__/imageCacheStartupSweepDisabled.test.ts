import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('fixed cache directory settings', () => {
  it('does not scan message history during startup or draft cleanup', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    const messages = fs.readFileSync(
      new URL('../localDb/ipc/messages.ts', import.meta.url),
      'utf8',
    );

    expect(bootstrap).not.toContain('sweepStartupDraftImages');
    expect(bootstrap).not.toContain('image-cache-orphan-sweep');
    expect(bootstrap).not.toContain('sweepStagedChatAttachmentsOnStartup');
    expect(bootstrap).not.toContain('listPersistedChatAttachmentPaths');
    expect(messages).not.toContain('listPersistedChatAttachmentPaths');
    expect(messages).not.toContain('%chat-attachment-cache%');
    expect(messages).not.toContain("'$.files'");
  });

  it('does not expose automatic scan or cleanup handlers', () => {
    const storageIpc = fs.readFileSync(
      new URL('../cindy-media/storageIpc.ts', import.meta.url),
      'utf8',
    );

    expect(storageIpc).not.toContain('scanLegacyDraftImages');
    expect(storageIpc).not.toContain('cleanupLegacyDraftImages');
    expect(storageIpc).not.toContain('FROM messages INDEXED BY');
  });

  it('guards every fixed directory action with the trusted renderer check', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    for (const channel of [
      'cindy-media:legacy-images-open-dir',
      'cindy-media:legacy-images-clear',
      'cindy-media:chat-attachments-open-dir',
      'cindy-media:chat-attachments-clear',
    ]) {
      const start = bootstrap.indexOf(`ipcMain.handle('${channel}'`);
      expect(start, channel).toBeGreaterThan(-1);
      expect(bootstrap.slice(start, start + 300), channel).toContain(
        'assertTrustedAppRendererEvent(event)',
      );
    }
  });
});
