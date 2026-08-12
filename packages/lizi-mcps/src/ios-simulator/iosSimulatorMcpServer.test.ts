import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { IOSSimulatorMcpDeps } from "../types.js";
import { createIOSSimulatorMcpServer } from "./server.js";
import { IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES } from "./tool-names.js";

async function connect(
  deps: IOSSimulatorMcpDeps,
  sessionId?: string,
  workingDir?: string,
) {
  const server = createIOSSimulatorMcpServer(deps, {
    sessionId,
    ...(workingDir
      ? {
          getSessionContext: () => ({
            agentKind: "claude-code",
            workingDir,
            sessionId,
          }),
        }
      : {}),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function readResultText(result: unknown): string {
  if (!result || typeof result !== "object")
    throw new Error("MCP result must be an object");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content))
    throw new Error("MCP result content must be an array");
  const first = content[0];
  const text =
    first && typeof first === "object"
      ? (first as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string") {
    throw new Error("MCP result must contain a text block");
  }
  return text;
}

describe("createIOSSimulatorMcpServer", () => {
  it("reports empty resource collections instead of method-not-found", async () => {
    const { client, server } = await connect({ callTool: vi.fn() }, "session-a");

    await expect(client.listResources()).resolves.toEqual({ resources: [] });
    await expect(client.listResourceTemplates()).resolves.toEqual({
      resourceTemplates: [],
    });

    await Promise.all([client.close(), server.close()]);
  });

  it("lists the progressive discovery and lifecycle tools", async () => {
    const { client, server } = await connect(
      { callTool: vi.fn() },
      "session-a",
    );
    const result = await client.callTool({ name: "list_tools", arguments: {} });
    const payload = JSON.parse(readResultText(result));
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "check_environment",
      "doctor",
      "list_simulator_devices",
      "list_instances",
      "create_instance",
      "attach_device",
      "start_instance",
      "stop_instance",
      "detach_device",
      "get_screen_map",
      "audit_accessibility",
      "compare_screen_maps",
      "wait_for_ui",
      "tap",
      "swipe",
      "drag_on_simulator",
      "long_press",
      "press_simulator_key",
      "batch",
      "touch_path",
      "touch2_path",
      "type_simulator_text",
      "press_home",
      "set_orientation",
      "set_appearance",
      "set_increase_contrast",
      "set_content_size",
      "set_location",
      "start_location_route",
      "clear_location",
      "set_privacy",
      "push_notification",
      "set_status_bar",
      "clear_status_bar",
      "lock_screen",
      "unlock_screen",
      "build_app",
      "read_build_diagnostics",
      "install_app",
      "launch_app",
      "terminate_app",
      "open_simulator_url",
      "take_simulator_screenshot",
      "capture_visual_baseline",
      "visual_diff",
      "capture_state",
      "get_diagnostics",
      "start_recording",
      "stop_recording",
    ]);
    expect(payload.workflow).toContain("embedded viewer workflow");
    expect(payload.workflow).toContain("create_instance or attach_device");
    expect(
      payload.tools.find(
        (tool: { name: string; description: string }) =>
          tool.name === "start_instance",
      )?.description,
    ).toContain("Cindy's viewer");
    await Promise.all([client.close(), server.close()]);
  });

  it("includes Host capability availability in progressive discovery", async () => {
    const describeTools = vi.fn(async () => ({
      ready: true,
      instanceCount: 1,
      runningInstanceCount: 1,
      tools: {
        doctor: { state: "available" as const, backend: "host" as const },
        wait_for_ui: { state: "available" as const, backend: "wda" as const },
        drag_on_simulator: {
          state: "available" as const,
          backend: "native-hid" as const,
        },
      },
    }));
    const { client, server } = await connect(
      { callTool: vi.fn(), describeTools },
      "session-a",
    );

    const result = await client.callTool({ name: "list_tools", arguments: {} });
    const payload = JSON.parse(readResultText(result));

    expect(describeTools).toHaveBeenCalledWith({
      sessionId: "session-a",
      origin: "agent",
    });
    expect(payload.availability).toMatchObject({
      ready: true,
      instanceCount: 1,
      runningInstanceCount: 1,
    });
    expect(
      payload.tools.find(
        (tool: { name: string }) => tool.name === "drag_on_simulator",
      ),
    ).toMatchObject({
      availability: { state: "available", backend: "native-hid" },
    });
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects invalid high-level UI arguments before calling the Host", async () => {
    const callTool = vi.fn();
    const { client, server } = await connect({ callTool }, "session-a");
    const route = {
      instanceId: "instance-a",
      generation: 1,
      leaseId: "lease-a",
      snapshotId: "dbe4ecda-0e96-43d7-8419-d73dc62b5d03",
    };
    const invalidCalls = [
      {
        name: "wait_for_ui",
        args: {
          ...route,
          condition: { kind: "element_exists", selector: {} },
        },
      },
      { name: "tap", args: { ...route, elementId: "element-a", observeAfter: "later" } },
      {
        name: "long_press",
        args: { ...route, elementId: "element-a", durationMs: 299 },
      },
      { name: "press_simulator_key", args: { ...route, key: "space" } },
      {
        name: "batch",
        args: {
          ...route,
          actions: Array.from({ length: 17 }, () => ({ type: "key_press", key: "return" })),
        },
      },
    ];

    for (const invocation of invalidCalls) {
      const result = await client.callTool({
        name: "call_tool",
        arguments: invocation,
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(readResultText(result))).toMatchObject({
        errorCode: "INVALID_ARGS",
      });
    }
    expect(callTool).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("validates mutation routes before calling the host", async () => {
    const callTool = vi.fn();
    const { client, server } = await connect({ callTool }, "session-a");
    const result = await client.callTool({
      name: "call_tool",
      arguments: {
        name: "start_instance",
        args: { instanceId: "instance-a", generation: 0, leaseId: "lease-a" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(readResultText(result))).toMatchObject({
      errorCode: "INVALID_ARGS",
    });
    expect(callTool).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("forwards the authoritative session context to the host", async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { ready: true } }));
    const { client, server } = await connect(
      { callTool },
      "session-a",
      "/projects/enabled-ios",
    );
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "check_environment", args: {} },
    });

    expect(callTool).toHaveBeenCalledWith(
      "check_environment",
      {},
      {
        sessionId: "session-a",
        workingDir: "/projects/enabled-ios",
        origin: "agent",
      },
    );
    expect(JSON.parse(readResultText(result))).toMatchObject({ ok: true });
    await Promise.all([client.close(), server.close()]);
  });

  it("accepts an explicit generic Xcode container for build_app", async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { built: true } }));
    const { client, server } = await connect({ callTool }, "session-a");
    const args = {
      instanceId: "instance-a",
      generation: 1,
      leaseId: "lease-a",
      containerPath: "Examples/App/App.xcworkspace",
      scheme: "App",
    };
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "build_app", args },
    });

    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith("build_app", args, {
      sessionId: "session-a",
      origin: "agent",
    });
    await Promise.all([client.close(), server.close()]);
  });

  it("preserves structured host business errors", async () => {
    const { client, server } = await connect(
      {
        callTool: vi.fn(async () => ({
          ok: false,
          errorCode: "UNSUPPORTED_SESSION_KIND",
          message: "Remote sessions cannot access local simulators.",
        })),
      },
      "remote-session",
    );
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "list_devices", args: {} },
    });
    const payload = JSON.parse(readResultText(result));
    expect(result.isError).toBe(true);
    expect(payload.errorCode).toBe("UNSUPPORTED_SESSION_KIND");
    await Promise.all([client.close(), server.close()]);
  });

  it("scopes every advertised description to the simulator domain", async () => {
    const { client, server } = await connect(
      { callTool: vi.fn() },
      "session-a",
    );
    const result = await client.callTool({ name: "list_tools", arguments: {} });
    const payload = JSON.parse(readResultText(result));

    // The model sees the inner name next to generic host and browser tools, so
    // the domain must be on every description, not only the renamed ones.
    for (const tool of payload.tools as { name: string; description: string }[]) {
      expect(tool.description.startsWith("[iOS Simulator] ")).toBe(true);
    }
    const openUrl = (payload.tools as { name: string; description: string }[]).find(
      (tool) => tool.name === "open_simulator_url",
    );
    expect(openUrl?.description).toContain("browser and fetch tools instead");
    await Promise.all([client.close(), server.close()]);
  });

  it("keeps superseded tool names callable without advertising them", async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: {} }));
    const { client, server } = await connect({ callTool }, "session-a");

    const listed = JSON.parse(
      readResultText(await client.callTool({ name: "list_tools", arguments: {} })),
    );
    const advertised = new Set(
      (listed.tools as { name: string }[]).map((tool) => tool.name),
    );
    for (const deprecated of Object.keys(
      IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES,
    )) {
      expect(advertised.has(deprecated)).toBe(false);
      expect(
        advertised.has(IOS_SIMULATOR_DEPRECATED_TOOL_ALIASES[deprecated]!),
      ).toBe(true);
    }

    // A plugin or saved prompt written against the old name must keep working.
    const route = { instanceId: "instance-a", generation: 1, leaseId: "lease-a" };
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "open_url", args: { ...route, url: "https://example.com" } },
    });

    expect(result.isError).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith(
      "open_url",
      { ...route, url: "https://example.com" },
      { sessionId: "session-a", origin: "agent" },
    );
    await Promise.all([client.close(), server.close()]);
  });

  it("rejects a routeless simulator URL open before reaching the Host", async () => {
    const callTool = vi.fn();
    const { client, server } = await connect({ callTool }, "session-a");

    // This is what a mis-routed "open a web page" call looks like. It must fail
    // on argument validation, which is why Desktop can skip the device
    // authorization prompt for it instead of asking about a device that this
    // task never attached.
    const result = await client.callTool({
      name: "call_tool",
      arguments: {
        name: "open_simulator_url",
        args: { url: "https://example.com" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(readResultText(result))).toMatchObject({
      ok: false,
      errorCode: "INVALID_ARGS",
      data: { tool: "open_simulator_url" },
    });
    expect(callTool).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });
});
