import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(
  resolve(__dirname, '..', 'bootstrap-electron.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
const attachmentIpcSource = bootstrapSource.slice(
  bootstrapSource.indexOf('const stageChatAttachment = createChatAttachmentStageHandler'),
  bootstrapSource.indexOf('// Settings → About:'),
);

describe('chat attachment IPC owner boundary', () => {
  it('stages against the active app data owner, including local mode', () => {
    expect(attachmentIpcSource).toContain('const ownerId = getActiveAppSession().dataOwnerId;');
    expect(attachmentIpcSource).not.toContain('authManager.getAuthState().user?.id');
  });

  it('protects persisted paths and rechecks owner scope before renderer cleanup', () => {
    expect(attachmentIpcSource).toContain(
      'const protectedPaths = await listPersistedChatAttachmentPaths();',
    );
    expect(attachmentIpcSource).toContain('activeOwnerScopeKey() === ownerScopeKey');
    expect(attachmentIpcSource).toContain('cleanupOwnedUnpersistedStagedChatAttachments({');
  });
});
