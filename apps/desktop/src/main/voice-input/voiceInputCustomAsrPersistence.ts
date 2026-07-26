export type CustomAsrSecretUpdate =
  | { action: 'none' }
  | { action: 'set'; value: string }
  | { action: 'clear' };

export type CustomAsrSecretStore = {
  get(id: 'voice-asr'): string | null;
  set(id: 'voice-asr', value: string): boolean;
  remove(id: 'voice-asr'): { success: boolean; error?: string };
};

/**
 * Persist a custom ASR secret and model-selection patch as one best-effort
 * transaction. The secret is applied first so config is never committed after
 * a rejected safeStorage write; a config failure restores the previous secret.
 */
export function persistVoiceInputSelectionWithCustomAsrSecret<T>(
  persistSelection: () => T,
  secretStore: CustomAsrSecretStore,
  secretUpdate: CustomAsrSecretUpdate,
): T {
  if (secretUpdate.action === 'none') return persistSelection();

  const previousSecret = secretStore.get('voice-asr');
  applySecretUpdate(secretStore, secretUpdate);
  try {
    return persistSelection();
  } catch (error) {
    if (!restoreSecret(secretStore, previousSecret)) {
      const quarantined = quarantineSecret(secretStore);
      throw new Error(
        quarantined
          ? 'Failed to save voice input model selection; the ASR key was cleared because restoring it failed.'
          : 'Failed to save voice input model selection and restore the previous ASR key.',
        { cause: error },
      );
    }
    throw error;
  }
}

function applySecretUpdate(
  secretStore: CustomAsrSecretStore,
  secretUpdate: Exclude<CustomAsrSecretUpdate, { action: 'none' }>,
): void {
  if (secretUpdate.action === 'set') {
    if (!secretStore.set('voice-asr', secretUpdate.value)) {
      throw new Error('Failed to store the custom ASR API key.');
    }
    return;
  }
  if (!secretStore.remove('voice-asr').success) {
    throw new Error('Failed to remove the custom ASR API key.');
  }
}

function restoreSecret(
  secretStore: CustomAsrSecretStore,
  previousSecret: string | null,
): boolean {
  try {
    return previousSecret === null
      ? secretStore.remove('voice-asr').success
      : secretStore.set('voice-asr', previousSecret);
  } catch {
    return false;
  }
}

/**
 * If compensation cannot restore the previous secret, remove the uncertain
 * value so the old config fails closed instead of pairing with the new key.
 */
function quarantineSecret(secretStore: CustomAsrSecretStore): boolean {
  try {
    return secretStore.remove('voice-asr').success;
  } catch {
    return false;
  }
}
