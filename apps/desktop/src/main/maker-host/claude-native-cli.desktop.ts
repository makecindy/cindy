/** Desktop adapters for the shared official CLI lifecycle. */
import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { readClaudeCliStatusInWorker } from './claudeCliStatusWorkerClient.js';
import { parseClaudeCliLoginStatus } from '@cindy/maker-core';
import { createClaudeNativeCli } from './claude-native-cli.js';
import { externalClaudeDirectoryForAccount, externalClaudeRuntimeForDirectory, isDefaultClaudeDirectory, peekExternalClaudeAccountId } from './external-claude-runtime.js';
import { isExternalClaudeAccount } from '../subscription-accounts/store.js';
export { parseClaudeCliLoginStatus };
export { onClaudeCliLoginStatusChange, peekClaudeCliLoginStatus, type ClaudeCliLoginStatus } from './claude-native-cli-status.js';
export type { ClaudeCliPlanUsage, ClaudeCliLoginResult } from './claude-native-cli.js';
export const { claudeCliNetworkEnv, refreshClaudeCliLoginStatus, readClaudeCliLoginStatus, readClaudeCliPlanUsage, parseClaudeCliPlanUsageLine, beginClaudeCliLogin, cancelClaudeCliLogin, runClaudeCliLogin, resetClaudeNativeCliForTest } = createClaudeNativeCli({
  binaryPath: () => getReadyBinaryPath('claude-code') ?? null,
  resolveOutboundProxy: resolveDesktopOutboundProxy,
  readStatus: readClaudeCliStatusInWorker,
  resolveRuntime: (directory) => {
    if (!isDefaultClaudeDirectory(directory)) return externalClaudeRuntimeForDirectory(directory);
    if (!isExternalClaudeAccount('default')) {
      if (peekExternalClaudeAccountId() === 'default') throw new Error('The external Claude account must be explicitly registered before use');
      return undefined;
    }
    const selected = externalClaudeDirectoryForAccount('default');
    if (!selected) throw new Error('The external Claude runtime for this account is unavailable; launch is blocked');
    return externalClaudeRuntimeForDirectory(selected);
  },
});
