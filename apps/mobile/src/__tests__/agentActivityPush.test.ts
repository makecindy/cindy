/** Unit: production token sync, distinct from bridge/store tests. Covers native
 * token rotation, system disable, region/account fences and old-service fallback;
 * ordinary notification permissions are deliberately absent from this transport. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  realm: "global",
  appState: { currentState: "active" },
  relay: null as { baseUrl: string } | null,
  application: {
    getPushNotificationServiceEnvironmentAsync: vi.fn(),
    getApplicationReleaseTypeAsync: vi.fn(),
  },
  native: {
    getPushRegistration: vi.fn(),
    configureAccount: vi.fn(async () => {}),
    setState: vi.fn(),
    markStale: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: fixture.appState }));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => name === "ExpoApplication" ? fixture.application : fixture.native,
}));
vi.mock("@/config/env", () => ({
  AUTH_REGION: "global",
  getActiveMobileSessionRealm: () => fixture.realm,
  getMobileEndpointForRealm: (realm: string) => `https://${realm}.example.test`,
}));
vi.mock("@/device-link/selfHostedRelayRouting", () => ({
  getActiveSelfHostedRelay: () => fixture.relay,
}));
import {
  activityAccountScope,
  startActivityPushSync,
  unregisterActivityPush,
} from "@/widgets/agentActivityPush";
import { setMobileAuthOwner } from "@/auth/authOwnerGeneration";

const registration = () => ({
  accountScope: activityAccountScope("a"),
  enabled: true,
  startToken: "start",
  updateToken: null,
  activityId: null,
  dismissed: false,
  supportsInputPushToken: true,
});
const options = () => ({
  accountScope: activityAccountScope("a"),
  getAccessToken: vi.fn(async (): Promise<string | null> => "test-credential"),
  onRegistered: vi.fn(),
  urlScheme: "cindy",
  labels: {
    attention: "Waiting",
    completed: "Done",
    error: "Error",
    running: "Running",
    stale: "Offline",
  },
});
const fetchMock = vi.fn<typeof fetch>();
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__DEV__", true);
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal("fetch", fetchMock);
  fixture.realm = "global";
  fixture.appState.currentState = "active";
  fixture.relay = null;
  fixture.application.getPushNotificationServiceEnvironmentAsync.mockResolvedValue("development");
  fixture.application.getApplicationReleaseTypeAsync.mockResolvedValue(0);
  setMobileAuthOwner("a", "global");
  fixture.native.getPushRegistration.mockResolvedValue(registration());
});
it("registers independently, deduplicates and uploads rotated ActivityKit tokens", async () => {
  const opts = options(),
    sync = startActivityPushSync(opts);
  await sync.sync();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "https://global.example.test/api/device-link/live-activity",
    expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({
        Authorization: "Bearer test-credential",
      }),
    }),
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
    startToken: "start",
    appVariant: "global",
  });
  expect(opts.onRegistered).toHaveBeenLastCalledWith(false);
  fixture.native.getPushRegistration.mockResolvedValue({
    ...registration(),
    updateToken: "rotated",
    activityId: "live",
  });
  await sync.sync();
  expect(
    JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string).updateToken,
  ).toBe("rotated");
  expect(opts.onRegistered).toHaveBeenLastCalledWith(true);
  sync.dispose();
});
it("unregisters on system disable without ending auth or enabling ordinary notifications", async () => {
  const opts = options(),
    sync = startActivityPushSync(opts);
  await sync.sync();
  fixture.native.getPushRegistration.mockResolvedValue({
    ...registration(),
    enabled: false,
  });
  await sync.sync();
  expect(fetchMock.mock.calls.at(-1)![1]).toMatchObject({ method: "DELETE" });
  expect(fetchMock.mock.calls.at(-1)![1]!.body).toBeUndefined();
  sync.dispose();
});
// Unit, discussion_r4515865303: Release does not imply production signing.
// Exercise the real native environment reader through the activity transport.
it.each([
  [false, "development", 0, "sandbox"],
  [true, "production", 0, "prod"],
  [false, null, 5, "prod"],
] as const)("uses signed APNs environment (JS dev=%s, profile=%s, release=%s)", async (dev, environment, release, expected) => {
  vi.stubGlobal("__DEV__", dev);
  fixture.application.getPushNotificationServiceEnvironmentAsync.mockResolvedValue(environment);
  fixture.application.getApplicationReleaseTypeAsync.mockResolvedValue(release);
  const sync = startActivityPushSync(options());
  await sync.sync();
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).apnsEnv).toBe(expected);
  sync.dispose();
});
it("keeps local sync for an unknown signing environment but still permits unregister", async () => {
  fixture.application.getPushNotificationServiceEnvironmentAsync.mockResolvedValue(null);
  const opts = options(), sync = startActivityPushSync(opts);
  await sync.sync();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(opts.onRegistered).toHaveBeenLastCalledWith(false);
  fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), enabled: false });
  await sync.sync();
  expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe("DELETE");
  sync.dispose();
});
// Unit, discussion_r4514700790: merely obtaining an update token previously
// disabled local sync even when upload failed. Existing cases only covered 2xx.
it.each(["server", "network", "no-auth"])("keeps local ownership after %s registration failure and hands over after success", async (failure) => {
  fixture.native.getPushRegistration.mockResolvedValue({
    ...registration(), updateToken: "local-update", activityId: "local",
  });
  const opts = options();
  if (failure === "server") fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
  if (failure === "network") fetchMock.mockRejectedValue(new TypeError("network unavailable"));
  const sync = startActivityPushSync({ ...opts,
    getAccessToken: async () => failure === "no-auth" ? null : opts.getAccessToken(),
  });
  await sync.sync();
  expect(opts.onRegistered).toHaveBeenLastCalledWith(false);
  expect(opts.onRegistered).not.toHaveBeenCalledWith(true);
  sync.dispose();

  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  const recovered = startActivityPushSync(opts);
  await recovered.sync();
  expect(opts.onRegistered).toHaveBeenLastCalledWith(true);
  recovered.dispose();
});
it("rejects a delayed token read after switching owner and scopes logout to the old realm", async () => {
  let resolve!: (value: unknown) => void;
  fixture.native.getPushRegistration.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const opts = options(),
    sync = startActivityPushSync(opts);
  await Promise.resolve();
  setMobileAuthOwner("b", "cn");
  fixture.realm = "cn";
  resolve(registration());
  await sync.sync();
  expect(fetchMock).not.toHaveBeenCalled();
  const fetch = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await unregisterActivityPush("test-credential", "global");
  expect(fetch).toHaveBeenCalledWith(
    "https://global.example.test/api/device-link/live-activity",
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(fixture.native.configureAccount).toHaveBeenLastCalledWith(null);
  sync.dispose();
});
it("does not send official registration on a self-hosted relay and stops at an old-server 404", async () => {
  fixture.relay = { baseUrl: "https://relay.example.test" };
  await startActivityPushSync(options()).sync();
  expect(fetchMock).not.toHaveBeenCalled();
  fixture.relay = null;
  fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
  const opts = options();
  const sync = startActivityPushSync(opts);
  await sync.sync();
  await sync.sync();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  sync.dispose();
});
it("waits for a sent registration before logout DELETE and rejects its late success", async () => {
  let finish!: (response: Response) => void;
  let sent!: () => void;
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  fetchMock.mockImplementationOnce(() => {
    sent();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const opts = options(),
    sync = startActivityPushSync(opts);
  await started;
  const logout = unregisterActivityPush("test-credential", "global");
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  finish({ ok: true, status: 200 } as Response);
  await logout;
  await sync.sync();
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
    "PUT",
    "DELETE",
  ]);
  expect(opts.onRegistered).not.toHaveBeenCalled();
  sync.dispose();
});

// Unit: an unchanged update token used to suppress foreground recovery forever.
// Exercise the transport, including the no-extra-request and ownership boundaries.
it("refreshes a stale registered activity on resume without publishing local diagnostics", async () => {
  vi.useFakeTimers();
  const opts = options();
  fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), updateToken: "update", isStale: false });
  const sync = startActivityPushSync(opts);
  try {
    await sync.sync();
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), updateToken: "update", isStale: true });
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).not.toHaveProperty("isStale");
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    opts.onRegistered.mockClear();
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(opts.onRegistered).not.toHaveBeenCalledWith(false);
  } finally { sync.dispose(); vi.useRealTimers(); }
});

// Unit: a stale ActivityKit event while suspended must not add background network work.
it("defers background stale recovery until foreground and preserves ownership without auth", async () => {
  const opts = options();
  fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), updateToken: "update", isStale: false });
  const sync = startActivityPushSync(opts);
  try {
    await sync.sync();
    fixture.appState.currentState = "background";
    fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), updateToken: "update", isStale: true });
    await sync.sync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fixture.appState.currentState = "active";
    opts.getAccessToken.mockResolvedValueOnce(null);
    opts.onRegistered.mockClear();
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(opts.onRegistered).not.toHaveBeenCalledWith(false);
    await sync.sync(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { sync.dispose(); }
});

// Unit: a reconnect rebuilds the syncer; a failed first attempt must not undo an
// already confirmed server takeover (it would re-enable the partial local mirror).
it("keeps a confirmed server takeover when a rebuilt syncer fails to register", async () => {
  const opts = { ...options(), initiallyRegistered: true };
  fixture.native.getPushRegistration.mockResolvedValue({ ...registration(), updateToken: "update" });
  fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
  const sync = startActivityPushSync(opts);
  try {
    await sync.sync();
    expect(fetchMock).toHaveBeenCalled();
    expect(opts.onRegistered).not.toHaveBeenCalledWith(false);
  } finally { sync.dispose(); }
});
