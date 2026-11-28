/**
 * Desktop wiring for plugin-provided ACP engines (docs/plans/acp-plugin-bridge.md).
 *
 * Delegates platform-neutral AcpAgent assembly to acpHostCore.ts and binds
 * Desktop's Electron-backed Pi MCP bridge environment (`getPiExtraSpawnConfig`).
 */

import type { AcpAgent, AcpAgentDeps } from '@cindy/maker-core';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import {
  buildAcpAgentCore,
  installPluginEnginesCore,
  type BuildAcpAgentCoreOpts,
  type InstallPluginEnginesCoreOpts,
} from './acpHostCore.js';

export { createAcpProcessTransport } from './acp-transport.js';
export {
  getCachedPluginHarnessModels,
  getReportedPluginEngineModelDetails,
  onPluginHarnessModelsChanged,
  onReportedPluginEngineModelDetailsChanged,
  type CachedPluginEngineModel,
} from './pluginEngineModelCache.js';

const ANTIGRAVITY_HARNESS_KEY = '_root__cindy-antigravity-acp:agy';
// Antigravity's relay has a 16 MiB pending-line limit (#13471). Leave room
// for the JSON-RPC envelope, text and host context outside the image budget.
const ANTIGRAVITY_INLINE_IMAGE_BUDGET_BYTES = 15 * 1024 * 1024;

const desktopInlineImageBudgetForHarness: NonNullable<AcpAgentDeps['inlineImageBudgetBytesForHarness']> =
  (key) => key === ANTIGRAVITY_HARNESS_KEY ? ANTIGRAVITY_INLINE_IMAGE_BUDGET_BYTES : undefined;

const desktopVerificationForTask: NonNullable<AcpAgentDeps['verificationForTask']> = (key, sessionId) =>
  key === ANTIGRAVITY_HARNESS_KEY
    ? async (probe, signal) => (await import('./antigravityVerification.desktop.js')).verifyAntigravityAccount(sessionId, probe, signal)
    : undefined;

export type BuildAcpAgentOpts = Omit<BuildAcpAgentCoreOpts, 'preparePiExtraSpawnConfig' | 'inlineImageBudgetBytesForHarness'> & {
  preparePiExtraSpawnConfig?: BuildAcpAgentCoreOpts['preparePiExtraSpawnConfig'];
};

export function buildAcpAgent(opts: BuildAcpAgentOpts): AcpAgent {
  const logger = opts.logger.child('acp');
  return buildAcpAgentCore({
    ...opts,
    preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig
      ?? ((providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx)),
    verificationForTask: opts.verificationForTask ?? desktopVerificationForTask,
    inlineImageBudgetBytesForHarness: desktopInlineImageBudgetForHarness,
  });
}

export type InstallPluginEnginesOpts = Omit<InstallPluginEnginesCoreOpts, 'preparePiExtraSpawnConfig' | 'inlineImageBudgetBytesForHarness'> & {
  preparePiExtraSpawnConfig?: InstallPluginEnginesCoreOpts['preparePiExtraSpawnConfig'];
};

export function installPluginEngines(opts: InstallPluginEnginesOpts): () => void {
  const logger = opts.logger.child('acp');
  return installPluginEnginesCore({
    ...opts,
    preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig
      ?? ((providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx)),
    verificationForTask: opts.verificationForTask ?? desktopVerificationForTask,
    inlineImageBudgetBytesForHarness: desktopInlineImageBudgetForHarness,
  });
}
