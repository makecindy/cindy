/**
 * The market protocol validates the current release manifest while parsing a
 * detail response. Keep this narrow: malformed envelopes must remain an
 * internal/network failure, while an unsupported manifest gets actionable UI.
 */
export function isPluginManifestIncompatibilityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'PluginProtocolError' &&
    error.message.includes('.manifest')
  );
}
