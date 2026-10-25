import type { Catalog } from '@cindy/model-providers';
import type { ProviderService } from '../maker-host/provider-service.js';
import type { OrcaWorkerProviderRoutingContext } from './orcaWorkerCreationService.js';
import { buildOrcaWorkerProviderRoutingContext } from '@cindy/orca-workflow/host/orcaProviderRoutingContext';
export { deviceWorkerRoutingContext, deviceAvailableModels, sshCodexWorkerRoutingContext } from '@cindy/orca-workflow/host/orcaProviderRoutingContext';

/**
 * Build the Orca worker route snapshot from one post-claim full catalog.
 *
 * `listProviders` invokes `getCatalog` after all connection readers settle. Keeping the exact
 * object returned by that callback lets the registry identity lookup use the same catalog as the
 * provider views, instead of mixing a pre-claim selectable projection with post-claim views.
 */
export async function readOrcaWorkerProviderRoutingContext(deps: {
  providerService: ProviderService;
  getCatalog: () => Catalog;
}): Promise<OrcaWorkerProviderRoutingContext> {
  let postClaimCatalog: Catalog | undefined;
  const views = await deps.providerService.listProviders({
    allowSideEffects: true,
    waitForDiscovery: true,
    getCatalog: () => {
      postClaimCatalog = deps.getCatalog();
      return postClaimCatalog;
    },
  });
  const catalog = postClaimCatalog ?? deps.getCatalog();
  return buildOrcaWorkerProviderRoutingContext(views, catalog);
}
