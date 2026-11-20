import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ClientEndpointRegion } from "@cindy/maker-shared/client-endpoints";
import {
  AUTH_REGION,
  getActiveMobileSessionRealm,
  getMobileEndpointForRealm,
} from "@/config/env";
import { getActiveSelfHostedRelay } from "@/device-link/selfHostedRelayRouting";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { resolvePushAppVariant } from "@/notifications/pushRegistrationModel";
import { readIosPushEnvironment } from "@/notifications/nativePushEnvironment";
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import type { AgentActivitySink } from "./agentActivitySync";

export interface ActivityPushRegistration {
  accountScope: string | null;
  enabled: boolean;
  startToken: string | null;
  updateToken: string | null;
  activityId: string | null;
  dismissed: boolean;
  supportsInputPushToken: boolean;
  /** Local observation only; never added to the registration wire payload. */
  isStale?: boolean;
  confirmedAt?: number | null;
  staleAt?: number | null;
}
/** In-memory continuity owned by the bridge, never persisted or sent. */
export interface ActivityRecoveryState {
  identity?: string;
  lastRefreshAt?: number;
  wasStale?: boolean;
  contentKey?: string;
  expiryDeadline?: number;
}
export interface AgentActivityNative extends AgentActivitySink {
  configureAccount?(accountScope: string | null): Promise<void>;
  getPushRegistration?(): Promise<ActivityPushRegistration>;
  addListener?(
    event: "pushRegistrationChanged",
    listener: () => void,
  ): { remove(): void };
}
export const agentActivityNative =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<AgentActivityNative>("CindyAgentActivity")
    : null;
const path = "/api/device-link/live-activity";
// Long enough for a recovery request to come back as an update or an end.
const EXPIRED_GRACE_MS = 20_000;
let generation = 0;
const requests = new Set<Promise<void>>();

// Fixed credentials, no auth callbacks: logout can await in-flight registration
// before DELETE without recursively awaiting its own auth termination.
function sendRegistration(
  baseUrl: string,
  token: string,
  method: "PUT" | "DELETE",
  body?: unknown,
) {
  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(baseUrl + path, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw Object.assign(new Error("activity-registration-failed"), {
          status: response.status,
        });
    } finally {
      clearTimeout(timeout);
    }
  })();
  requests.add(request);
  void request.finally(() => requests.delete(request)).catch(() => {});
  return request;
}

export function activityAccountScope(accountId: string): string {
  return JSON.stringify([
    getActiveSelfHostedRelay()?.baseUrl ??
      getMobileEndpointForRealm(
        getActiveMobileSessionRealm(),
        "deviceLinkApiBaseUrl",
      ),
    accountId,
  ]);
}

/** Dedicated ActivityKit registration; never reads ordinary push permissions/preferences. */
export function startActivityPushSync(options: {
  accountScope: string;
  getAccessToken(): Promise<string | null>;
  labels: Record<
    "attention" | "completed" | "error" | "running" | "stale",
    string
  >;
  urlScheme: string;
  onRegistered(hasActivity: boolean): void;
  /** The service already owns this account's activity (known from an earlier
   * syncer before a reconnect); a failed later attempt must not hand it back. */
  initiallyRegistered?: boolean;
  recovery?: ActivityRecoveryState;
}) {
  const native = agentActivityNative;
  if (!native?.getPushRegistration || getActiveSelfHostedRelay()) {
    options.onRegistered(false);
    return { sync(_refresh = false) {}, dispose() {} };
  }
  const captured = generation;
  const owner = getMobileAuthOwner();
  const realm = getActiveMobileSessionRealm();
  const baseUrl = getMobileEndpointForRealm(realm, "deviceLinkApiBaseUrl");
  const controller = new AbortController();
  let tail = Promise.resolve();
  let last: string | undefined;
  let accepted = options.initiallyRegistered === true;
  let unsupported = false;
  let expiry: { activityId: string | null; timer: ReturnType<typeof setTimeout> } | undefined;
  const recovery = options.recovery ?? {};
  // An expired activity gets one chance to recover (the service answers a
  // recovery request with fresh content or by ending it). If it is still expired
  // after that, remove it here: offline, or with a service that cannot confirm,
  // nothing else would, and outdated content must not stay on the Lock Screen.
  const watchExpiry = (activityId: string | null, expired: boolean) => {
    if (expiry && (!expired || expiry.activityId !== activityId)) {
      clearTimeout(expiry.timer);
      expiry = undefined;
    }
    if (!expired) recovery.expiryDeadline = undefined;
    if (!expired || expiry) return;
    // Disposing a syncer cancels its timer, not this activity's recovery window.
    const deadline = recovery.expiryDeadline ??= Date.now() + EXPIRED_GRACE_MS;
    const timer = setTimeout(() => {
      expiry = undefined;
      void (async () => {
        try {
          assertCurrent();
          const latest = await native.getPushRegistration!();
          assertCurrent();
          if (latest.accountScope !== options.accountScope ||
              latest.activityId !== activityId) return;
          if (latest.isStale !== true) {
            recovery.expiryDeadline = undefined;
            return;
          }
          native.setState(null);
          mobileDebugLog("info", "lifecycle", "activity-expired");
        } catch {
          /* disposed, previous account or native module unavailable */
        }
      })();
    }, Math.max(0, deadline - Date.now()));
    expiry = { activityId, timer };
  };
  const assertCurrent = () => {
    if (
      controller.signal.aborted ||
      captured !== generation ||
      !isMobileAuthOwnerCurrent(owner) ||
      getActiveSelfHostedRelay()
    )
      throw new Error("stale-activity-owner");
  };
  const sync = (refresh = false) => {
    tail = tail
      .then(async () => {
        assertCurrent();
        if (unsupported) return;
        const registration = await native.getPushRegistration!();
        assertCurrent();
        if (registration.accountScope !== options.accountScope) return;
        // Release builds can carry development provisioning. Read the signed
        // native environment, as ordinary APNs registration already does.
        const environment = registration.enabled
          ? await readIosPushEnvironment()
          : null;
        assertCurrent();
        if (registration.enabled &&
            environment !== "development" && environment !== "production") {
          throw new Error("Unknown ActivityKit APNs signing environment");
        }
        // A native token is not evidence that the service received it. The
        // bridge keeps its initial discovery pending until this attempt settles.
        const { isStale, confirmedAt, staleAt, ...wireRegistration } = registration;
        const identity = JSON.stringify([captured, owner.generation, options.accountScope,
          registration.activityId, registration.updateToken]);
        if (recovery.identity !== identity) {
          watchExpiry(registration.activityId, false);
          recovery.identity = identity;
          recovery.lastRefreshAt = -Infinity;
          recovery.wasStale = false;
          recovery.contentKey = undefined;
        }
        const becameStale = isStale === true && !recovery.wasStale;
        if (becameStale) mobileDebugLog("info", "lifecycle", "activity-stale");
        if (isStale === false && recovery.wasStale)
          mobileDebugLog("info", "lifecycle", "activity-recovered");
        recovery.wasStale = isStale === true;
        watchExpiry(registration.activityId, isStale === true && !!registration.updateToken);
        const times = {
          confirmedAt: typeof confirmedAt === "number" && Number.isFinite(confirmedAt) ? confirmedAt : null,
          staleAt: typeof staleAt === "number" && Number.isFinite(staleAt) ? staleAt : null,
        };
        const contentKey = JSON.stringify([isStale, times]);
        if (contentKey !== recovery.contentKey) {
          recovery.contentKey = contentKey;
          mobileDebugLog("debug", "lifecycle", "activity-content", { ...times, stale: isStale === true });
        }
        const shouldRefresh = (refresh || becameStale) && isStale !== false &&
          registration.enabled && !registration.dismissed && !!registration.updateToken &&
          AppState.currentState === "active" && Date.now() - (recovery.lastRefreshAt ?? -Infinity) >= 30_000;
        const body = {
          ...wireRegistration,
          schemaVersion: 1,
          labels: options.labels,
          urlScheme: options.urlScheme,
          appVariant: resolvePushAppVariant(AUTH_REGION),
          apnsEnv: environment === "development" ? "sandbox" : "prod",
        };
        const key = JSON.stringify(body);
        if (key === last && !shouldRefresh) return;
        if (
          registration.enabled &&
          !registration.startToken &&
          !registration.updateToken
        ) {
          options.onRegistered(false);
          return;
        }
        const token = await options.getAccessToken();
        assertCurrent();
        if (!token) {
          if (!accepted) options.onRegistered(false);
          return;
        }
        // Auth acquisition may span backgrounding; don't send a recovery that
        // was only eligible while foreground. Token changes still register normally.
        const refreshStale = shouldRefresh && AppState.currentState === "active";
        if (key === last && !refreshStale) return;
        if (refreshStale) recovery.lastRefreshAt = Date.now();
        await sendRegistration(
          baseUrl,
          token,
          registration.enabled ? "PUT" : "DELETE",
          // staleAt tells the service when this content lapses. It changes with
          // every update, so it stays out of the deduplication key above.
          registration.enabled ? {
            ...body,
            ...(registration.updateToken && times.staleAt !== null ? { staleAt: times.staleAt } : {}),
            ...(refreshStale ? { refreshStale: true } : {}),
          } : undefined,
        );
        assertCurrent();
        last = key;
        accepted = true;
        mobileDebugLog("info", "lifecycle", "activity-registration", {
          outcome: "accepted", refresh: refreshStale, hasActivity: !!registration.updateToken,
        });
        // A start token is permission to try, not proof that APNs created an
        // activity. Keep foreground creation until an actual update token exists.
        options.onRegistered(
          registration.enabled && !!registration.updateToken,
        );
      })
      .catch((error: unknown) => {
        // Old official services have no endpoint; self-hosted relays are skipped
        // above. A new login/reconnect creates a fresh capability attempt.
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          [404, 405].includes(Number(error.status))
        )
          unsupported = true;
        try {
          assertCurrent();
          mobileDebugLog("warn", "lifecycle", "activity-registration", {
            outcome: "failed",
            category: error instanceof TypeError ? "network" : error instanceof Error && error.name === "AbortError" ? "timeout" : "request",
            status: error && typeof error === "object" && "status" in error && typeof error.status === "number"
              ? error.status : undefined,
          });
          // A failed refresh of an already registered activity must not transfer
          // ownership to the partial Home projection. Initial discovery still falls back.
          if (!accepted) options.onRegistered(false);
        } catch {
          /* disposed or previous account */
        }
      });
    return tail;
  };
  const listener = native.addListener?.("pushRegistrationChanged", () => { void sync(); });
  sync(true);
  return {
    sync,
    dispose() {
      controller.abort();
      listener?.remove();
      if (expiry) clearTimeout(expiry.timer);
      expiry = undefined;
    },
  };
}

/** Called before credentials are cleared on both account switch and logout.
 * Raw fixed-identity transport avoids recursive auth termination/refresh. */
export async function unregisterActivityPush(
  accessToken: string | null,
  realm: ClientEndpointRegion,
): Promise<void> {
  generation += 1;
  try {
    await agentActivityNative?.configureAccount?.(null);
  } catch {
    /* auth cleanup must continue */
  }
  try {
    agentActivityNative?.setState(null);
  } catch {
    /* unavailable native module */
  }
  await Promise.allSettled([...requests]);
  if (!accessToken || Platform.OS !== "ios" || getActiveSelfHostedRelay())
    return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const baseUrl = getMobileEndpointForRealm(realm, "deviceLinkApiBaseUrl");
    await fetch(baseUrl + path, {
      method: "DELETE",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* offline logout still clears local activities; the next registration moves token ownership */
  } finally {
    clearTimeout(timeout);
  }
}
