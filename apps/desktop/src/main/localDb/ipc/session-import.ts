import { app, ipcMain } from 'electron';
import { createSessionImport } from '@cindy/app-runtime/sessionImport';
import { getCurrentDbClientUserId, getDbClient } from '../client/current.js';
import { createLogger } from '../../logger.js';
import { importExternalCodexSessions, scanExternalCodexSessions } from '../../maker-host/codex-local-sessions.js';
import { importExternalClaudeCodeSessions, scanExternalClaudeCodeSessions } from '../../maker-host/claude-local-sessions.js';
import { dialogueWorkspaceRoots } from '../dialogueWorkspace.js';
export const { registerSessionImportIpc, invalidateSessionImportScanCache } = createSessionImport({
  ipc: ipcMain, logger: createLogger('session-import'), userDataDirectory: () => app.getPath('userData'),
  getCurrentDbClientUserId: () => getCurrentDbClientUserId(), getDbClient: () => getDbClient(),
  dialogueWorkspaceRoots: () => dialogueWorkspaceRoots(),
  importExternalCodexSessions: (...args) => importExternalCodexSessions(...args),
  scanExternalCodexSessions: (...args) => scanExternalCodexSessions(...args),
  importExternalClaudeCodeSessions: (...args) => importExternalClaudeCodeSessions(...args),
  scanExternalClaudeCodeSessions: (...args) => scanExternalClaudeCodeSessions(...args),
});
