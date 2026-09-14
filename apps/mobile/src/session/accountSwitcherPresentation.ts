import type { MobileSavedAccount } from '@/auth/mobileAccountVault';

export interface AccountSwitcherPresentation {
  imageUrl: string | null;
  isOrg: boolean;
  subtitle: string | null;
  title: string;
}

export function presentSavedAccount(
  account: MobileSavedAccount,
): AccountSwitcherPresentation {
  const isOrg = account.kind === 'org';
  return {
    isOrg,
    imageUrl: isOrg ? account.orgLogoUrl : account.avatarUrl,
    title: isOrg
      ? account.orgName || account.displayName
      : account.displayName || account.email || 'Cindy',
    subtitle: isOrg ? account.displayName : account.email,
  };
}
