import type { VoiceInputProviderKind } from './voiceInputAsrProfiles.js';

export const VOICE_INPUT_TEST_CONNECTION_CHANNEL = 'voice-input:test-connection';

export type VoiceInputConnectionTestFailureReason =
  | 'credentials-missing'
  | 'authentication-failed'
  | 'route-unavailable'
  | 'timeout'
  | 'network'
  | 'service-error'
  | 'unsupported-provider';

export type VoiceInputConnectionTestResult =
  | {
      ok: true;
      provider: VoiceInputProviderKind;
      providerModel: string;
    }
  | {
      ok: false;
      provider: VoiceInputProviderKind;
      providerModel: string;
      reason: VoiceInputConnectionTestFailureReason;
    };
