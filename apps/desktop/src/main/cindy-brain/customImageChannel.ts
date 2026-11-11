/**
 * Standalone OpenAI Images for user connections. The model's sourceAgent owns
 * its endpoint, encrypted key and headers; chat compatibility alone never opts
 * a connection into media. No supplier names or proxy-specific adapters.
 */
import { type AgentKind, type Provider } from '@cindy/model-providers';
import { isCustomImageProvider, resolveCustomMediaConnection } from './customMediaConnection.js';
export { isCustomImageProvider } from './customMediaConnection.js';
import { normalizeImageParameters } from '../cindy-media/imageParameters.js';
import {
  createGatewayImageClient,
  type CreateGatewayImageClientOptions,
} from '../cindy-proxy-media/api/gatewayImageClient.js';
import type { ImageChannel, ImageChannelRegistry } from './imageChannelRegistry.js';

export interface CustomImageChannelOptions {
  getProvider(): Provider | undefined;
  readApiKey(agent: AgentKind): string | null;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  fetchImplementation: typeof fetch;
  beforeDispatch(model: string): void;
  logger?: CreateGatewayImageClientOptions['logger'];
}


export function createCustomImageChannel(opts: CustomImageChannelOptions): ImageChannel {
  const connection = (model: string) => resolveCustomMediaConnection(opts, model);
  const ready = () =>
    !opts.isOwnerBoundaryPending() &&
    (opts.getProvider()?.imageModels ?? []).some((model) => connection(model.id) !== null);

  const invoke = async (
    operation: 'generate' | 'edit',
    params: Parameters<ImageChannel['editImage']>[0],
  ) => {
    const owner = opts.getOwnerScopeKey();
    const binding = connection(params.model);
    if (!binding) throw new Error('所选图像来源的 OpenAI Images 接口或凭证未就绪');
    const assertOwner = () => {
      if (opts.isOwnerBoundaryPending() || owner !== opts.getOwnerScopeKey()) {
        throw new Error('图像请求期间账号已切换，本次操作已取消');
      }
    };
    const client = createGatewayImageClient({
      getApiKey: () => null,
      getRequestHeaders: () => binding.headers,
      proxy: {
        baseUrl: binding.baseUrl,
        generatePath: '/images/generations',
        editPath: '/images/edits',
      },
      brandLabel: opts.getProvider()?.name,
      // Same complete-response budget as Core's image guide, before JSON/base64 allocation.
      maxResponseBytes: 32 * 1024 * 1024,
      logger: opts.logger,
      // Custom credential headers must never follow a redirect to another endpoint.
      fetchImplementation: (url, init) => {
        assertOwner();
        return opts.fetchImplementation(url, { ...init, redirect: 'error' });
      },
      beforeDispatch: () => {
        assertOwner();
        params.signal?.throwIfAborted();
        const current = connection(params.model);
        if (
          !current ||
          current.agent !== binding.agent ||
          current.baseUrl !== binding.baseUrl ||
          JSON.stringify(current.headers) !== JSON.stringify(binding.headers)
        ) {
          throw new Error('图像来源配置已变化，本次请求未发出');
        }
        opts.beforeDispatch(params.model);
      },
    });
    const normalized = normalizeImageParameters('openai', params.model, params);
    const input = { model: params.model, prompt: params.prompt, ...normalized };
    const result =
      operation === 'edit'
        ? await client.editImage({ ...input, imagePaths: params.imagePaths }, params.signal)
        : await client.generateImage(input, params.signal);
    assertOwner();
    return result;
  };

  return {
    imageProtocol: 'openai',
    legacyCompatible: false,
    ready,
    isModelReady: (model) => connection(model) !== null,
    generateImage: (params) => invoke('generate', { ...params, imagePaths: [] }),
    editImage: (params) => invoke('edit', params),
  };
}

/** Synchronize user connections without overwriting built-in or native subscription channels. */
export function registerCustomImageChannels(
  registry: ImageChannelRegistry,
  providers: readonly Provider[],
  registered: Set<string>,
  createChannel: (providerId: string) => ImageChannel,
): void {
  for (const provider of providers) {
    if (
      !isCustomImageProvider(provider) ||
      registered.has(provider.id) ||
      registry.hasProvider(provider.id)
    )
      continue;
    registry.register(provider.id, createChannel(provider.id));
    registered.add(provider.id);
  }
}
