import type { AsrProvider } from '@cindy/voice-input-core';

import type {
  VoiceInputConnectionTestFailureReason,
  VoiceInputConnectionTestResult,
} from '../../shared/voiceInputConnectionTest.js';
import type { VoiceInputProviderKind } from '../../shared/voiceInputAsrProfiles.js';

export type VoiceInputConnectionTestOptions = {
  provider: VoiceInputProviderKind;
  providerModel: string;
  /** Stable, non-secret identity of the configuration being probed. */
  configurationKey?: string;
  createProvider: () => Promise<AsrProvider>;
  onError?: (error: unknown) => void;
};

let activeConnectionTest: {
  key: string;
  promise: Promise<VoiceInputConnectionTestResult>;
} | null = null;

/**
 * Coalesce connection probes in Main so a compromised renderer cannot create
 * an unbounded queue or simultaneous outbound WebSocket handshakes.
 */
export function runSerializedVoiceInputConnectionTest(
  options: VoiceInputConnectionTestOptions,
): Promise<VoiceInputConnectionTestResult> {
  const key = options.configurationKey ?? `${options.provider}:${options.providerModel}`;
  if (activeConnectionTest) {
    if (activeConnectionTest.key === key) return activeConnectionTest.promise;
    return Promise.resolve({
      ok: false,
      provider: options.provider,
      providerModel: options.providerModel,
      reason: 'service-error',
    });
  }
  const current = runVoiceInputConnectionTest(options).finally(() => {
    if (activeConnectionTest?.promise === current) activeConnectionTest = null;
  });
  activeConnectionTest = { key, promise: current };
  return current;
}

export function classifyVoiceInputConnectionTestError(
  error: unknown,
): VoiceInputConnectionTestFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    /\b(?:401|403)\b/.test(normalized)
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('authentication failed')
    || normalized.includes('invalid api key')
    || normalized.includes('invalid token')
  ) {
    return 'authentication-failed';
  }
  if (
    normalized.includes('api key is required')
    || normalized.includes('missing api key')
    || normalized.includes('missing credential')
    || normalized.includes('sign-in is required')
    || normalized.includes('login is required')
    || normalized.includes('configure the realtime asr websocket url')
  ) {
    return 'credentials-missing';
  }
  if (
    /\b(?:404|405|501)\b/.test(normalized)
    || normalized.includes('route not found')
    || normalized.includes('unknown route')
    || normalized.includes('unsupported route')
  ) {
    return 'route-unavailable';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'timeout';
  }
  if (
    normalized.includes('econnrefused')
    || normalized.includes('econnreset')
    || normalized.includes('enotfound')
    || normalized.includes('eai_again')
    || normalized.includes('socket hang up')
    || normalized.includes('network')
    || normalized.includes('certificate')
    || normalized.includes('tls')
  ) {
    return 'network';
  }
  return 'service-error';
}

export async function runVoiceInputConnectionTest(
  options: VoiceInputConnectionTestOptions,
): Promise<VoiceInputConnectionTestResult> {
  let provider: AsrProvider | undefined;
  try {
    provider = await options.createProvider();
    await provider.start();
    return {
      ok: true,
      provider: options.provider,
      providerModel: options.providerModel,
    };
  } catch (error) {
    options.onError?.(error);
    return {
      ok: false,
      provider: options.provider,
      providerModel: options.providerModel,
      reason: classifyVoiceInputConnectionTestError(error),
    };
  } finally {
    try {
      await provider?.stop();
    } catch {
      // Connection-test cleanup is best effort; the classified probe result
      // remains more useful than replacing it with a close-time failure.
    }
    try {
      await provider?.dispose?.();
    } catch {
      // Debug recorder finalization must not change the probe result either.
    }
  }
}
