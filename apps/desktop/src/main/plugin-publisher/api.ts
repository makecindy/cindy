import { PluginPublisherApi as NativeApi, PluginPublisherApiError, createUnknownFailureCodeReporter, type PluginPublisherApiDeps as NativeDeps } from '@cindy/plugin-runtime/publisher/api';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { ServerApiError, serverApiFetch } from '../serverApiClient.js';
export * from '@cindy/plugin-runtime/publisher/api';
export type PluginPublisherApiDeps = Omit<NativeDeps, 'fetchImpl'> & Partial<Pick<NativeDeps, 'fetchImpl'>>;
const log = createLogger('plugin-publisher');
const reporter = createUnknownFailureCodeReporter(code => log.warn('plugin publisher received unknown member upload failure code', { code }));
export class PluginPublisherApi extends NativeApi {
  constructor(deps: PluginPublisherApiDeps) {
    super({ ...deps, unknownFailureCodeReporter: deps.unknownFailureCodeReporter ?? reporter,
      fetchImpl: async (apiPath, options) => {
        try {
          return await (deps.fetchImpl ?? ((apiPath, options) => serverApiFetch(apiPath, { ...options, baseUrl: () => getClientEndpoint('pluginApiBaseUrl') })))(apiPath, options);
        } catch (error) {
          if (error instanceof ServerApiError) throw new PluginPublisherApiError(error.code, error.statusCode, error.message);
          throw error;
        }
      },
    });
  }
}
