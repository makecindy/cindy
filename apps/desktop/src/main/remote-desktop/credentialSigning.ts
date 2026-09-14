/** Development helpers need a certificate-backed identity that survives rebuilds. */
export const credentialSigningIdentifier = 'co.cindy.remote-credentials.development';

export function credentialSigningIdentity(value: string | undefined): string {
  const identity = value?.trim();
  // Require an exact certificate fingerprint, not codesign's ambiguous name match.
  if (!identity || !/^[a-fA-F0-9]{40}$/.test(identity)) {
    throw new Error('CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED');
  }
  return identity.toUpperCase();
}

export function credentialSigningArguments(identity: string, binary: string): string[] {
  return [
    '--force',
    '--sign',
    credentialSigningIdentity(identity),
    '--identifier',
    credentialSigningIdentifier,
    '--timestamp=none',
    binary,
  ];
}

export function credentialVerificationArguments(binary: string, identity: string): string[] {
  return [
    '--verify',
    '--strict',
    '-R',
    `=anchor apple generic and identifier "${credentialSigningIdentifier}" and certificate leaf = H"${credentialSigningIdentity(identity)}"`,
    binary,
  ];
}
