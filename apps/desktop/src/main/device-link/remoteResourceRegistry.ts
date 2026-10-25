// The registry is shared by GUI and terminal hosts; feature providers retain
// their existing business authorization and storage adapters.
export { RemoteResourceRegistry, RemoteResourceRegistryError } from '@cindy/device-link';
export type { RemoteResourceHostContext, RemoteResourceProvider, RemoteResourceRegistryErrorCode } from '@cindy/device-link';
import { RemoteResourceRegistry } from '@cindy/device-link';
export const remoteResourceRegistry = new RemoteResourceRegistry();
