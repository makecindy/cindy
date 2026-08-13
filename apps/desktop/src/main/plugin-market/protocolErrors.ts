/**
 * The market protocol validates the current release manifest while parsing a
 * detail response. Keep this narrow: malformed envelopes must remain an
 * internal/network failure, while an unsupported manifest gets actionable UI.
 */
export function isPluginManifestIncompatibilityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'PluginProtocolError' &&
    error.message.includes('currentRelease.manifest') &&
    !isPluginHostUnsupportedError(error)
  );
}

/**
 * A valid future manifest must remain distinguishable from a malformed one.
 * The protocol validator deliberately reports these two compatibility signals
 * in the manifest reason so the desktop can give upgrade guidance.
 */
export function isPluginHostUnsupportedError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== 'PluginProtocolError' ||
    !error.message.includes('currentRelease.manifest')
  ) {
    return false;
  }

  return (
    error.message.includes('schemaVersion 必须是') ||
    error.message.includes('slots 含未知卡槽')
  );
}
