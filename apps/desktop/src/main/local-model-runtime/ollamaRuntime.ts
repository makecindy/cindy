import { createOllamaRuntime } from '@cindy/model-providers/local-runtime/ollamaRuntime';
import { createLogger } from '../logger.js';
import { findInstalledSidecarBinary, spawnManagedSidecar } from './ollamaSidecar.js';
const host = {
  log: createLogger('local-model-runtime'),
  findInstalledSidecarBinary,
  spawnManagedSidecar,
};
export * from '@cindy/model-providers/local-runtime/ollamaRuntime';
export const {
  macOllamaAppInstalled,
  windowsOfficialOllamaBinaries,
  windowsOfficialOllamaBinary,
  defaultOpenOfficialOllamaApp,
  probeOllamaStatus,
  startOfficialOllamaApp,
} = createOllamaRuntime(host);
