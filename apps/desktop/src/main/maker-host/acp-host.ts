/**
 * Desktop wiring for plugin-provided ACP engines (docs/plans/acp-plugin-bridge.md).
 *
 * Delegates platform-neutral AcpAgent assembly to acpHostCore.ts and binds
 * Desktop's Electron-backed Pi MCP bridge environment (`getPiExtraSpawnConfig`).
 */

import type { AcpAgent } from '@cindy/maker-core';
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

export type BuildAcpAgentOpts = Omit<BuildAcpAgentCoreOpts, 'preparePiExtraSpawnConfig'> & {
  preparePiExtraSpawnConfig?: BuildAcpAgentCoreOpts['preparePiExtraSpawnConfig'];
};

export function buildAcpAgent(opts: BuildAcpAgentOpts): AcpAgent {
  const logger = opts.logger.child('acp');
  return buildAcpAgentCore({
    ...opts,
    preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig
      ?? ((providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx)),
  });
}

export type InstallPluginEnginesOpts = Omit<InstallPluginEnginesCoreOpts, 'preparePiExtraSpawnConfig'> & {
  preparePiExtraSpawnConfig?: InstallPluginEnginesCoreOpts['preparePiExtraSpawnConfig'];
};

export function installPluginEngines(opts: InstallPluginEnginesOpts): () => void {
  const logger = opts.logger.child('acp');
  return installPluginEnginesCore({
    ...opts,
    preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig
      ?? ((providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx)),
  });
}
