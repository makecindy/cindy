export type VoiceInputRecoverySettingsTab = 'voice-input' | 'providers';

export type VoiceInputReadinessRecovery = {
  messageKey:
    | 'voiceInputOverlay.cindyServiceUnavailable'
    | 'settings.voiceInput.serviceSource.credentialError.codexMissing'
    | 'settings.voiceInput.serviceSource.credentialError.elevenlabsMissing'
    | 'settings.voiceInput.serviceSource.credentialError.gatewayMissing'
    | 'settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing'
    | 'settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing'
    | 'settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported';
  settingsTab: VoiceInputRecoverySettingsTab;
};

type VoiceInputReadinessLike = {
  auth: 'api-key' | 'codex';
  provider: string;
  failureReason?: 'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
};

/**
 * Turns the main-process readiness result into a deterministic recovery path.
 * Managed-service failures return to Voice Input settings so users can retry
 * or opt into BYOK; BYOK credential failures go to the provider catalog.
 */
export function resolveVoiceInputReadinessRecovery(
  readiness: VoiceInputReadinessLike,
  serviceMode: 'cindy' | 'byok',
): VoiceInputReadinessRecovery {
  if (serviceMode === 'cindy') {
    return {
      messageKey: 'voiceInputOverlay.cindyServiceUnavailable',
      settingsTab: 'voice-input',
    };
  }
  if (readiness.failureReason === 'custom-asr-config-missing') {
    return {
      messageKey: 'settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing',
      settingsTab: 'voice-input',
    };
  }
  if (readiness.failureReason === 'custom-asr-key-missing') {
    return {
      messageKey: 'settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing',
      settingsTab: 'voice-input',
    };
  }
  if (readiness.failureReason === 'codex-realtime-unsupported') {
    return {
      messageKey: 'settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported',
      settingsTab: 'voice-input',
    };
  }
  if (readiness.auth === 'codex') {
    return {
      messageKey: 'settings.voiceInput.serviceSource.credentialError.codexMissing',
      settingsTab: 'providers',
    };
  }
  if (readiness.provider.startsWith('elevenlabs')) {
    return {
      messageKey: 'settings.voiceInput.serviceSource.credentialError.elevenlabsMissing',
      // Direct ElevenLabs reads an environment variable rather than a model
      // provider credential. Voice Input settings explains that requirement
      // and lets the user switch to another ASR/service source.
      settingsTab: 'voice-input',
    };
  }
  return {
    messageKey: 'settings.voiceInput.serviceSource.credentialError.gatewayMissing',
    settingsTab: 'providers',
  };
}
