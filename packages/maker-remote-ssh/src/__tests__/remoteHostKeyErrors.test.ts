import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

let holdHandshake = false;
const clients: FakeClient[] = [];
class FakeClient extends EventEmitter {
  verifyPending?: () => void;
  constructor() { super(); clients.push(this); }
  connect(config: {
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void;
  }): void {
    this.verifyPending = () => config.hostVerifier(Buffer.from("changed-key"), (valid) => {
      this.emit(
        valid ? "ready" : "error",
        new Error("Host denied (verification failed)"),
      );
    });
    if (!holdHandshake) this.verifyPending();
  }
  end(): void {
    this.emit("close");
  }
}

vi.mock("ssh2", async (original) => ({ ...await original<typeof import("ssh2")>(), Client: vi.fn(() => new FakeClient()) }));
vi.mock("../credentials.js", () => ({
  resolveAuth: vi.fn(async () => ({ label: "agent" })),
}));

import { ConnectionPool } from "../ConnectionPool.js";
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

// #8403 / cindy-machines §3, unit: real pool + verifier. Existing key-error
// tests never prohibit first trust or interleave callers. Minimal input is a
// missing synthetic fingerprint at handshake, including after a ready drop.
afterEach(() => { holdHandshake = false; clients.length = 0; vi.useRealTimers(); });
const matching = hostKeyFingerprint(Buffer.from("changed-key"));
function keyStore(value: string | null = null) {
  return { reload: vi.fn(), get: vi.fn(async () => value),
    set: vi.fn(async (_key: string, next: string) => { value = next; }) };
}
async function handshakeClient(index = clients.length - 1) {
  await vi.waitFor(() => expect(clients[index]?.verifyPending).toBeTypeOf('function'));
  clients[index].verifyPending!();
}
// SSH access to the person's own devices (decision 8): a host whose managed block pins its key (HostKeyAlias +
// StrictHostKeyChecking yes) looks the key up under the alias and never trusts an unknown key, not even on an
// explicit connect. Unit tier, real pool and verifier with a fake ssh2 client.
describe('pinned device hosts', () => {
  const pinned = { ...config, id: 'cindy-studio', managedByCindy: true, hostKeyAlias: 'cindy-device-abc', strictHostKeyChecking: true };
  it.each([null, 'SHA256:old'])('refuses an explicit connect without the pinned key (stored %s)', async (value) => {
    const store = keyStore(value);
    const pool = new ConnectionPool({ logger, hostKeys: store });
    pool.add(pinned);
    try {
      await expect(pool.connect(pinned.id)).rejects.toMatchObject({
        code: value === null ? 'SSH_HOST_UNVERIFIED' : 'SSH_HOST_KEY_MISMATCH',
      });
      expect(store.get).toHaveBeenCalledWith('cindy-device-abc');
      expect(store.set).not.toHaveBeenCalled();
    } finally { await pool.dispose(); }
  });
  it('connects when the alias holds the presented key', async () => {
    const store = keyStore(matching);
    const pool = new ConnectionPool({ logger, hostKeys: store });
    pool.add(pinned);
    try {
      await expect(pool.connect(pinned.id)).resolves.toBeUndefined();
      expect(store.get).toHaveBeenCalledWith('cindy-device-abc');
    } finally { await pool.dispose(); }
  });
});

describe('trusted-only SSH connections (#8403)', () => {
  it.each([null, matching, 'SHA256:old'])('enforces handshake trust without writing: %s', async value => {
    const store = keyStore(value);
    const pool = new ConnectionPool({ logger, hostKeys: store });
    pool.add(config);
    try {
      const result = pool.connect(config.id, { allowFirstTrust: false });
      if (value === matching) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toMatchObject({ code: value === null ? 'SSH_HOST_UNVERIFIED' : 'SSH_HOST_KEY_MISMATCH' });
      expect(store.set).not.toHaveBeenCalled();
    } finally { await pool.dispose(); }
  });
  it.each([false, true])('preserves active TOFU and automatic refusal; active first = %s', async activeFirst => {
    holdHandshake = true;
    const store = keyStore();
    const host = new RemoteHost(config, { logger, hostKeys: store });
    const first = host.connect({ allowFirstTrust: activeFirst });
    const second = host.connect({ allowFirstTrust: !activeFirst });
    const active = activeFirst ? first : second;
    const automatic = activeFirst ? second : first;
    const denied = expect(automatic).rejects.toMatchObject({ code: 'SSH_HOST_UNVERIFIED' });
    try {
      await handshakeClient(0);
      await denied;
      if (!activeFirst) await handshakeClient(1);
      await active;
      expect(store.set).toHaveBeenCalledTimes(1);
      expect(host.getStatus()).toBe('ready');
    } finally { await host.disconnect(); }
  });
  it('does not resurrect an explicit disconnect when an active caller joins a failing probe', async () => {
    holdHandshake = true;
    const store = keyStore();
    const host = new RemoteHost(config, { logger, hostKeys: store });
    const off = host.onStatus(snapshot => {
      if (snapshot.status === 'failed') void host.disconnect();
    });
    try {
      const outcomes = Promise.allSettled([host.connect({ allowFirstTrust: false }), host.connect()]);
      holdHandshake = false; // A wrongly resurrected retry must complete, not time out.
      await handshakeClient(0);
      expect(await outcomes).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'SSH_HOST_UNVERIFIED' }) },
        { status: 'rejected', reason: expect.objectContaining({ code: 'SSH_HOST_UNVERIFIED' }) },
      ]);
      expect(clients).toHaveLength(1);
      expect(host.getStatus()).toBe('disconnected');
      expect(store.set).not.toHaveBeenCalled();
    } finally { off(); await host.disconnect(); }
  });
  it('joins a matching active handshake without replacing it', async () => {
    holdHandshake = true;
    const store = keyStore(matching);
    const host = new RemoteHost(config, { logger, hostKeys: store });
    try {
      const active = host.connect();
      const automatic = host.connect({ allowFirstTrust: false });
      await handshakeClient(0);
      await Promise.all([active, automatic]);
      expect(clients).toHaveLength(1);
      expect(store.set).not.toHaveBeenCalled();
    } finally { await host.disconnect(); }
  });
  it('keeps trusted-only policy on automatic reconnect after trust removal', async () => {
    vi.useFakeTimers();
    let value: string | null = matching;
    const store = { reload: vi.fn(), get: vi.fn(async () => value), set: vi.fn() };
    const host = new RemoteHost(config, { logger, hostKeys: store });
    const onStatus = vi.fn();
    host.onStatus(onStatus);
    try {
      await host.connect({ allowFirstTrust: false });
      value = null;
      clients[0].emit('close');
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.getStatus()).toBe('failed');
      expect(host.snapshot().lastError).toContain('SSH_HOST_UNVERIFIED');
      expect(onStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
        expect.objectContaining({ code: 'SSH_HOST_UNVERIFIED' }),
      );
      expect(store.set).not.toHaveBeenCalled();
      expect(host.retryAfterNetworkChange()).toBe(false);
      await vi.advanceTimersByTimeAsync(60000);
      expect(clients).toHaveLength(2);
      // A later explicit default connect retains existing TOFU behavior.
      await host.connect();
      expect(store.set).toHaveBeenCalledTimes(1);
    } finally { await host.disconnect(); }
  });
});
