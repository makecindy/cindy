/**
 * Electron registration for the Claude accounts IPC (handlers in ipc.ts).
 *
 * Kept apart from index.ts on purpose: auth-adapters imports index.ts on the session spawn
 * path, and that path must not pull in the database client or IPC security modules.
 * Local-only channels (not in the device-link allowlist): login happens in this machine's browser.
 */
import path from 'node:path';

import { findClaudeSessionJsonl } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import type { IpcMain } from 'electron';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { MAKER_INVOKE as MAKER_IPC_INVOKE } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { readMissionSnapshotFile } from './handoff.js';
import { claudeMasterConfigDir, getClaudeAccountsService } from './index.js';
import { createClaudeAccountsIpcHandlers } from './ipc.js';

/**
 * Transcript of a Cindy task for the handoff preview. Every account shares the master's
 * `projects/` dir, so the master root finds transcripts written on any account.
 */
async function findSessionTranscript(sessionId: string): Promise<string | null | 'not_claude'> {
  const [row] = await getDbClient()
    .drizzle.select({ agentKind: sessions.agentKind, sdkSessionId: sessions.sdkSessionId, workingDir: sessions.workingDir })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  if (dbToMakerAgentKind(row.agentKind) !== 'claude-code') return 'not_claude';
  if (!row.sdkSessionId) return null;
  return findClaudeSessionJsonl(row.sdkSessionId, row.workingDir ?? undefined, path.join(claudeMasterConfigDir(), 'projects'));
}

export function registerClaudeAccountsIpc(ipcMain: IpcMain): void {
  const handlers = createClaudeAccountsIpcHandlers({
    service: getClaudeAccountsService,
    assertTrusted: assertTrustedAppRendererEvent,
    ownerReady: () => !isAppSessionBoundaryPending() && Boolean(getActiveAppSession().dataOwnerId),
    findTranscript: findSessionTranscript,
    readSnapshot: readMissionSnapshotFile,
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_LIST, (event) => handlers.list(event));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_ADD, (event, payload: unknown) => handlers.add(event, payload));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_CANCEL_ADD, (event, loginKey: unknown) => handlers.cancelAdd(event, loginKey));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_SWITCH, (event, accountId: unknown) => handlers.switchAccount(event, accountId));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_REMOVE, (event, accountId: unknown) => handlers.remove(event, accountId));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_HEALTH, (event) => handlers.health(event));
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_ACCOUNTS_HANDOFF_PREVIEW, (event, sessionId: unknown) =>
    handlers.handoffPreview(event, sessionId),
  );
}
