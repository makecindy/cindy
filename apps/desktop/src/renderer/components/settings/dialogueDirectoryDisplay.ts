/** Display only. Preserve the original path for copying and never use this for filesystem access. */
export function dialogueDirectoryDisplayParts(directory: string, platform: string): string[] {
  const parts = directory.split(platform === 'win32' ? /[\\/]/ : '/').filter(Boolean);
  const ownerKey = /^[a-f0-9]{20}$/;
  // Custom locations: <selected>/dialogues/<owner>. Keep the account key out of the summary.
  if (parts.at(-2) === 'dialogues' && ownerKey.test(parts.at(-1) ?? '')) {
    return parts.slice(-3, -1);
  }
  // Default locations: <profile>/owners/<owner>/dialogues.
  if (parts.at(-3) === 'owners' && ownerKey.test(parts.at(-2) ?? '') && parts.at(-1) === 'dialogues') {
    return [parts.at(-4) ?? 'Cindy', 'dialogues'];
  }
  return parts.slice(-2);
}
