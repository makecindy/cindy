/** Desktop adapters for the shared official CLI lifecycle. */
import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { readClaudeCliStatusInWorker } from './claudeCliStatusWorkerClient.js';
import { parseClaudeCliLoginStatus } from '@cindy/maker-core';
import { createClaudeNativeCli } from './claude-native-cli.js';
import { defaultPtySpawn } from '../terminal/ptyFactory.js';
export { parseClaudeCliLoginStatus };
export { onClaudeCliLoginStatusChange, peekClaudeCliLoginStatus, type ClaudeCliLoginStatus } from './claude-native-cli-status.js';
export type { ClaudeCliPlanUsage, ClaudeCliLoginResult, ClaudeCliLongLivedTokenResult } from './claude-native-cli.js';
export const { claudeCliNetworkEnv, refreshClaudeCliLoginStatus, readClaudeCliLoginStatus, readClaudeCliPlanUsage, parseClaudeCliPlanUsageLine, beginClaudeCliLogin, cancelClaudeCliLogin, runClaudeCliLogin, runClaudeCliLongLivedToken, removeClaudeCliLongLivedToken, resetClaudeNativeCliForTest } = createClaudeNativeCli({
  binaryPath: () => getReadyBinaryPath('claude-code') ?? null,
  resolveOutboundProxy: resolveDesktopOutboundProxy,
  readStatus: readClaudeCliStatusInWorker,
  // node-pty loads on first use only (see ptyFactory).
  spawnTerminal: (binary, args, options) => defaultPtySpawn(binary, args, options),
});
