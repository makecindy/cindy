import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

class FakeClient extends EventEmitter {
  connect(config: {
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
  }): void {
    config.hostVerifier(Buffer.from("changed-key"), (valid) => {
      this.emit(
        valid ? "ready" : "error",
        new Error("Host denied (verification failed)"),
      );
    });
  }
  end(): void {
    this.emit("close");
  }
}

vi.mock("ssh2", () => ({ Client: vi.fn(() => new FakeClient()) }));
vi.mock("../credentials.js", () => ({
  resolveAuth: vi.fn(async () => ({ label: "agent" })),
}));

import { RemoteHost } from "../RemoteHost.js";
import { hostKeyFingerprint, type HostKeyStore } from "../hostKeys.js";

const config = {
  id: "alias",
  hostname: "example.com",
  port: 2222,
  user: "deploy",
  authMethod: "agent" as const,
  source: "manual" as const,
  managedByCindy: false,
};
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("SSH host key connection errors", () => {
  it.each([
    "/Users/alice/Library/Application Support/Cindy/remote-ssh/known-hosts.json",
    String.raw`C:\Users\alice\AppData\Roaming\Cindy\remote-ssh\known-hosts.json`,
    "/home/alice/.config/Cindy/remote-ssh/known-hosts.json",
  ])("shows the injected store path verbatim: %s", async (filePath) => {
    const store = {
      filePath,
      reload: vi.fn(),
      get: vi.fn(async () => "SHA256:old"),
      set: vi.fn(),
    };
    const host = new RemoteHost(config, { logger, hostKeys: store });
    const error = await host.connect().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "SSH_HOST_KEY_MISMATCH" });
    const message = (error as Error).message;
    expect(message).toContain(filePath);
    expect(message).toContain('"example.com:2222"');
    expect(message).toContain(hostKeyFingerprint(Buffer.from("changed-key")));
    expect(message).toContain("~/.ssh/known_hosts");
    expect(message).toContain("Do not delete the entire file");
    expect(message).not.toContain("maker's known hosts");
    expect(host.snapshot().lastError).toBe(message);
    expect(host.snapshot().hostKeyMismatch).toEqual({
      host: "example.com:2222",
      trusted: "SHA256:old",
      presented: hostKeyFingerprint(Buffer.from("changed-key")),
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each(["read", "write"] as const)(
    "preserves the %s failure and the store path",
    async (kind) => {
      const filePath = "/custom user data/remote-ssh/known-hosts.json";
      const store = {
        filePath,
        reload: vi.fn(),
        get: vi.fn(async () => {
          if (kind === "read") throw new Error("EACCES");
          return null;
        }),
        set: vi.fn(async () => {
          throw new Error("ENOSPC");
        }),
      };
      const host = new RemoteHost(config, { logger, hostKeys: store });
      const error = await host.connect().catch((e: Error) => e);
      expect((error as Error).message).toContain(filePath);
      expect((error as Error).message).toContain(
        kind === "read" ? "EACCES" : "ENOSPC",
      );
      expect(host.snapshot().status).toBe("failed");
    },
  );

  it("does not invent a file path for an in-memory store", async () => {
    const store: HostKeyStore = {
      reload: vi.fn(),
      get: vi.fn(async () => "SHA256:old"),
      set: vi.fn(),
    };
    const host = new RemoteHost(config, { logger, hostKeys: store });
    const error = await host.connect().catch((e: Error) => e);
    expect((error as Error).message).not.toContain("undefined");
    expect((error as Error).message).toContain("Connection refused");
  });

  it("uses the injected formatter for both the rejection and status snapshot", async () => {
    const store = {
      filePath: "/custom/known-hosts.json",
      reload: vi.fn(),
      get: vi.fn(async () => "SHA256:old"),
      set: vi.fn(),
    };
    const formatHostKeyError = vi.fn(() => "主机密钥已变化。连接已拒绝。");
    const host = new RemoteHost(config, {
      logger,
      hostKeys: store,
      formatHostKeyError,
    });
    await expect(host.connect()).rejects.toThrow(
      "主机密钥已变化。连接已拒绝。",
    );
    expect(host.snapshot().lastError).toBe("主机密钥已变化。连接已拒绝。");
    expect(formatHostKeyError).toHaveBeenCalledWith({
      kind: "mismatch",
      host: "example.com:2222",
      filePath: store.filePath,
      fingerprint: hostKeyFingerprint(Buffer.from("changed-key")),
    });
  });
});
