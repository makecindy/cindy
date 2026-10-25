import { PluginMarketApi as NativeApi, PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES } from '@cindy/plugin-runtime/market/api';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { serverApiFetch } from '../serverApiClient.js';
export * from '@cindy/plugin-runtime/market/api';
const log = createLogger('plugin-market-api');
export class PluginMarketApi extends NativeApi {
  constructor(fetcher?: ConstructorParameters<typeof NativeApi>[0], getClientVersion: () => string = () => '0.0.0') {
    super(fetcher ?? ((apiPath, options) => serverApiFetch(apiPath, {
      ...options, baseUrl: () => getClientEndpoint('pluginApiBaseUrl'),
      redactErrorDetails: true, logLabel: '/api/plugins',
      allowedRedactedErrorCodes: PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES,
    })), getClientVersion, log);
  }
}
