/**
 * Pure, Electron-free helpers for distinguishing safeStorage backend health,
 * filesystem I/O errors, and permanently undecryptable legacy ciphertexts.
 *
 * Separating these failure modes lets explicit sign-in:
 * 1. Fail fast BEFORE sending verification codes or launching browser auth
 *    when the OS keychain / encryption backend cannot encrypt+decrypt in this
 *    process (preventing rate-limit lockouts and enabling process recovery).
 * 2. Replace a permanently undecryptable old account vault on explicit sign-in
 *    ONLY after proving the current encryption backend can round-trip new data
 *    and the failure was not a filesystem I/O error.
 */

const SAFE_STORAGE_PROBE_PLAINTEXT = 'cindy-safe-storage-round-trip-probe-v1';

export interface SafeStorageCryptoLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type SafeStorageProbeResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'round-trip-failed'; error?: unknown };

export type AtomicSafeReadResult =
  | { status: 'ok'; value: string; recoveredFromBackup?: true }
  | { status: 'absent' }
  | { status: 'backend-unavailable' }
  | { status: 'io-error'; error: unknown }
  | { status: 'decrypt-failed'; ciphertext: string; error: unknown };

export type ExplicitLoginVaultRecoveryDecision =
  | {
      recover: true;
      stage: 'decrypt-mismatch';
      probeOk: true;
      previousCiphertext: string;
    }
  | { recover: false; stage: 'io' }
  | { recover: false; stage: 'backend'; probeOk: false; error?: unknown };

/**
 * In-memory encrypt -> decrypt self-test. Never touches disk and must only be
 * invoked on explicit user login actions (never during startup).
 */
export function probeSafeStorageRoundTrip(
  crypto: SafeStorageCryptoLike,
): SafeStorageProbeResult {
  if (!crypto.isEncryptionAvailable()) {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const encrypted = crypto.encryptString(SAFE_STORAGE_PROBE_PLAINTEXT);
    const decrypted = crypto.decryptString(encrypted);
    if (decrypted !== SAFE_STORAGE_PROBE_PLAINTEXT) {
      return {
        ok: false,
        reason: 'round-trip-failed',
        error: new Error('safeStorage round-trip mismatch'),
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'round-trip-failed', error };
  }
}

/**
 * Read and decrypt an atomic `.enc` (with `.enc.bak` fallback) record while
 * keeping backend unavailability, filesystem I/O errors, and decryption errors
 * distinct.
 */
export function readAtomicSafeRecord(deps: {
  isEncryptionAvailable: () => boolean;
  readFileUtf8: (filepath: string) => string;
  decryptBase64: (base64Ciphertext: string) => string;
  filepath: string;
  recoverFromBackup?: boolean;
}): AtomicSafeReadResult {
  if (!deps.isEncryptionAvailable()) {
    return { status: 'backend-unavailable' };
  }
  function readOne(filepath: string): AtomicSafeReadResult {
    let content: string;
    try {
      content = deps.readFileUtf8(filepath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent' };
      return { status: 'io-error', error };
    }
    try {
      return { status: 'ok', value: deps.decryptBase64(content) };
    } catch (error) {
      return { status: 'decrypt-failed', ciphertext: content, error };
    }
  }

  const primary = readOne(deps.filepath);
  if (primary.status === 'absent') return readOne(`${deps.filepath}.bak`);
  if (primary.status === 'decrypt-failed' && deps.recoverFromBackup) {
    const backup = readOne(`${deps.filepath}.bak`);
    if (backup.status === 'ok') return { ...backup, recoveredFromBackup: true };
    if (backup.status === 'io-error') return backup;
  }
  return primary;
}

/**
 * Decide whether an explicit login transaction may replace an unreadable vault
 * file. Replacement is allowed ONLY when reading the file succeeded, decryption
 * threw, AND a live in-memory round-trip proves the OS encryption backend is
 * healthy right now.
 */
export function evaluateExplicitLoginVaultRecovery(
  readResult: Exclude<AtomicSafeReadResult, { status: 'ok' } | { status: 'absent' }>,
  probeBackend: () => SafeStorageProbeResult,
): ExplicitLoginVaultRecoveryDecision {
  if (readResult.status === 'io-error') {
    return { recover: false, stage: 'io' };
  }
  if (readResult.status === 'backend-unavailable') {
    return { recover: false, stage: 'backend', probeOk: false };
  }
  const probe = probeBackend();
  if (!probe.ok) {
    return {
      recover: false,
      stage: 'backend',
      probeOk: false,
      ...(probe.error !== undefined ? { error: probe.error } : {}),
    };
  }
  return {
    recover: true,
    stage: 'decrypt-mismatch',
    probeOk: true,
    previousCiphertext: readResult.ciphertext,
  };
}
