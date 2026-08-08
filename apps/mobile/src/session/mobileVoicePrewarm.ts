import type { AsrProvider } from '@cindy/voice-input-core';
import type { ApiFetchOptions } from '@/api/client';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { createMobileAsrProvider } from '@/session/mobileRealtimeAsrProvider';
import { prewarmMobileRealtimeAudio } from '@/session/mobileRealtimeAudio';
import {
  CINDY_MANAGED_REFINER_PROVIDER,
  createMobileCindyVoiceCredential,
  MobileCindyVoiceRunContext,
} from '@/session/mobileCindyVoiceSession';

export type PrewarmedMobileVoiceAsr = {
  credential: StoredMobileVoiceCredential;
  asr: AsrProvider;
  voiceContext: MobileCindyVoiceRunContext;
};

type PendingPrewarm = {
  deviceId: string;
  createdAt: number;
  value: PrewarmedMobileVoiceAsr | null;
  expireTimer: ReturnType<typeof setTimeout>;
};

// How long a prewarmed ASR connection stays claimable. Press-down to press-up is
// normally ~100ms; anything much older means the tap never completed (drag-out,
// permission dialog, navigation), and a stale socket must be closed rather than
// handed to a later run — the ASR server kills idle sessions itself, so holding
// one longer buys nothing.
const PREWARM_MAX_AGE_MS = 15_000;

let pendingPrewarm: PendingPrewarm | null = null;

/**
 * Speculative voice-input warm-up, called on touch-down (pressIn) of the mic
 * button. Two independent warm-ups run so both cold-start costs overlap the
 * press gesture instead of following it:
 *
 * - Native: activate the iOS audio session (~100-150ms) so capture is live
 *   almost immediately when recording starts — see prewarmMobileRealtimeAudio.
 * - ASR: resolve the voice credential and open the ASR WebSocket now, so the
 *   ~seconds-long connect handshake starts before the finger even lifts. The
 *   recording that follows claims this connection via
 *   takePrewarmedMobileVoiceAsr instead of connecting from scratch.
 *
 * Fire-and-forget and never throws: a failed prewarm just means the recording
 * falls back to the regular startup path and surfaces errors there.
 */
export function prewarmMobileVoiceStart(
  deviceId: string,
  options?: {
    getAccessToken: () => Promise<string | null>;
    refreshAccessToken: () => Promise<string | null>;
    apiFetch: <T>(path: string, options: Omit<ApiFetchOptions, 'token'>) => Promise<T>;
  },
): void {
  prewarmMobileRealtimeAudio();
  if (
    pendingPrewarm
    && pendingPrewarm.deviceId === deviceId
    && Date.now() - pendingPrewarm.createdAt < PREWARM_MAX_AGE_MS
  ) {
    return;
  }
  discardPendingPrewarm();
  const value = buildPrewarm(deviceId, options);
  const entry: PendingPrewarm = {
    deviceId,
    createdAt: Date.now(),
    value,
    expireTimer: setTimeout(() => {
      if (pendingPrewarm === entry) discardPendingPrewarm();
    }, PREWARM_MAX_AGE_MS),
  };
  pendingPrewarm = entry;
}

/**
 * Claims the pending prewarmed ASR connection for an actual recording. Returns
 * null when there is nothing fresh for this device — the caller then resolves
 * the credential and connects as usual. The returned provider's first start()
 * joins the already in-flight connect instead of reconnecting.
 */
export function takePrewarmedMobileVoiceAsr(
  deviceId: string,
): PrewarmedMobileVoiceAsr | null {
  const entry = pendingPrewarm;
  if (!entry || entry.deviceId !== deviceId || Date.now() - entry.createdAt >= PREWARM_MAX_AGE_MS) {
    return null;
  }
  pendingPrewarm = null;
  clearTimeout(entry.expireTimer);
  return entry.value;
}

/** Discards (and closes) any unclaimed prewarmed connection, e.g. on unmount. */
export function discardPendingPrewarm(): void {
  const entry = pendingPrewarm;
  if (!entry) return;
  pendingPrewarm = null;
  clearTimeout(entry.expireTimer);
  void entry.value?.asr.stop().catch(() => undefined);
}

function buildPrewarm(
  deviceId: string,
  auth?: {
    getAccessToken: () => Promise<string | null>;
    refreshAccessToken: () => Promise<string | null>;
    apiFetch: <T>(path: string, options: Omit<ApiFetchOptions, 'token'>) => Promise<T>;
  },
): PrewarmedMobileVoiceAsr | null {
  // 手机语音只保留 Cindy 官方托管路径:没有登录态(auth)就没有可预热的连接。
  if (!auth) return null;
  try {
    const credential = createMobileCindyVoiceCredential(deviceId);
    const voiceContext = new MobileCindyVoiceRunContext(
      auth.getAccessToken,
      auth.refreshAccessToken,
      auth.apiFetch,
      credential.settings?.language,
      CINDY_MANAGED_REFINER_PROVIDER,
    );
    const provider = createMobileAsrProvider(credential, {
      connectionProvider: (providerId) => voiceContext.createAsrConnection(providerId),
    });
    const startPromise = provider.start();
    // Parked until claimed: don't let a failed speculative connect become an
    // unhandled rejection. The claiming run re-observes the outcome via start().
    startPromise.catch(() => undefined);
    return { credential, voiceContext, asr: withPrewarmedStart(provider, startPromise) };
  } catch {
    return null;
  }
}

/**
 * Makes the speculative start() call transparent to the eventual consumer:
 * the first start() joins the already in-flight connect (and reports its
 * outcome) instead of restarting the provider; later start() calls — a new run
 * reusing the same session — behave normally. stop() is passed to the inner
 * provider immediately, including while a managed provider is still waiting
 * for its ticket, so a discarded prewarm cannot open a socket or continue to
 * the next fallback candidate after it has been cancelled.
 */
function withPrewarmedStart(provider: AsrProvider, startPromise: Promise<void>): AsrProvider {
  let firstStartConsumed = false;
  // Sentinel listener for the parked window (pressIn → claim): providers
  // replace their event callback on onEvent and do not buffer past events, so
  // a transport death AFTER the speculative connect succeeded would otherwise
  // vanish into the default no-op callback. The claiming run would then treat
  // the ASR as healthy while every appendAudio no-ops — a silent dead mic that
  // submits empty text. Record the drop here so the first start() reconnects.
  // The consumer's own onEvent replaces this listener when the run attaches.
  let transportDroppedWhileParked = false;
  provider.onEvent((event) => {
    if (event.type === 'disconnected' || event.type === 'error') {
      transportDroppedWhileParked = true;
    }
  });
  return {
    start(): Promise<void> {
      if (!firstStartConsumed) {
        firstStartConsumed = true;
        // The speculative connect can fail for transient reasons (the press
        // happened during a network blip). Falling back to one fresh connect
        // keeps a failed prewarm from blocking the recording it was supposed
        // to speed up; if the retry fails too, that error surfaces normally.
        // The same applies to a POST-ready drop recorded by the parked
        // sentinel above: the connect promise resolved, but the socket died
        // before the run attached — reconnect instead of handing over a dead
        // transport.
        return startPromise.then(
          () => {
            if (transportDroppedWhileParked) return provider.start();
            return undefined;
          },
          () => provider.start(),
        );
      }
      return provider.start();
    },
    async stop(): Promise<void> {
      await provider.stop();
    },
    appendAudio(chunk, trace): void {
      provider.appendAudio(chunk, trace);
    },
    flushAudio(): Promise<void> {
      return provider.flushAudio();
    },
    onEvent(callback): void {
      provider.onEvent(callback);
    },
    dispose(): Promise<void> {
      return provider.dispose?.() ?? Promise.resolve();
    },
    // Only expose recover while the inner provider does (it is assigned
    // dynamically by the fallback chain); consumers feature-detect it.
    get recover(): (() => Promise<void>) | undefined {
      const innerRecover = provider.recover;
      if (typeof innerRecover !== 'function') return undefined;
      return () => innerRecover.call(provider);
    },
  };
}

export const __testing = {
  reset(): void {
    discardPendingPrewarm();
  },
  hasPending(): boolean {
    return pendingPrewarm !== null;
  },
  withPrewarmedStart,
};
