/**
 * maker:providers:* IPC (ROADMAP 2.1b/2.2b, IPC part only). Read-only bridge over
 * `~/.cindy-harness/providers.yaml`: list the configured endpoints (plus file issues) and
 * probe them for online/offline and loaded models. The file stays the source of truth;
 * nothing here writes it. Probing happens only when the renderer asks.
 */

import * as path from 'node:path';

import { discoverEndpoints, type DiscoveryOptions, type EndpointProbe } from '@cindy/maker-core/providers-discovery';
import { loadProvidersFile, type ProviderFileResult } from '@cindy/maker-core/providers-file';
import {
  requestRoutedTaskText,
  type RoutedTaskTextDeps,
  type RoutedTaskTextRequest,
  type RoutedTaskTextResult,
} from '@cindy/maker-core/routed-auxiliary';
import { loadRoutingFile, type RoutingParseResult } from '@cindy/maker-core/routing-file';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ProvidersHandlerDeps {
  /** Production: ~/.cindy-harness/providers.yaml. */
  file: string;
  /** Production default: sibling `routing.yaml` in the same harness directory. */
  routingFile?: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production default: the real `discoverEndpoints`. Injected so tests can pass a fake `fetch`. */
  discover?: typeof discoverEndpoints;
  discoveryOptions?: DiscoveryOptions;
  /** Production default: the real `requestRoutedTaskText`. */
  requestRoutedTask?: typeof requestRoutedTaskText;
  routedTaskDeps?: RoutedTaskTextDeps;
}

export function registerProvidersHandlers(registry: IpcHandlerRegistry, deps: ProvidersHandlerDeps): void {
  const routingFile = deps.routingFile ?? path.join(path.dirname(deps.file), 'routing.yaml');
  const harnessDir = path.dirname(deps.file);

  registry.handle(MAKER_INVOKE.PROVIDERS_LIST, (event): ProviderFileResult => {
    deps.assertTrusted(event);
    return loadProvidersFile(deps.file);
  });
  registry.handle(MAKER_INVOKE.PROVIDERS_DISCOVER, async (event): Promise<EndpointProbe[]> => {
    deps.assertTrusted(event);
    const { providers } = loadProvidersFile(deps.file);
    return (deps.discover ?? discoverEndpoints)(providers, deps.discoveryOptions);
  });
  registry.handle(MAKER_INVOKE.ROUTING_GET, (event): RoutingParseResult => {
    deps.assertTrusted(event);
    const { providers } = loadProvidersFile(deps.file);
    return loadRoutingFile(
      routingFile,
      providers.map((p) => p.id),
    );
  });
  registry.handle(
    MAKER_INVOKE.ROUTING_REQUEST_TASK_TEXT,
    async (event, rawArgs: unknown): Promise<RoutedTaskTextResult> => {
      deps.assertTrusted(event);
      const args = rawArgs as RoutedTaskTextRequest;
      return (deps.requestRoutedTask ?? requestRoutedTaskText)(args, {
        harnessDir,
        ...deps.routedTaskDeps,
      });
    },
  );
}
