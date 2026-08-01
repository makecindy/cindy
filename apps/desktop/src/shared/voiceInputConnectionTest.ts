import { IPC_CHANNELS } from '@cindy/cindy-ipc';
import type { VoiceInputProviderKind } from './voiceInputAsrProfiles.js';

export const VOICE_INPUT_TEST_CONNECTION_CHANNEL = IPC_CHANNELS.VOICE_INPUT.TEST_CONNECTION;

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
