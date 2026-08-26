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

  it('confirms fixed directory deletion in Main with cancel as the safe default', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    const confirmBlock = bootstrap.slice(
      bootstrap.indexOf('const confirmFixedDirectoryClear'),
      bootstrap.indexOf('const captureActiveChatAttachmentRoot'),
    );

    expect(confirmBlock).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(confirmBlock).toContain('dialog.showMessageBox(ownerWindow');
    expect(confirmBlock).toContain("t('settings.about.storage.cancelButton')");
    expect(confirmBlock).toContain('defaultId: 1');
    expect(confirmBlock).toContain('cancelId: 1');
    expect(confirmBlock).toContain('noLink: true');

    for (const channel of [
      'cindy-media:legacy-images-clear',
      'cindy-media:chat-attachments-clear',
    ]) {
      const start = bootstrap.indexOf(`ipcMain.handle('${channel}'`);
      expect(bootstrap.slice(start, start + 900), channel).toContain(
        'confirmFixedDirectoryClear(event',
      );
    }
  });

  it('encodes fixed directory confirmation and cleanup failures as IPC errors', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    const storageBlock = bootstrap.slice(
      bootstrap.indexOf('// ── 存储空间卡片(关于页)IPC:媒体总仓回收器 + 对账'),
      bootstrap.indexOf('// F5: SDK send-time temporary base64 read'),
    );

    expect(storageBlock).toContain('const runFixedDirectoryIpcAction');
    expect(storageBlock).toContain('if (isIpcError(error)) throw error;');
    expect(storageBlock).toContain(
      "throwIpcError('INTERNAL', 'fixed cache directory action failed')",
    );
    expect(storageBlock).toContain(
      "'fixed directory cleanup requires a live owner window'",
    );
    expect(storageBlock).toContain(
      "runFixedDirectoryIpcAction('legacy-images-clear'",
    );
    expect(storageBlock).toContain(
      "runFixedDirectoryIpcAction('chat-attachments-clear'",
    );
  });

  it('opens and clears only the active owner chat attachment directory', () => {
    const bootstrap = fs.readFileSync(
      new URL('../bootstrap-electron.ts', import.meta.url),
      'utf8',
    );
    const storageBlock = bootstrap.slice(
      bootstrap.indexOf('// ── 存储空间卡片'),
      bootstrap.indexOf('// F5: SDK send-time temporary base64 read'),
    );

    expect(storageBlock).toContain('const ownerId = getActiveAppSession().dataOwnerId;');
    expect(storageBlock).toContain('getChatAttachmentOwnerCacheRoot(ownerId)');
    expect(storageBlock).toContain('activeOwnerScopeKey() === ownerScopeKey');
    expect(storageBlock).not.toContain('getChatAttachmentCacheRoot()');
  });
});
