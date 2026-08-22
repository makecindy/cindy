import { useAuth } from '@/contexts/AuthContext';
import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';

import { GhostMainViewHost } from './GhostMainViewHost';
import { ghostWebviewOwnerKey } from './lib/ghostPluginViewModel';

/** Seeds the shared app sidebar even on a cold deep link to /apps/:ghostId. */
export function GhostMainViewFeatureLayout() {
  useRegisterCCAgentSidebar();
  const { mode, dataOwnerId } = useAuth();
  return <GhostMainViewHost key={ghostWebviewOwnerKey(mode, dataOwnerId)} />;
}
