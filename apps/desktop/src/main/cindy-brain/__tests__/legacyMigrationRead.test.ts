import { describe, expect, it, vi } from 'vitest';

import { readLegacyEncryptedValue } from '../legacyMigrationRead.js';

describe('readLegacyEncryptedValue', () => {
  it('classifies an absent legacy file as missing before checking decryption availability', () => {
    const isDecryptionAvailable = vi.fn(() => false);
    const result = readLegacyEncryptedValue(
      () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      isDecryptionAvailable,
      () => 'unused',
    );

    expect(result).toEqual({ status: 'missing' });
    expect(isDecryptionAvailable).not.toHaveBeenCalled();
  });

  it('keeps an existing ciphertext retryable while decryption is unavailable', () => {
    const decrypt = vi.fn(() => 'unused');
    const result = readLegacyEncryptedValue(
      () => 'ciphertext',
      () => false,
      decrypt,
    );

    expect(result).toEqual({ status: 'retryable-failure' });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('returns the decrypted value when ciphertext and the decryptor are available', () => {
    expect(readLegacyEncryptedValue(
      () => 'ciphertext',
      () => true,
      () => 'legacy-token',
    )).toEqual({ status: 'available', value: 'legacy-token' });
  });
});
