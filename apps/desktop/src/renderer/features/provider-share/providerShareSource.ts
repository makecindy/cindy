import { createContext, useContext } from 'react';

import type { ReceivedSnapshot } from './providerShareStore';

/**
 * Shares as seen by another device (the cloud instance settings page): its received list and
 * the guest actions it runs itself. Absent locally, where this device's store and IPC apply.
 */
export interface ProviderShareSource {
  received: ReceivedSnapshot;
  command: Window['electronAPI']['providerShare']['command'];
}

export const ProviderShareSourceContext = createContext<ProviderShareSource | null>(null);

export function useProviderShareSource(): ProviderShareSource | null {
  return useContext(ProviderShareSourceContext);
}
