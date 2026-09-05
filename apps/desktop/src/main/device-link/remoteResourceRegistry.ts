import type {
  RemoteActionInvokeRequest,
  RemoteActionInvokeResponse,
  RemoteCollectionDescriptor,
  RemoteCollectionListRequest,
  RemoteCollectionListResponse,
  RemoteResource,
  RemoteResourceGetRequest,
  RemoteResourceManifestRequest,
  RemoteResourceManifestResponse,
} from '@cindy/device-link';
import { REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';

export interface RemoteResourceHostContext {
  /** Server-stamped device id. Providers may use it for per-controller view state, never auth. */
  controllerDeviceId: string;
}

export interface RemoteResourceProvider {
  collection: RemoteCollectionDescriptor;
  list(
    context: RemoteResourceHostContext,
    request: RemoteCollectionListRequest,
  ): Promise<RemoteCollectionListResponse>;
  get?(
    context: RemoteResourceHostContext,
    request: RemoteResourceGetRequest,
  ): Promise<RemoteResource>;
  invoke?(
    context: RemoteResourceHostContext,
    request: RemoteActionInvokeRequest,
  ): Promise<RemoteActionInvokeResponse>;
}

export type RemoteResourceRegistryErrorCode =
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INTERNAL';

export class RemoteResourceRegistryError extends Error {
  constructor(
    readonly code: RemoteResourceRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteResourceRegistryError';
  }
}

function assertProviderResult(
  provider: RemoteResourceProvider,
  response: RemoteCollectionListResponse,
): void {
  if (response.collectionId !== provider.collection.id) {
    throw new RemoteResourceRegistryError('INTERNAL', 'provider returned the wrong collection');
  }
  for (const item of response.items) {
    if (
      item.ref.collectionId !== provider.collection.id
      || item.ref.kind !== provider.collection.resourceKind
    ) {
      throw new RemoteResourceRegistryError('INTERNAL', 'provider returned an out-of-scope resource');
    }
  }
}

/**
 * Host-side hypermedia registry. Modules depend on this narrow connection point;
 * the device-link IPC adapter does not import their databases or services.
 */
export class RemoteResourceRegistry {
  private readonly providers = new Map<string, RemoteResourceProvider>();

  register(provider: RemoteResourceProvider): () => void {
    const collectionId = provider.collection.id;
    if (!collectionId || this.providers.has(collectionId)) {
      throw new RemoteResourceRegistryError(
        this.providers.has(collectionId) ? 'ALREADY_EXISTS' : 'INTERNAL',
        this.providers.has(collectionId)
          ? `remote resource collection '${collectionId}' is already registered`
          : 'remote resource collection id is required',
      );
    }
    this.providers.set(collectionId, provider);
    return () => {
      if (this.providers.get(collectionId) === provider) this.providers.delete(collectionId);
    };
  }

  manifest(
    _context: RemoteResourceHostContext,
    _request: RemoteResourceManifestRequest,
  ): RemoteResourceManifestResponse {
    return {
      protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
      collections: [...this.providers.values()]
        .map((provider) => provider.collection)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async list(
    context: RemoteResourceHostContext,
    request: RemoteCollectionListRequest,
  ): Promise<RemoteCollectionListResponse> {
    const provider = this.requireProvider(request.collectionId);
    const response = await provider.list(context, request);
    assertProviderResult(provider, response);
    return response;
  }

  async get(
    context: RemoteResourceHostContext,
    request: RemoteResourceGetRequest,
  ): Promise<RemoteResource> {
    const provider = this.requireProvider(request.ref.collectionId);
    if (request.ref.kind !== provider.collection.resourceKind) {
      throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource kind does not exist');
    }
    if (!provider.get) {
      throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'resource details are not available');
    }
    const resource = await provider.get(context, request);
    if (
      resource.ref.collectionId !== provider.collection.id
      || resource.ref.kind !== provider.collection.resourceKind
      || resource.ref.id !== request.ref.id
    ) {
      throw new RemoteResourceRegistryError('INTERNAL', 'provider returned the wrong resource');
    }
    return resource;
  }

  async invoke(
    context: RemoteResourceHostContext,
    request: RemoteActionInvokeRequest,
  ): Promise<RemoteActionInvokeResponse> {
    const provider = this.requireProvider(request.collectionId);
    if (
      request.resourceRef
      && (
        request.resourceRef.collectionId !== provider.collection.id
        || request.resourceRef.kind !== provider.collection.resourceKind
      )
    ) {
      throw new RemoteResourceRegistryError('NOT_FOUND', 'remote action resource does not exist');
    }
    if (!provider.invoke) {
      throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'remote actions are not available');
    }
    return provider.invoke(context, request);
  }

  private requireProvider(collectionId: string): RemoteResourceProvider {
    const provider = this.providers.get(collectionId);
    if (!provider) {
      throw new RemoteResourceRegistryError(
        'NOT_FOUND',
        `remote resource collection '${collectionId}' does not exist`,
      );
    }
    return provider;
  }
}

export const remoteResourceRegistry = new RemoteResourceRegistry();
