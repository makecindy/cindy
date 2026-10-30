import { useSyncExternalStore, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { usePluginDeviceDirectory, type CatalogDeviceControl } from './PluginDevicePicker';
export type { CatalogDeviceControl } from './PluginDevicePicker';

export type CatalogDevice = { deviceId: string; name: string };
let selection: { owner: DataOwnerGeneration; device: CatalogDevice | null } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Plugins and Skills share only the selected host, never their local data stores. */
export function useCatalogDevice() {
  const { dataOwnerId, isAuthenticated } = useAuth();
  const owner = getDataOwnerGeneration();
  const snapshot = useSyncExternalStore(subscribe, () => selection);
  const device =
    isAuthenticated &&
    snapshot?.owner.dataOwnerId === dataOwnerId &&
    snapshot.owner.generation === owner.generation
      ? snapshot.device
      : null;
  const selectDevice = (next: CatalogDevice | null) => {
    selection = { owner: getDataOwnerGeneration(), device: next };
    listeners.forEach((listener) => listener());
  };
  return { device, selectDevice, isAuthenticated, generation: owner.generation };
}

type CatalogContent = (
  device: CatalogDevice | null,
  online: boolean,
  generation: number,
  deviceControl?: CatalogDeviceControl,
) => ReactNode;

/** Share the host selection; each page places one menu in its page heading. */
export function CatalogDeviceScope({ children }: { children: CatalogContent }) {
  const scope = useCatalogDevice();
  return scope.isAuthenticated ? (
    <ConnectedCatalogScope scope={scope}>{children}</ConnectedCatalogScope>
  ) : (
    children(null, true, scope.generation)
  );
}

function ConnectedCatalogScope({
  scope,
  children,
}: {
  scope: ReturnType<typeof useCatalogDevice>;
  children: CatalogContent;
}) {
  const directory = usePluginDeviceDirectory(scope.device);
  return children(scope.device, directory.online, scope.generation, {
    selected: scope.device,
    onSelect: scope.selectDevice,
    directory,
  });
}
