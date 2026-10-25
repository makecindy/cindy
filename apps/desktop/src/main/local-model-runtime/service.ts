import {
  createLocalModelService as createService,
  type LocalModelServiceDeps,
} from '@cindy/model-providers/local-runtime/service';
import { createLogger } from '../logger.js';
import * as managedProvider from './managedOllamaProvider.js';
import * as runtime from './ollamaRuntime.js';
import * as install from './ollamaInstall.js';
import { detectLocalConnectPresets } from './localConnectDetect.js';
export * from '@cindy/model-providers/local-runtime/service';
export function createLocalModelService(deps: LocalModelServiceDeps = {}) {
  return createService(deps, {
    managedProvider,
    runtime,
    install,
    detectLocalConnectPresets,
    log: createLogger('local-model-runtime'),
  });
}
