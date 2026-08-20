import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function ProtectedRoute() {
  const { mode, isInitializing, dataOwnerId } = useAuth();

  if (isInitializing) return null;
  // Only a real signed-out session belongs on /login. Owner-boundary pending
  // (same-owner token refresh / Ghost repair) must keep the shell mounted.
  if (mode === 'signed-out') return <Navigate to="/login" replace />;
  // Owner changes must remount the protected tree so transient New Maker
  // drafts and other route-local state cannot leak across data namespaces.
  return <Outlet key={dataOwnerId ?? 'signed-out'} />;
}
