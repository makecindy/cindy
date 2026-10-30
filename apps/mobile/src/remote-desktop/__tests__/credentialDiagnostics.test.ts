import { afterEach, describe, expect, it, vi } from "vitest";
import { setMobileDebugSink } from "@/debug/mobileDebugLog";
import {
  credentialDiagnosticCode,
  credentialStep,
} from "../credentialDiagnostics";

afterEach(() => setMobileDebugSink(undefined));
describe("auto unlock local diagnostics", () => {
  it("records a stage and fixed code without the error payload", async () => {
    const sink = vi.fn();
    setMobileDebugSink(sink);
    const error = new Error(
      "CREDENTIAL_EXPIRED password=private-test-value token=private-test-token",
    );
    await expect(
      credentialStep("host-exchange", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const log = JSON.stringify(sink.mock.calls);
    expect(log).toContain("host-exchange");
    expect(log).toContain("CREDENTIAL_EXPIRED");
    expect(log).not.toContain("private-test");
    expect(log).not.toContain("password=");
  });
  it("records saved-password failures without native error details", async () => {
    const sink = vi.fn();
    setMobileDebugSink(sink);
    const error = new Error(
      "CREDENTIAL_SAVED_READ_DENIED private-test-keychain-details",
    );
    await expect(
      credentialStep("password-or-face-id", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const log = JSON.stringify(sink.mock.calls);
    expect(log).toContain("CREDENTIAL_SAVED_READ_DENIED");
    expect(log).not.toContain("private-test");
  });
  it("never logs successful native replies or tokens", async () => {
    const sink = vi.fn();
    setMobileDebugSink(sink);
    const secret = {
      token: "private-test-value",
      descriptor: "private-test-key",
    };
    await expect(
      credentialStep("phone-begin", async () => secret),
    ).resolves.toBe(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-test");
  });
  it("does not turn arbitrary native errors into log content", () => {
    expect(
      credentialDiagnosticCode({ code: "SECRET_VALUE", message: "private" }),
    ).toBe("UNKNOWN");
    expect(
      credentialDiagnosticCode(new Error("CREDENTIAL_EXPIRED_PRIVATE")),
    ).toBe("UNKNOWN");
    expect(
      credentialDiagnosticCode({
        get code() {
          throw new Error("private");
        },
      }),
    ).toBe("UNKNOWN");
  });
});
