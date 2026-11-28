import { lazy, Suspense, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MyDevicesCloudSlot } from '@/components/settings/MyDevicesPanel';
import { useCloudInstanceAccess } from './CloudInstanceAccess';

// The instance operations load only for an admitted account, so the settings page an ordinary
// account opens carries none of them.
const AdmittedCloudDeviceDirectory = lazy(() =>
  import('./AdmittedCloudDeviceDirectory').then((module) => ({
    default: module.AdmittedCloudDeviceDirectory,
  })),
);

/**
 * Cloud instance operations for Settings → Remote connections → My devices:
 * a cloud instance is one of the account's devices, so its lifecycle lives on that card.
 * Only an admitted account (CloudInstanceAccess) gets the slot; everyone else sees the
 * plain device list and no CIS request is made. The device directory decides
 * remote control (presence, toggles, remote desktop availability); CIS decides lifecycle.
 */
export function CloudDeviceDirectory({
  enabled,
  directory,
  names,
  offline = [],
  devicesOpen,
  children,
}: {
  enabled: boolean;
  /** Device ids the device directory lists; null until it has loaded once. */
  directory: readonly string[] | null;
  /** The device list's names by device id: a cloud Cindy shows the name the list has for it. */
  names?: ReadonlyMap<string, string>;
  /** Listed device ids DeviceLink currently has offline. */
  offline?: readonly string[];
  /** My devices is expanded; coming back from an instance's settings restores it. */
  devicesOpen: boolean;
  children(cloud: MyDevicesCloudSlot | undefined): ReactNode;
}) {
  const access = useCloudInstanceAccess();
  const { mode, dataOwnerId } = useAuth();
  if (!enabled || mode !== 'cloud' || access !== 'allowed') return <>{children(undefined)}</>;
  // A new account or owner generation starts from an empty list and drops any draft. The plain
  // device list stays in place while the operations load.
  return (
    <Suspense fallback={children(undefined)}>
      <AdmittedCloudDeviceDirectory
        key={JSON.stringify([dataOwnerId, getDataOwnerGeneration().generation])}
        directory={directory}
        names={names}
        offline={offline}
        devicesOpen={devicesOpen}
      >
        {children}
      </AdmittedCloudDeviceDirectory>
    </Suspense>
  );
}
