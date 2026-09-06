/** Hidden and archived companions are recoverable through the local Desktop only. */
export function isBotVisibleRemotely(profile: { hiddenAt: number | null; status: string }): boolean {
  return !profile.hiddenAt && profile.status !== 'archived';
}
