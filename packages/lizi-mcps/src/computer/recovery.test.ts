import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerMcpServer } from "./server.js";
import { readForRecovery } from "./recovery.js";
import type { ComputerMcpDeps } from "../types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function harness(dispatch: ComputerMcpDeps["callTool"]) {
  const server = createComputerMcpServer(
    { getStatus: vi.fn(), callTool: dispatch },
    { sessionId: "recovery-test" },
  );
  const client = new Client({ name: "recovery-test", version: "1" });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name, args },
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
}

describe("bounded Computer Use recovery", () => {
  it("observes unknown input exactly once, preserving uncertainty and session provenance", async () => {
    const raw = { effect: "unverifiable", remaining_chars: 450 };
    const dispatch = vi.fn(async (name: string) =>
      name === "type_text"
        ? raw
        : { elements: [], snapshot_id: "fresh-native" },
    );
    const call = await harness(dispatch);
    const result = await call("type_text", {
      pid: 1,
      window_id: 2,
      text: "hello",
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: { status: "unknown" },
      data: raw,
      postcheck: {
        tool: "get_window_state",
        ok: true,
        reusable_snapshot: false,
      },
    });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
      "type_text",
      "get_window_state",
    ]);
    expect(dispatch).toHaveBeenLastCalledWith(
      "get_window_state",
      {
        pid: 1,
        window_id: 2,
        session: "recovery-test",
        include_screenshot: false,
      },
      expect.objectContaining({
        sessionId: "recovery-test",
        observationPurpose: "recovery",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([false, true])("does not capture recovery screenshots or accept degraded text evidence (thrown=%s)", async (thrown) => {
    const dispatch = vi.fn(async (name: string) => {
      if (name === "click") {
        if (thrown) throw Object.assign(new Error("unknown delivery"), { outcomeUnknown: true });
        return { effect: "unverifiable" };
      }
      return { degraded: true, elements: [], tree_markdown: "" };
    });
    const call = await harness(dispatch);
    const result = await call("click", { pid: 1, window_id: 2, x: 2, y: 3 });
    expect(result.postcheck).toMatchObject({ tool: "get_window_state", ok: false });
    if (thrown) expect(result.data.outcome_unknown).toBe(true);
    else expect(result.outcome.status).toBe("unknown");
    expect(dispatch).toHaveBeenLastCalledWith(
      "get_window_state",
      { pid: 1, window_id: 2, session: "recovery-test", include_screenshot: false },
      expect.objectContaining({ observationPurpose: "recovery" }),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not let a late automatic observation supersede a newer explicit snapshot", async () => {
    let reads = 0;
    let clicks = 0;
    let finish!: (value: unknown) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const call = await harness(async (name) => {
      if (name === "click")
        return { effect: ++clicks === 1 ? "unverifiable" : "confirmed" };
      if (++reads === 2) {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return { snapshot_id: `native-${reads}`, elements: [] };
    });
    const first = await call("get_window_state", { pid: 1, window_id: 2 });
    const pending = call("click", {
      pid: 1,
      element_index: 0,
      snapshot_id: first.snapshot_id,
    });
    await started;
    const fresh = await call("get_window_state", { pid: 1, window_id: 2 });
    finish({ snapshot_id: "late-auto", elements: [] });
    expect(await pending).toMatchObject({
      postcheck: { reusable_snapshot: false },
    });
    expect(
      await call("click", {
        pid: 1,
        element_index: 0,
        snapshot_id: fresh.snapshot_id,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await call("click", {
        pid: 1,
        element_index: 0,
        snapshot_id: first.snapshot_id,
      }),
    ).toMatchObject({ errorCode: "STALE_SNAPSHOT" });
  });

  it.each(["satisfied", "unsatisfied"])(
    "checks an explicit postcondition: %s",
    async (status) => {
      const dispatch = vi.fn(async (name: string) =>
        name === "verify_state" ? { status } : { effect: "unverifiable" },
      );
      const call = await harness(dispatch);
      const postcondition = [
        {
          element: {
            selector: { role: "AXTextField", label_contains: "Name" },
            value_equals: "hello",
          },
        },
      ];
      const result = await call("type_text", {
        pid: 1,
        window_id: 2,
        text: "hello",
        postcondition,
      });
      expect(result.ok).toBe(status === "satisfied");
      expect(result.outcome.status === "confirmed").toBe(
        status === "satisfied",
      );
      expect(result.data).toEqual({ effect: "unverifiable" });
      expect(dispatch).toHaveBeenNthCalledWith(
        1,
        "type_text",
        { pid: 1, window_id: 2, text: "hello", session: "recovery-test" },
        expect.anything(),
      );
      expect(dispatch).toHaveBeenLastCalledWith(
        "verify_state",
        expect.objectContaining({
          expect: postcondition,
          timeout_ms: 1500,
          stable_samples: 2,
        }),
        expect.anything(),
      );
      expect(dispatch).toHaveBeenCalledTimes(2);
    },
  );

  it("does not confirm incomplete chunked input even when a weak postcondition matches", async () => {
    const call = await harness(async (name) =>
      name === "verify_state"
        ? { status: "satisfied" }
        : { effect: "unverifiable", remaining_chars: 400 },
    );
    expect(
      await call("type_text", {
        pid: 1,
        window_id: 2,
        text: "hello",
        postcondition: [{ window: { exists: true } }],
      }),
    ).toMatchObject({
      outcome: { status: "unknown" },
      data: { remaining_chars: 400 },
    });
  });

  it("rejects unverifiable target/predicate arguments before dispatch", async () => {
    const dispatch = vi.fn();
    const call = await harness(dispatch);
    expect(
      await call("click", {
        pid: 1,
        x: 2,
        y: 3,
        postcondition: [{ window: { exists: true } }],
      }),
    ).toMatchObject({ errorCode: "INVALID_ARGS" });
    expect(
      await call("click", {
        pid: 1,
        window_id: 2,
        x: 2,
        y: 3,
        postcondition: [],
      }),
    ).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the original action error if the read-only postcheck fails", async () => {
    const dispatch = vi.fn(async (name: string) => {
      if (name === "click")
        throw Object.assign(new Error("Malformed driver success"), {
          code: "DRIVER_OUTPUT_SCHEMA_MISMATCH",
          outcomeUnknown: true,
        });
      throw new Error("Capture failed");
    });
    const call = await harness(dispatch);
    expect(
      await call("click", { pid: 1, window_id: 2, x: 2, y: 3 }),
    ).toMatchObject({
      ok: false,
      errorCode: "DRIVER_OUTPUT_SCHEMA_MISMATCH",
      data: { message: "Malformed driver success", outcome_unknown: true },
      postcheck: { ok: false, error: { message: "Capture failed" } },
    });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
      "click",
      "get_window_state",
    ]);
  });

  it("discovers replacement PID/window candidates without selecting or clicking one", async () => {
    const windows = [{ pid: 99, window_id: 100, app_name: "Cindy" }];
    const dispatch = vi.fn(async (name: string) => {
      if (name === "list_windows") return { windows };
      throw Object.assign(new Error("gone"), { code: "window_id_not_found" });
    });
    const call = await harness(dispatch);
    expect(
      await call("click", { pid: 1, window_id: 2, x: 2, y: 3 }),
    ).toMatchObject({
      ok: false,
      recovery: {
        target_selected: false,
        requested_target: { pid: 1, window_id: 2 },
        discovery: { data: { windows } },
      },
    });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
      "click",
      "list_windows",
    ]);
    expect(dispatch).toHaveBeenLastCalledWith(
      "list_windows",
      { session: "recovery-test" },
      expect.anything(),
    );
  });

  it.each([1, 2])(
    "locates only an unambiguous running app (%s matching processes)",
    async (processes) => {
      const windows = Array.from({ length: processes }, (_, i) => ({
        pid: i + 1,
        window_id: i,
        app_name: "Simulator",
      }));
      const dispatch = vi.fn(async (name: string) => {
        if (name === "list_apps") return { apps: [] };
        if (name === "list_windows") return { windows };
        throw new Error('No installed macOS app found for name "Simulator"');
      });
      const call = await harness(dispatch);
      const result = await call("launch_app", { name: "Simulator" });
      expect(result.ok).toBe(processes === 1);
      if (processes === 1)
        expect(result.data).toMatchObject({
          located: true,
          launched: false,
          pid: 1,
        });
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
        "launch_app",
        "list_apps",
        "list_windows",
      ]);
    },
  );

  it.each([
    { urls: ["https://example.test"] },
    { creates_new_application_instance: true },
    { additional_arguments: ["--flag"] },
    { bundle_id: "example.app" },
    { webkit_inspector_port: 1234 },
  ])(
    "does not substitute locating for launch side effects: %j",
    async (extra) => {
      const dispatch = vi.fn(async (name: string) => {
        if (name === "list_apps") return { apps: [] };
        throw new Error('No installed macOS app found for name "Simulator"');
      });
      const call = await harness(dispatch);
      expect(
        await call("launch_app", { name: "Simulator", ...extra }),
      ).toMatchObject({ ok: false });
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual(
        "bundle_id" in extra ? ["launch_app"] : ["launch_app", "list_apps"],
      );
    },
  );

  it("resolves a unique installed bundle once while preserving all launch intent", async () => {
    const dispatch = vi.fn<ComputerMcpDeps["callTool"]>(async (name, args) => {
      if (name === "list_apps")
        return { apps: [{ name: "Example", bundle_id: "com.example.app" }] };
      if (args.bundle_id) return { pid: 12, launched: true };
      throw Object.assign(
        new Error('No installed macOS app found for name "Example"'),
        { code: "APP_NOT_INSTALLED" },
      );
    });
    const call = await harness(dispatch);
    const args = {
      name: "Example",
      urls: ["https://example.test"],
      additional_arguments: ["--flag"],
      creates_new_application_instance: true,
    };
    expect(await call("launch_app", args)).toMatchObject({
      ok: true,
      data: { pid: 12, launched: true },
      recovery: { resolved_bundle_id: "com.example.app" },
    });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
      "launch_app",
      "list_apps",
      "launch_app",
    ]);
    expect(dispatch).toHaveBeenLastCalledWith(
      "launch_app",
      { ...args, bundle_id: "com.example.app" },
      expect.objectContaining({ sessionId: "recovery-test" }),
    );
  });

  it("does not guess among duplicate installed names or missing bundle IDs", async () => {
    for (const apps of [
      [{ name: "Example" }],
      [
        { name: "Example", bundle_id: "one" },
        { name: "Example", bundle_id: "two" },
      ],
    ]) {
      const dispatch = vi.fn(async (name: string) => {
        if (name === "list_apps") return { apps };
        if (name === "list_windows") return { windows: [] };
        throw new Error('No installed macOS app found for name "Example"');
      });
      expect(
        await (
          await harness(dispatch)
        )("launch_app", { name: "Example" }),
      ).toMatchObject({ ok: false });
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
        "launch_app",
        "list_apps",
        "list_windows",
      ]);
    }
  });

  it("stops after one resolved-bundle launch attempt, even on another resolution error", async () => {
    const dispatch = vi.fn(async (name: string) => {
      if (name === "list_apps")
        return { apps: [{ name: "Example", bundle_id: "com.example.app" }] };
      throw new Error('No installed macOS app found for name "Example"');
    });
    expect(
      await (
        await harness(dispatch)
      )("launch_app", { name: "Example" }),
    ).toMatchObject({ ok: false, recovery: { retry_exhausted: true } });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
      "launch_app",
      "list_apps",
      "launch_app",
    ]);
  });

  it("does not create recovery traffic after the host has closed an action session", async () => {
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error("Closed"), {
        code: "REQUEST_CANCELLED",
        outcomeUnknown: true,
      });
    });
    const call = await harness(dispatch);
    expect(
      await call("click", { pid: 1, window_id: 2, x: 2, y: 3 }),
    ).toMatchObject({ errorCode: "REQUEST_CANCELLED" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a similar name or a generic launch error as successful discovery", async () => {
    const call = await harness(async (name) => {
      if (name === "list_windows")
        return { windows: [{ pid: 1, app_name: "Simulator Helper" }] };
      throw new Error('No installed macOS app found for name "Simulator"');
    });
    expect(await call("launch_app", { name: "Simulator" })).toMatchObject({
      ok: false,
    });
    const dispatch = vi.fn(async () => {
      throw new Error("transport closed");
    });
    expect(
      await (
        await harness(dispatch)
      )("launch_app", { name: "Simulator" }),
    ).toMatchObject({ ok: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled read and cancels the underlying request without retry", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn<ComputerMcpDeps["callTool"]>(
      () => new Promise(() => {}),
    );
    const pending = readForRecovery(
      { getStatus: vi.fn(), callTool: dispatch },
      "list_windows",
      {},
      {},
      20,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_TIMEOUT" },
    });
    expect(dispatch.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before and during recovery and ignores late responses", async () => {
    const controller = new AbortController();
    let finish!: (data: unknown) => void;
    const dispatch = vi.fn<ComputerMcpDeps["callTool"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const deps = { getStatus: vi.fn(), callTool: dispatch };
    const pending = readForRecovery(
      deps,
      "list_windows",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CANCELLED" },
    });
    finish({ windows: [] });
    expect(
      await readForRecovery(
        deps,
        "list_windows",
        {},
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
