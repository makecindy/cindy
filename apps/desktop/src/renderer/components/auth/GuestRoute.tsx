import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function GuestRoute() {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const destination = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/login') ? returnTo : '/';
  const { mode, isInitializing } = useAuth();

  if (isInitializing) return null;
  if (mode === 'cloud' || mode === 'local') return <Navigate to={destination} replace />;
  return <Outlet />;
}
