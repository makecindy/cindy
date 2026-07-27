import { describe, expect, it } from 'vitest';

import { resolveVoiceInputReadinessRecovery } from '../readinessRecovery';

describe('resolveVoiceInputReadinessRecovery', () => {
  it('returns to voice settings when the managed Cindy service is unavailable', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'api-key',
          provider: 'litellm-gpt-realtime-whisper',
        },
        'cindy',
      ),
    ).toEqual({
      messageKey: 'voiceInputOverlay.cindyServiceUnavailable',
      settingsTab: 'voice-input',
    });
  });

  it('identifies Codex login as the missing BYOK credential', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'codex',
          provider: 'openai-realtime-whisper',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.codexMissing',
      settingsTab: 'providers',
    });
  });

  it('identifies an ElevenLabs key as the missing BYOK credential', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'api-key',
          provider: 'elevenlabs-scribe-realtime',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.elevenlabsMissing',
      settingsTab: 'voice-input',
    });
  });

  it('uses the AI gateway credential recovery for other BYOK providers', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'api-key',
          provider: 'litellm-qwen3-asr-flash-realtime',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.gatewayMissing',
      settingsTab: 'providers',
    });
  });

  it('routes incomplete custom ASR setup back to voice input settings', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'api-key',
          provider: 'custom-realtime-asr',
          failureReason: 'custom-asr-config-missing',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.customAsrConfigMissing',
      settingsTab: 'voice-input',
    });

    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'api-key',
          provider: 'custom-realtime-asr',
          failureReason: 'custom-asr-key-missing',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.customAsrKeyMissing',
      settingsTab: 'voice-input',
    });
  });

  it('explains why Codex sign-in cannot power realtime ASR', () => {
    expect(
      resolveVoiceInputReadinessRecovery(
        {
          auth: 'codex',
          provider: 'openai-realtime-whisper',
          failureReason: 'codex-realtime-unsupported',
        },
        'byok',
      ),
    ).toEqual({
      messageKey: 'settings.voiceInput.serviceSource.credentialError.codexRealtimeUnsupported',
      settingsTab: 'voice-input',
    });
  });
});
