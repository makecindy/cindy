/**
 * Distinguishes an absent legacy value from a transient read failure.
 * Migration callers may safely complete on `missing`, but must keep the
 * stable-owner scope retryable when the old storage could not be inspected.
 */
export type LegacyMigrationRead<T> =
  | { status: 'available'; value: T }
  | { status: 'missing' }
  | { status: 'retryable-failure' };

export function legacyMigrationAvailable<T>(value: T): LegacyMigrationRead<T> {
  return { status: 'available', value };
}

export const LEGACY_MIGRATION_MISSING: LegacyMigrationRead<never> = { status: 'missing' };
export const LEGACY_MIGRATION_RETRYABLE_FAILURE: LegacyMigrationRead<never> = {
  status: 'retryable-failure',
};

/**
 * Read legacy ciphertext before consulting the platform decryptor. A missing
 * file is a completed no-op even while safeStorage is unavailable; only a
 * ciphertext that exists but cannot currently be decrypted remains retryable.
 */
export function readLegacyEncryptedValue(
  readEncoded: () => string,
  isDecryptionAvailable: () => boolean,
  decrypt: (encoded: string) => string,
): LegacyMigrationRead<string> {
  let encoded: string;
  try {
    encoded = readEncoded();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? LEGACY_MIGRATION_MISSING
      : LEGACY_MIGRATION_RETRYABLE_FAILURE;
  }
  if (!isDecryptionAvailable()) return LEGACY_MIGRATION_RETRYABLE_FAILURE;
  try {
    const value = decrypt(encoded);
    return value.length > 0
      ? legacyMigrationAvailable(value)
      : LEGACY_MIGRATION_RETRYABLE_FAILURE;
  } catch {
    return LEGACY_MIGRATION_RETRYABLE_FAILURE;
  }
}
