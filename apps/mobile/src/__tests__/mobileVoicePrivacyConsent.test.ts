import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStorage = vi.hoisted(() => ({
  getSecureItem: vi.fn(async () => null as string | null),
  setSecureItem: vi.fn(async () => undefined),
}));

vi.mock("@/auth/secureStorage", () => secureStorage);
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

describe("mobile voice privacy consent persistence", () => {
  beforeEach(() => {
    secureStorage.getSecureItem.mockClear();
    secureStorage.setSecureItem.mockClear();
    secureStorage.setSecureItem.mockResolvedValue(undefined);
  });

  it("treats a successful secure-store write as consent accepted", async () => {
    const { persistMobileVoicePrivacyConsent } =
      await import("@/session/mobileVoicePrivacyConsent");

    await expect(persistMobileVoicePrivacyConsent()).resolves.toBe(true);
    expect(secureStorage.setSecureItem).toHaveBeenCalledTimes(1);
    expect(secureStorage.getSecureItem).not.toHaveBeenCalled();
  });

  it("reports a secure-store write failure", async () => {
    secureStorage.setSecureItem.mockRejectedValueOnce(
      new Error("secure store unavailable"),
    );
    const { persistMobileVoicePrivacyConsent } =
      await import("@/session/mobileVoicePrivacyConsent");

    await expect(persistMobileVoicePrivacyConsent()).resolves.toBe(false);
  });
});
