import { useAuth } from '@/contexts/AuthContext';
import { AccountDeletionSection } from './AccountDeletionSection';

export function LogoutSection() {
  const { mode } = useAuth();

  // Local mode has no Cindy account or credentials to revoke. Keep account
  // deletion exclusive to authenticated cloud sessions; the logout action now
  // lives beside the profile card so account actions stay together.
  if (mode !== 'cloud') return null;

  return <AccountDeletionSection />;
}
