import { expect, it, vi } from "vitest";
import { ClipboardSync, type ClipboardSyncDeps } from "../clipboardSync";

function fixture() {
  const local = { version: 1, json: '{"text":"local"}', error: "" };
  const remote = { version: 1, json: '{"text":"remote"}', error: "" };
  const trace = vi.fn();
  const write = vi.fn(async (json: string, version: string) => {
    expect(version).toBe(String(local.version));
    Object.assign(local, { json, error: "" });
    return String(++local.version);
  });
  const request = vi.fn(
    async (message: Parameters<ClipboardSyncDeps["request"]>[0]) => {
      if (message.op === "clipboardVersion")
        return { version: String(remote.version) };
      if (message.op !== "clipboardContent")
        throw new Error("UNEXPECTED_REQUEST");
      if (message.action === "copy") {
        if (remote.error) throw new Error(remote.error);
        return { data: remote.json, length: remote.json.length };
      }
      if (message.action === "paste") {
        expect(message.version).toBe(String(remote.version));
        Object.assign(remote, { json: message.data, error: "" });
        return { version: String(++remote.version) };
      }
      throw new Error("UNEXPECTED_REQUEST");
    },
  );
  const read = vi.fn(async () => {
    if (local.error) throw new Error(local.error);
    return local.json;
  });
  const engine = new ClipboardSync({
    lease: "lease",
    inline: true,
    current: () => true,
    digest: (json) => json,
    trace,
    localVersion: async () => String(local.version),
    readLocal: read,
    writeLocal: write,
    request: request as ClipboardSyncDeps["request"],
  });
  return { engine, local, remote, trace, write, read, request };
}

it.each([
  ["", "local"],
  ["", "remote"],
  ["CLIPBOARD_UNSUPPORTED", "local"],
  ["CLIPBOARD_UNSUPPORTED", "remote"],
  ["CLIPBOARD_TOO_LONG", "local"],
  ["CLIPBOARD_TOO_LONG", "remote"],
] as const)(
  "after a conflict with peer error %s, an identical %s recopy selects the source",
  async (code, chosen) => {
    const h = fixture();
    await h.engine.tick();
    const other = chosen === "local" ? "remote" : "local";
    h.local.version++;
    h.remote.version++;
    h.local.json = '{"text":"local choice"}';
    h.remote.json = '{"text":"remote choice"}';
    h[other].error = code;
    await expect(h.engine.tick()).rejects.toThrow("CLIPBOARD_CONFLICT");
    h.trace.mockClear();
    await h.engine.tick();
    expect(h.trace).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ),
    ).toBe(false);
    const selected = h[chosen].json;
    h[chosen].version++;
    await h.engine.tick();
    expect(h.local.json).toBe(selected);
    expect(h.remote.json).toBe(selected);
    expect(h[other].error).toBe("");
    expect(h.trace).toHaveBeenLastCalledWith(
      chosen === "local"
        ? "phone-to-computer-complete"
        : "computer-to-phone-complete",
    );
    const writes = h.write.mock.calls.length;
    const pastes = h.request.mock.calls.filter(
      ([m]) => m.op === "clipboardContent" && m.action === "paste",
    ).length;
    // A completed transfer restores deduplication, including its delayed echoes.
    h.local.version++;
    h.remote.version++;
    await h.engine.tick();
    expect(h.write).toHaveBeenCalledTimes(writes);
    expect(
      h.request.mock.calls.filter(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ),
    ).toHaveLength(pastes);
  },
);

it.each(["CLIPBOARD_EMPTY", "CLIPBOARD_UNSUPPORTED", "CLIPBOARD_TOO_LONG"])(
  "silently establishes both initial %s baselines, then syncs a new copy",
  async (code) => {
    const h = fixture();
    h.local.error = h.remote.error = code;
    await h.engine.tick();
    await h.engine.tick();
    expect(
      h.trace.mock.calls.some(([stage]) => stage === "content-skipped"),
    ).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.write).not.toHaveBeenCalled();
    h.local.version++;
    h.local.error = "";
    await h.engine.tick();
    expect(h.remote.json).toBe(h.local.json);
    expect(h.trace).toHaveBeenLastCalledWith("phone-to-computer-complete");
  },
);

it.each(["local", "remote"] as const)(
  "an empty %s snapshot neither clears the other clipboard nor blocks its next copy",
  async (side) => {
    const h = fixture();
    await h.engine.tick();
    h[side].version++;
    h[side].error = "CLIPBOARD_EMPTY";
    await h.engine.tick();
    expect(h.trace).toHaveBeenLastCalledWith("unchanged-content");
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ),
    ).toBe(false);
    // Another empty version alongside a real copy is still not a conflict.
    h[side].version++;
    const other = side === "local" ? "remote" : "local";
    h[other].version++;
    h[other].json = '{"text":"new copy"}';
    await h.engine.tick();
    expect(h.local.json).toBe(h.remote.json);
    expect(h[side].error).toBe("");
  },
);

it.each(["CLIPBOARD_UNSUPPORTED", "CLIPBOARD_TOO_LONG"])(
  "reports the specific %s code once per changed snapshot",
  async (code) => {
    const h = fixture();
    await h.engine.tick();
    h.local.version++;
    h.local.error = code;
    await h.engine.tick();
    expect(h.trace).toHaveBeenLastCalledWith("content-skipped", code);
    h.trace.mockClear();
    await h.engine.tick();
    expect(h.trace).not.toHaveBeenCalled();
  },
);

it.each([
  ["local", false],
  ["remote", false],
  ["local", true],
  ["remote", true],
] as const)(
  "restores identical content to cleared %s (same pass: %s), then resumes deduplication",
  async (destination, samePass) => {
    const h = fixture();
    const source = destination === "local" ? "remote" : "local";
    const transfers = () =>
      h.write.mock.calls.length +
      h.request.mock.calls.filter(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ).length;
    await h.engine.tick();
    h[destination].version++;
    h[destination].error = "CLIPBOARD_EMPTY";
    if (!samePass) {
      await h.engine.tick();
      await h.engine.tick();
      expect(transfers()).toBe(0);
    }
    h[source].version++; // Explicitly recopy exactly its previous content.
    await h.engine.tick();
    expect(h[destination].error).toBe("");
    expect(h[destination].json).toBe(h[source].json);
    expect(transfers()).toBe(1);
    await h.engine.tick();
    h[source].version++;
    h[destination].version++; // Identical rewrites after restoration are deduped.
    await h.engine.tick();
    expect(transfers()).toBe(1);
  },
);

it.each(["local", "remote"] as const)(
  "does not import old identical content into an initially empty %s clipboard",
  async (destination) => {
    const h = fixture();
    const source = destination === "local" ? "remote" : "local";
    h[destination].error = "CLIPBOARD_EMPTY";
    await h.engine.tick();
    h[source].version++;
    await h.engine.tick();
    expect(h[destination].error).toBe("CLIPBOARD_EMPTY");
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ),
    ).toBe(false);
  },
);

it("does not accept an empty remote read whose version changed during the read", async () => {
  const h = fixture();
  await h.engine.tick();
  h.remote.version++;
  const request = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (message) => {
    if (message.op === "clipboardContent" && message.action === "copy") {
      h.remote.version++;
      throw new Error("CLIPBOARD_EMPTY");
    }
    return request(message);
  });
  await expect(h.engine.tick()).rejects.toThrow("CLIPBOARD_CHANGED");
  expect(h.write).not.toHaveBeenCalled();
});

it.each([
  ["local", "CLIPBOARD_UNSUPPORTED"],
  ["remote", "CLIPBOARD_UNSUPPORTED"],
  ["local", "CLIPBOARD_TOO_LONG"],
  ["remote", "CLIPBOARD_TOO_LONG"],
] as const)(
  "an empty %s peer does not conflict with %s on the other peer",
  async (side, code) => {
    const h = fixture();
    await h.engine.tick();
    const other = side === "local" ? "remote" : "local";
    h[side].version++;
    h[side].error = "CLIPBOARD_EMPTY";
    h[other].version++;
    h[other].error = code;
    await h.engine.tick();
    expect(h.trace).toHaveBeenLastCalledWith("content-skipped", code);
    expect(h.write).not.toHaveBeenCalled();
    expect(
      h.request.mock.calls.some(
        ([m]) => m.op === "clipboardContent" && m.action === "paste",
      ),
    ).toBe(false);
    h.trace.mockClear();
    const reads = h.read.mock.calls.length;
    const requests = h.request.mock.calls.length;
    await h.engine.tick();
    expect(h.trace).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(reads);
    expect(h.request).toHaveBeenCalledTimes(requests + 1); // Version only.
    // The next supported copy still reaches the cleared peer.
    h[other].version++;
    h[other].error = "";
    h[other].json = '{"text":"next copy"}';
    await h.engine.tick();
    expect(h.local.json).toBe(h.remote.json);
    expect(h[side].error).toBe("");
  },
);

it.each(["local", "remote"] as const)(
  "does not consume skipped snapshots when the empty %s peer changes during its read",
  async (side) => {
    const h = fixture();
    await h.engine.tick();
    const other = side === "local" ? "remote" : "local";
    h[side].version++;
    h[side].error = "CLIPBOARD_EMPTY";
    h[other].version++;
    h[other].error = "CLIPBOARD_TOO_LONG";
    if (side === "local") {
      const read = h.read.getMockImplementation()!;
      h.read.mockImplementationOnce(async () => {
        h.local.version++;
        return read();
      });
    } else {
      const request = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (message) => {
        if (message.op === "clipboardContent" && message.action === "copy")
          h.remote.version++;
        return request(message);
      });
    }
    await expect(h.engine.tick()).rejects.toThrow("CLIPBOARD_CHANGED");
    expect(
      h.trace.mock.calls.some(([stage]) => stage === "content-skipped"),
    ).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
  },
);
