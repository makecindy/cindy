import { ghostSecretStorageKey, providerSecretStorageKey } from '../../shared/providerSecrets.js';

/** Main supplies approved original-install evidence while holding its mutation lock. */
export function migrateGhostSecretAliases(
  target: { instanceKey: string; ghostId: string; eligible: boolean },
  io: { isAvailable(): boolean; read(key: string): string | null; write(key: string, value: string): boolean },
): boolean {
  if (!target.eligible || target.instanceKey !== target.ghostId) return true;
  const aliases = target.ghostId === 'cindy-web-search'
    ? [['brave_api_key', providerSecretStorageKey('brave')], ['tavily_api_key', providerSecretStorageKey('tavily')]]
    : target.ghostId === 'xd-mivo' ? [['mivo_api_key', providerSecretStorageKey('mivo')]] : [];
  if (aliases.length === 0) return true;
  if (!io.isAvailable()) return false;
  // Owner scoped and retained across uninstall. A later reinstall must not claim old keys.
  const marker = `ghost_alias_migration_${target.instanceKey}`;
  if (io.read(marker) === 'complete') return true;
  for (const [secretKey, alias] of aliases) {
    const destination = ghostSecretStorageKey(target.instanceKey, secretKey!);
    if (io.read(destination) !== null) continue;
    const value = io.read(alias!);
    if (value !== null && (!io.write(destination, value) || io.read(destination) !== value)) {
      throw new Error('Historical plugin credential migration could not be verified');
    }
  }
  if (!io.write(marker, 'complete')) throw new Error('Historical plugin credential migration could not be recorded');
  return true;
}
