import { PluginPublisherOrchestrator as NativeOrchestrator, type PluginPublisherOrchestratorDeps as NativeDeps } from '@cindy/plugin-runtime/publisher/orchestrator';
import { getActiveAppSession } from '../appSessionState.js';
import { putLocalFile } from './putObject.js';
export * from '@cindy/plugin-runtime/publisher/orchestrator';
export type PluginPublisherOrchestratorDeps = Omit<NativeDeps, 'owner'> & Partial<Pick<NativeDeps, 'owner'>>;
export class PluginPublisherOrchestrator extends NativeOrchestrator {
  constructor(deps: PluginPublisherOrchestratorDeps) {
    super({ ...deps, owner: deps.owner ?? getActiveAppSession, putFile: deps.putFile ?? putLocalFile });
  }
}
export function createPluginPublisherOrchestrator(deps: PluginPublisherOrchestratorDeps) {
  return new PluginPublisherOrchestrator(deps);
}
