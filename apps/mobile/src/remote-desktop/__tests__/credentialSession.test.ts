import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  owner: { accountId: "owner", accountKey: "global:owner", generation: 1 },
  native: {
    beginUnlock: vi.fn(),
    begin: vi.fn(),
    accept: vi.fn(),
    receive: vi.fn(),
    password: vi.fn(),
    authenticationStatus: vi.fn(),
    request: vi.fn(),
    end: vi.fn(),
    abandonRequest: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => fixture.owner,
  isMobileAuthOwnerCurrent: (owner: unknown) => owner === fixture.owner,
}));
vi.mock("../../../modules/cindy-remote-credentials/src", () => ({
  remoteCredentials: fixture.native,
}));
import {
  isCredentialFailure,
  RemoteDesktopCredentialSession,
} from "../credentialSession";

describe("native credential session coordination", () => {
  const invoke = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.owner = {
      accountId: "owner",
      accountKey: "global:owner",
      generation: 1,
    };
    fixture.native.begin.mockResolvedValue({
      handle: "local",
      offer: "signed-offer",
    });
    fixture.native.accept.mockResolvedValue("encrypted-ready");
    fixture.native.password.mockResolvedValue("encrypted-authentication");
    fixture.native.authenticationStatus.mockResolvedValue("encrypted-status");
    fixture.native.end.mockResolvedValue(null);
    fixture.native.close.mockResolvedValue(undefined);
    fixture.native.abandonRequest.mockResolvedValue(undefined);
    fixture.native.request.mockResolvedValue({
      id: "request",
      ciphertext: "encrypted-command",
    });
    fixture.native.receive
      .mockResolvedValueOnce(JSON.stringify({ kind: "ready", saved: true }))
      .mockResolvedValueOnce(
        JSON.stringify({ kind: "authenticated", accepted: true }),
      );
    invoke.mockImplementation(async (_target, _channel, args, options) => {
      options?.preSend?.();
      return args[0].kind === "open"
        ? { handle: "host", offer: "host-offer" }
        : { ciphertext: "encrypted-reply" };
    });
  });
  it("requires native verification once and reuses it during media recovery", async () => {
    const session = new RemoteDesktopCredentialSession();
    await session.ensure("computer", invoke, "en", "dark");
    await session.ensure("computer", invoke, "en", "dark");
    expect(fixture.native.password).toHaveBeenCalledExactlyOnceWith(
      "local",
      true,
      "en",
      "dark",
    );
    expect(fixture.native.begin).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.map((call) => call[2][0].kind)).toEqual([
      "open",
      "exchange",
      "exchange",
    ]);
  });
  it.each(["frame", "cancel", "close", "owner"])(
    "prepares the channel before the first-frame gate and handles %s",
    async (outcome) => {
      fixture.native.beginUnlock.mockResolvedValue({
        handle: "local",
        offer: "signed-offer",
      });
      const session = new RemoteDesktopCredentialSession();
      let release!: () => void;
      let cancel!: (error: Error) => void;
      const frame = new Promise<void>((resolve, reject) => {
        release = resolve;
        cancel = reject;
      });
      const beforeAuthentication = vi.fn(() => frame);
      const result = session
        .ensure("computer", invoke, "en", "dark", {
          setup: false,
          biometric: true,
          descriptor: "public-descriptor",
          beforeAuthentication,
        })
        .then(
          () => "authenticated",
          (error: Error) => error.message,
        );
      await vi.waitFor(() =>
        expect(beforeAuthentication).toHaveBeenCalledTimes(1),
      );
      expect(invoke.mock.calls.map((call) => call[2][0].kind)).toEqual([
        "open",
        "exchange",
      ]);
      expect(fixture.native.password).not.toHaveBeenCalled();
      if (outcome === "close") session.close();
      if (outcome === "owner")
        fixture.owner = { ...fixture.owner, generation: 2 };
      if (outcome === "cancel") cancel(new Error("CREDENTIAL_CANCELLED"));
      else release();
      expect(await result).toBe(
        outcome === "frame" ? "authenticated" : "CREDENTIAL_CANCELLED",
      );
      expect(fixture.native.password).toHaveBeenCalledTimes(
        outcome === "frame" ? 1 : 0,
      );
      session.close();
    },
  );
  it("passes only public descriptors over the existing connection during local pairing", async () => {
    fixture.native.beginUnlock.mockResolvedValue({
      handle: "local",
      offer: "signed-offer",
      descriptor: "phone-public-descriptor",
    });
    const session = new RemoteDesktopCredentialSession();
    await session.ensure("computer", invoke, "en", "light", {
      setup: true,
      biometric: true,
      descriptor: "mac-public-descriptor",
    });
    expect(fixture.native.beginUnlock).toHaveBeenCalledWith(
      "computer",
      true,
      true,
      "mac-public-descriptor",
    );
    expect(invoke.mock.calls[0][2][0]).toEqual({
      op: "credential",
      version: 1,
      kind: "open",
      offer: "signed-offer",
      descriptor: "phone-public-descriptor",
    });
    expect(fixture.native.password).toHaveBeenCalledWith(
      "local",
      false,
      "en",
      "light",
    );
    expect(fixture.native.begin).not.toHaveBeenCalled();
  });
  it("queries a lost authentication outcome without sending the password twice", async () => {
    const session = new RemoteDesktopCredentialSession();
    invoke.mockImplementation(async (_target, _channel, args, options) => {
      options?.preSend?.();
      if (args[0].ciphertext === "encrypted-authentication")
        throw new Error("TIMEOUT");
      return args[0].kind === "open"
        ? { handle: "host", offer: "host-offer" }
        : { ciphertext: "encrypted-reply" };
    });
    await expect(
      session.ensure("computer", invoke, "en", "light"),
    ).rejects.toThrow("TIMEOUT");
    await session.ensure("computer", invoke, "en", "light");
    expect(fixture.native.password).toHaveBeenCalledTimes(1);
    expect(fixture.native.authenticationStatus).toHaveBeenCalledExactlyOnceWith(
      "local",
    );
  });
  it("cleans up a native handle created after the page was closed", async () => {
    const session = new RemoteDesktopCredentialSession();
    let complete!: (value: { handle: string; offer: string }) => void;
    fixture.native.begin.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = session.ensure("computer", invoke, "en", "light");
    session.close();
    complete({ handle: "late", offer: "late-offer" });
    await expect(pending).rejects.toThrow("CREDENTIAL_CANCELLED");
    expect(fixture.native.close).toHaveBeenCalledWith("late");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("abandons sealed requests that lose their owner before transport", async () => {
    const session = new RemoteDesktopCredentialSession();
    await session.ensure("computer", invoke, "en", "light");
    invoke.mockClear();
    fixture.native.request.mockImplementation(async () => {
      fixture.owner = { ...fixture.owner, generation: 2 };
      return { id: "superseded", ciphertext: "encrypted-command" };
    });
    await expect(
      session.request({ op: "capabilities" }, invoke),
    ).rejects.toThrow("CREDENTIAL_CANCELLED");
    expect(fixture.native.abandonRequest).toHaveBeenCalledWith(
      "local",
      "superseded",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it("recognizes fixed native bridge error codes independently of their message", () => {
    expect(
      isCredentialFailure({
        code: "CREDENTIAL_CANCELLED",
        message: "Native exception",
      }),
    ).toBe(true);
    expect(isCredentialFailure(new Error("TIMEOUT"))).toBe(false);
  });
  it("revokes the exact host handle on exit and clears native state even if transport fails", async () => {
    const session = new RemoteDesktopCredentialSession();
    await session.ensure("computer", invoke, "en", "light");
    fixture.native.end.mockResolvedValue("encrypted-revoke");
    invoke.mockClear();
    invoke.mockRejectedValue(new Error("OFFLINE"));
    session.close();
    expect(session.matches("local")).toBe(false);
    await vi.waitFor(() =>
      expect(fixture.native.close).toHaveBeenCalledWith("local"),
    );
    expect(invoke).toHaveBeenCalledWith(
      "computer",
      expect.any(String),
      [
        {
          op: "credential",
          version: 1,
          kind: "exchange",
          handle: "host",
          ciphertext: "encrypted-revoke",
        },
      ],
      expect.objectContaining({ preSend: expect.any(Function) }),
    );
  });
  it("does not send a late revoke using a different account owner", async () => {
    const session = new RemoteDesktopCredentialSession();
    await session.ensure("computer", invoke, "en", "light");
    let complete!: (ciphertext: string) => void;
    fixture.native.end.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    invoke.mockClear();
    session.close();
    fixture.owner = { ...fixture.owner, generation: 2 };
    complete("encrypted-revoke");
    await vi.waitFor(() =>
      expect(fixture.native.close).toHaveBeenCalledWith("local"),
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
