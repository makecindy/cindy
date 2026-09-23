/**
 * Organization BYOK image channel.
 *
 * Art only executes providers that have a registered image channel. Independent
 * enterprise image models already appear in the catalog as `imageModels`, but
 * BYOK ids are not xd/openai/gemini/xai, so they need their own runtime
 * registration. One channel per organization provider that actually declares
 * imageModels; chat-only BYOK stays unregistered. Closures read the live
 * member key and inference origin so rotate/logout flip ready() without
 * re-registering. Removed accounts are unregistered before either dynamic
 * channel type is added, so a reused ID cannot retain the previous route.
 * The catalog alias is sent as `model` — do not strip the
 * `byok-<uuid>/` prefix.
 */

import { isOrganizationManagedProvider, type Provider } from '@cindy/model-providers';

import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import {
  createGatewayImageClient,
  type CreateGatewayImageClientOptions,
} from '../cindy-proxy-media/api/gatewayImageClient.js';
import type { ImageChannel, ImageChannelRegistry } from './imageChannelRegistry.js';

/**
 * Consciousness aspect → gpt-image size enum. Mirrors LEGACY_SIZES in
 * cindy-media/imageParameters.ts.
 */
const GHOST_ASPECT_TO_GATEWAY_SIZE: Record<GhostImageAspectRatio, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};

type ByokImageProviderSlice = Pick<Provider, 'id' | 'name' | 'source'> & {
  imageModels?: Provider['imageModels'];
};

export interface CreateByokImageChannelOptions {
  brandLabel?: string;
  getApiKey(): string | null;
  getBaseUrl(): string | null;
  getSupportsEdit(): boolean;
  fetchImplementation?: typeof fetch;
  logger?: CreateGatewayImageClientOptions['logger'];
  beforeDispatch?(model: string): void;
}

export function createByokImageChannel(opts: CreateByokImageChannelOptions): ImageChannel {
  const brandLabel = opts.brandLabel?.trim() || '企业模型';

  const client = () => {
    const baseUrl = opts.getBaseUrl()?.trim() ?? '';
    if (!baseUrl) {
      throw new Error(`${brandLabel} 图像通道的推理地址未就绪,请重新登录后重试`);
    }
    return createGatewayImageClient({
      getApiKey: opts.getApiKey,
      logger: opts.logger,
      fetchImplementation: opts.fetchImplementation,
      proxy: {
        baseUrl,
        generatePath: '/v1/images/generations',
        editPath: '/v1/images/edits',
      },
      brandLabel,
      supportsEdit: opts.getSupportsEdit(),
      missingKeyMessage: `${brandLabel} 图像凭证未就绪,请重新登录或在设置中刷新组织模型`,
      beforeDispatch: opts.beforeDispatch,
    });
  };

  const size = (aspectRatio?: string) =>
    aspectRatio && aspectRatio in GHOST_ASPECT_TO_GATEWAY_SIZE
      ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[aspectRatio as GhostImageAspectRatio] }
      : {};

  return {
    imageProtocol: 'openai',
    ready: () => Boolean(opts.getApiKey()?.trim() && opts.getBaseUrl()?.trim()),
    get supportsEdit() {
      return opts.getSupportsEdit();
    },
    generateImage: ({ model, prompt, aspectRatio, size: requestedSize, quality, signal }) =>
      client().generateImage(
        {
          model,
          prompt,
          ...(requestedSize ? { size: requestedSize } : size(aspectRatio)),
          ...(quality ? { quality } : {}),
        },
        signal,
      ),
    editImage: ({ model, prompt, imagePaths, aspectRatio, size: requestedSize, quality, signal }) =>
      client().editImage(
        {
          model,
          prompt,
          imagePaths,
          ...(requestedSize ? { size: requestedSize } : size(aspectRatio)),
          ...(quality ? { quality } : {}),
        },
        signal,
      ),
  };
}

/** Release obsolete dynamic channels before registering either kind of account. */
export function pruneDynamicImageChannels(
  registry: ImageChannelRegistry,
  providers: readonly Provider[],
  registeredCodex: Set<string>,
  registeredByok: Set<string>,
): void {
  const codexIds = new Set(providers.filter((provider) =>
    !isOrganizationManagedProvider(provider) && provider.auth.native === 'codex',
  ).map((provider) => provider.id));
  const byokIds = new Set(providers.filter((provider) =>
    isOrganizationManagedProvider(provider) && provider.imageModels?.length,
  ).map((provider) => provider.id));
  // Prune both kinds before registering either: their IDs can collide across owners.
  for (const [registered, current] of [[registeredCodex, codexIds], [registeredByok, byokIds]]) {
    for (const id of registered) {
      if (current.has(id)) continue;
      registry.unregister(id);
      registered.delete(id);
    }
  }
}

/** Register one Art channel per organization provider that currently has imageModels. */
export function registerByokImageChannels(
  registry: ImageChannelRegistry,
  providers: readonly ByokImageProviderSlice[],
  registered: Set<string>,
  createChannel: (provider: ByokImageProviderSlice) => ImageChannel,
): void {
  for (const provider of providers) {
    if (
      !isOrganizationManagedProvider(provider) ||
      registered.has(provider.id) ||
      !provider.imageModels?.length
    ) {
      continue;
    }
    registry.register(provider.id, createChannel(provider));
    registered.add(provider.id);
  }
}
