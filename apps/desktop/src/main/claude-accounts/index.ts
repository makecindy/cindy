/**
 * Claude multi-account host wiring (Electron side). The logic lives in service.ts.
 *
 * - One service per data owner. Accounts belong to the Cindy profile that added them, and
 *   their profile dirs live under that owner's userData.
 * - The master config dir is the CLI default `~/.claude`.
 * - The active account's env feeds both the CLI status/login/usage calls and subscription
 *   session spawns (auth-adapters getAuthEnv).
 * Design: docs/dev-rules/claude-multi-account.md.
 */
import os from 'node:os';
import path from 'node:path';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  probeClaudeCliLoginStatus,
  refreshClaudeCliLoginStatus,
  runClaudeCliLoginWithEnv,
  setClaudeCliAccountEnvProvider,
} from '../maker-host/claude-native-cli.js';
import { createClaudeAccountsService, type ClaudeAccountsService } from './service.js';

const log = createLogger('claude-accounts');

export type ClaudeAccountSwitchHandler = (change: { previousId: string; nextId: string }) => Promise<void>;

let switchHandler: ClaudeAccountSwitchHandler | null = null;
const services = new Map<string, ClaudeAccountsService>();

/** The maker host registers how live sessions are rebuilt after a switch. */
export function setClaudeAccountSwitchHandler(handler: ClaudeAccountSwitchHandler | null): void {
  switchHandler = handler;
}

export function claudeMasterConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function getClaudeAccountsService(): ClaudeAccountsService {
  const accountsRoot = ownerScopedUserDataPath('claude-accounts');
  let service = services.get(accountsRoot);
  if (!service) {
    service = createClaudeAccountsService({
      accountsRoot,
      masterDir: claudeMasterConfigDir(),
      registryFile: path.join(accountsRoot, 'registry.json'),
      cli: { probe: probeClaudeCliLoginStatus, login: runClaudeCliLoginWithEnv },
      onActiveAccountChanged: async (change) => {
        // The cached login state belongs to the previous account; reread before anything uses it.
        await refreshClaudeCliLoginStatus({ force: true });
        await switchHandler?.(change);
      },
      log,
    });
    services.set(accountsRoot, service);
  }
  return service;
}

/** `{}` for the master (CLI default dir); `{ CLAUDE_CONFIG_DIR }` for an extra account. Throws if not ready. */
export function activeClaudeAccountEnv(): Promise<Record<string, string>> {
  return getClaudeAccountsService().activeAccountEnv();
}

/** Called once at startup, before the first CLI status read. */
export function installClaudeAccounts(): void {
  setClaudeCliAccountEnvProvider(activeClaudeAccountEnv);
}
