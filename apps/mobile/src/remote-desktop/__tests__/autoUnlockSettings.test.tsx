// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoUnlockSettings } from "../useAutoUnlockSettings";

const fixture = vi.hoisted(() => ({
  hostPlatform: "darwin" as string | undefined,
  platform: "ios",
  owner: {
    accountId: "test-account",
    accountKey: "test-account",
    generation: 1,
  },
  settings: { autoUnlock: false, biometricVerification: false },
  read: vi.fn(),
  forget: vi.fn(),
  biometric: vi.fn(),
  configure: vi.fn(),
  invoke: vi.fn(),
  openLink: vi.fn(),
  ensure: vi.fn(),
  close: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: fixture.alert },
  Platform: {
    get OS() {
      return fixture.platform;
    },
  },
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ getAccessToken: async () => "test-token" }),
}));
vi.mock("@/auth/deviceId", () => ({
  ensureDeviceId: async () => "test-phone",
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => fixture.owner,
  isMobileAuthOwnerCurrent: (owner: unknown) => owner === fixture.owner,
}));
vi.mock("@/config/env", () => ({
  getActiveMobileSessionRealm: () => "global",
}));
vi.mock("@/theme", () => ({ useTheme: () => ({ mode: "light" }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: fixture.invoke, openLink: fixture.openLink }),
}));
vi.mock("../credentialIdentity", () => ({
  configureCredentialIdentity: fixture.configure,
}));
vi.mock("../../../modules/cindy-remote-credentials/src", () => ({
  remoteCredentials: {
    savedUnlockSettings: fixture.read,
    forgetSavedUnlock: fixture.forget,
    setSavedUnlockBiometric: fixture.biometric,
    beginUnlock: vi.fn(),
  },
}));
vi.mock("../credentialSession", async (original) => ({
  ...(await original<typeof import("../credentialSession")>()),
  RemoteDesktopCredentialSession: class {
    ensure = fixture.ensure;
    close = fixture.close;
  },
}));
let root: Root,
  host: HTMLDivElement,
  value: ReturnType<typeof useAutoUnlockSettings>;
function Probe({ active = true }: { active?: boolean }) {
  value = useAutoUnlockSettings("test-mac", active, () => fixture.hostPlatform);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  fixture.hostPlatform = "darwin";
  fixture.platform = "ios";
  fixture.settings = { autoUnlock: false, biometricVerification: false };
  fixture.read.mockImplementation(async () => ({ ...fixture.settings }));
  fixture.invoke.mockResolvedValue({
    version: 1,
    state: "unlocked",
    ready: true,
    descriptor: "test-descriptor",
  });
  fixture.ensure.mockResolvedValue(undefined);
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("does not perform any network or password operation when automatic unlock is off", async () => {
  await act(async () => value.maybeUnlock());
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.ensure).not.toHaveBeenCalled();
});
it("shows an actionable signing error immediately when enabling automatic unlock fails", async () => {
  fixture.invoke.mockRejectedValueOnce(
    new Error("CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED private-test-detail"),
  );
  await act(async () => value.onAutoUnlock(true));
  expect(fixture.alert).toHaveBeenCalledWith(
    "remoteDesktop.autoUnlock",
    "remoteDesktop.credentialSigningRequired",
  );
  expect(value.notice).toBe("remoteDesktop.credentialSigningRequired");
  expect(value.autoUnlock).toBe(false);
  expect(JSON.stringify(fixture.alert.mock.calls)).not.toContain(
    "private-test-detail",
  );
});
it("does not turn automatic retries into modal alerts", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke
    .mockResolvedValueOnce({ version: 1, state: "locked" })
    .mockRejectedValueOnce(
      new Error("CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED"),
    );
  await act(async () => value.maybeUnlock());
  expect(value.notice).toBe("remoteDesktop.credentialSigningRequired");
  expect(fixture.alert).not.toHaveBeenCalled();
});
it("shows Face ID setting failures without exposing native error details", async () => {
  fixture.biometric.mockRejectedValueOnce(
    new Error("native private-test-detail"),
  );
  await act(async () => value.onBiometricVerification(true));
  expect(fixture.alert).toHaveBeenCalledWith(
    "remoteDesktop.faceIdVerification",
    "remoteDesktop.autoUnlockUnavailable",
  );
});
it.each(["win32", "linux", undefined])(
  "does not access credentials for unsupported host %s",
  async (platform) => {
    fixture.hostPlatform = platform;
    fixture.settings.autoUnlock = true;
    vi.clearAllMocks();
    await act(async () => {
      await value.maybeUnlock();
      value.onAutoUnlock(true);
      value.onBiometricVerification(true);
    });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.biometric).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  },
);
it("uses the just-discovered Mac platform before a React render", async () => {
  fixture.hostPlatform = undefined;
  await act(async () => value.maybeUnlock());
  fixture.hostPlatform = "darwin";
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValue({
    version: 1,
    state: "locked",
    ready: true,
    descriptor: "test-descriptor",
  });
  await act(async () => value.maybeUnlock());
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
});
it("does not use a saved password or Face ID when the Mac is already unlocked", async () => {
  fixture.settings.autoUnlock = true;
  await act(async () => value.maybeUnlock());
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  expect(fixture.configure).not.toHaveBeenCalled();
  expect(fixture.ensure).not.toHaveBeenCalled();
});
it("cancels automatic unlock without breaking desktop startup or repeating it on media retries", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValue({
    version: 1,
    state: "locked",
    ready: true,
    descriptor: "test-descriptor",
  });
  fixture.ensure.mockRejectedValue(new Error("CREDENTIAL_CANCELLED"));
  await act(async () => value.maybeUnlock());
  await act(async () => value.maybeUnlock());
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
  expect(fixture.close).toHaveBeenCalled();
  expect(value.notice).toBe("remoteDesktop.credentialCancelled");
  value.resetConnectionAttempt();
  await act(async () => value.maybeUnlock());
  await act(async () => value.maybeUnlock());
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
});
it("forgets the saved password locally without an online host", async () => {
  fixture.forget.mockImplementation(async () => {
    fixture.settings.autoUnlock = false;
  });
  await act(async () => {
    value.onAutoUnlock(false);
  });
  expect(fixture.forget).toHaveBeenCalledWith(
    "global",
    "test-account",
    "test-phone",
    "test-mac",
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
});

it("does not start authentication when the screen loses focus during host preparation", async () => {
  fixture.settings.autoUnlock = true;
  let finish!: (value: unknown) => void;
  fixture.invoke
    .mockResolvedValueOnce({ version: 1, state: "locked" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  let pending!: Promise<void>;
  await act(async () => {
    pending = value.maybeUnlock();
  });
  expect(finish).toBeTypeOf("function");
  await act(async () => root.render(createElement(Probe, { active: false })));
  await act(async () => {
    finish({ version: 1, ready: true, descriptor: "test-descriptor" });
    await pending;
  });
  // Identity preparation started in parallel, but cancellation still prevents the prompt.
  expect(fixture.configure).toHaveBeenCalledOnce();
  expect(fixture.ensure).not.toHaveBeenCalled();
});
it("uses the native password-only default when biometrics are unavailable", async () => {
  fixture.read.mockResolvedValue({
    autoUnlock: false,
    biometricVerification: false,
    biometricAvailable: false,
  });
  await act(async () => value.maybeUnlock());
  await act(async () => value.onAutoUnlock(true));
  expect(fixture.ensure).toHaveBeenCalledWith(
    "test-mac",
    expect.any(Function),
    "en",
    "light",
    { setup: true, biometric: false, descriptor: "test-descriptor" },
  );
});

it("starts password validation without requesting Face ID early", async () => {
  expect(value.biometricVerification).toBe(false);
  await act(async () => value.onAutoUnlock(true));
  expect(fixture.ensure).toHaveBeenCalledWith(
    "test-mac",
    expect.any(Function),
    "en",
    "light",
    { setup: true, biometric: false, descriptor: "test-descriptor" },
  );
  expect(fixture.biometric).not.toHaveBeenCalled();
});
it("enables Face ID only after the explicit native opt-in succeeds", async () => {
  fixture.settings.autoUnlock = true;
  let finish!: () => void;
  fixture.biometric.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          fixture.settings.biometricVerification = true;
          resolve();
        };
      }),
  );
  await act(async () => value.onBiometricVerification(true));
  expect(value.biometricVerification).toBe(false);
  expect(value.busy).toBe(true);
  expect(fixture.biometric).toHaveBeenCalledWith(
    "global",
    "test-account",
    "test-phone",
    "test-mac",
    true,
    "en",
  );
  await act(async () => finish());
  expect(value.biometricVerification).toBe(true);
});
it("keeps Face ID off and preserves the saved password when opt-in is cancelled", async () => {
  fixture.settings.autoUnlock = true;
  await act(async () => value.maybeUnlock());
  fixture.biometric.mockRejectedValueOnce(new Error("CREDENTIAL_CANCELLED"));
  await act(async () => value.onBiometricVerification(true));
  expect(value.biometricVerification).toBe(false);
  expect(value.autoUnlock).toBe(true);
  expect(fixture.forget).not.toHaveBeenCalled();
});

it("retains Face ID protection already stored for the target", async () => {
  fixture.settings = { autoUnlock: true, biometricVerification: true };
  await act(async () => value.maybeUnlock());
  expect(value.biometricVerification).toBe(true);
  expect(fixture.biometric).not.toHaveBeenCalled();
});

it("requests Face ID by default only after the password is verified and saved", async () => {
  let verified!: () => void;
  fixture.ensure.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        verified = () => {
          fixture.settings.autoUnlock = true;
          resolve();
        };
      }),
  );
  fixture.biometric.mockImplementation(async () => {
    fixture.settings.biometricVerification = true;
  });
  await act(async () => value.onAutoUnlock(true));
  expect(fixture.biometric).not.toHaveBeenCalled();
  expect(value.autoUnlock).toBe(false);
  await act(async () => verified());
  expect(fixture.biometric).toHaveBeenCalledWith(
    "global",
    "test-account",
    "test-phone",
    "test-mac",
    true,
    "en",
  );
  expect(value.autoUnlock).toBe(true);
  expect(value.biometricVerification).toBe(true);
});
it("retains automatic unlock when the subsequent Face ID request is cancelled", async () => {
  fixture.ensure.mockImplementation(async () => {
    fixture.settings.autoUnlock = true;
  });
  fixture.biometric.mockRejectedValueOnce(new Error("CREDENTIAL_CANCELLED"));
  await act(async () => value.onAutoUnlock(true));
  expect(value.autoUnlock).toBe(true);
  expect(value.biometricVerification).toBe(false);
  expect(fixture.forget).not.toHaveBeenCalled();
});
it("never requests Face ID after password verification fails", async () => {
  fixture.ensure.mockRejectedValueOnce(
    new Error("CREDENTIAL_PASSWORD_REJECTED"),
  );
  await act(async () => value.onAutoUnlock(true));
  expect(fixture.biometric).not.toHaveBeenCalled();
  expect(value.autoUnlock).toBe(false);
});
it("preserves an explicit Face ID off choice when automatic unlock is enabled again", async () => {
  fixture.read.mockImplementation(async () => ({
    ...fixture.settings,
    biometricPreferred: false,
  }));
  fixture.ensure.mockImplementation(async () => {
    fixture.settings.autoUnlock = true;
  });
  await act(async () => value.onAutoUnlock(true));
  expect(value.autoUnlock).toBe(true);
  expect(value.biometricVerification).toBe(false);
  expect(fixture.biometric).not.toHaveBeenCalled();
});

it("lets a reconnect prepare after a cancelled pre-frame attempt without repeating a shown prompt", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValue({
    version: 1,
    state: "locked",
    ready: true,
    descriptor: "test-descriptor",
  });
  const prompt = vi.fn();
  fixture.ensure.mockImplementation(async (...args: any[]) => {
    await args[4].beforeAuthentication();
    prompt();
  });
  let cancel!: (error: Error) => void;
  const frame = new Promise<void>((_resolve, reject) => {
    cancel = reject;
  });
  let first!: Promise<void>, retry!: Promise<void>;
  await act(async () => {
    first = value.maybeUnlock(() => frame);
  });
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
  expect(prompt).not.toHaveBeenCalled();
  await act(async () => {
    retry = value.maybeUnlock(async () => {});
  });
  expect(fixture.ensure).toHaveBeenCalledTimes(1);
  await act(async () => {
    cancel(new Error("CREDENTIAL_CANCELLED"));
    await Promise.all([first, retry]);
  });
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(fixture.close).toHaveBeenCalledTimes(2);
  await act(async () => value.maybeUnlock(async () => {}));
  expect(fixture.ensure).toHaveBeenCalledTimes(2);
});

it("cancels a prepared prompt if the page loses focus before the first frame", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValue({
    version: 1,
    state: "locked",
    ready: true,
    descriptor: "test-descriptor",
  });
  const prompt = vi.fn();
  fixture.ensure.mockImplementation(async (...args: any[]) => {
    await args[4].beforeAuthentication();
    prompt();
  });
  let showFrame!: () => void;
  const frame = new Promise<void>((resolve) => {
    showFrame = resolve;
  });
  let pending!: Promise<void>;
  await act(async () => {
    pending = value.maybeUnlock(() => frame);
  });
  await act(async () => root.render(createElement(Probe, { active: false })));
  await act(async () => {
    showFrame();
    await pending;
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(fixture.close).toHaveBeenCalled();
});

it("prepares phone identity while the host is still preparing", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValueOnce({ version: 1, state: "locked" });
  let finish!: (value: unknown) => void;
  fixture.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let operation!: Promise<void>;
  await act(async () => {
    operation = value.maybeUnlock();
  });
  expect(fixture.configure).toHaveBeenCalledOnce();
  expect(fixture.ensure).not.toHaveBeenCalled();
  await act(async () => {
    finish({ version: 1, ready: true, descriptor: "test-descriptor" });
    await operation;
  });
  expect(fixture.ensure).toHaveBeenCalledOnce();
});

it("drains native preparation after host failure before releasing the attempt", async () => {
  fixture.settings.autoUnlock = true;
  fixture.invoke.mockResolvedValueOnce({ version: 1, state: "locked" });
  let finish!: () => void;
  fixture.configure.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fixture.invoke.mockRejectedValueOnce(new Error("CREDENTIAL_UNAVAILABLE"));
  let operation!: Promise<void>;
  let settled = false;
  await act(async () => {
    operation = value.maybeUnlock().then(() => {
      settled = true;
    });
  });
  expect(settled).toBe(false);
  expect(fixture.ensure).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await operation;
  });
  expect(settled).toBe(true);
  expect(fixture.ensure).not.toHaveBeenCalled();
});
