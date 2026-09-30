import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { isWindowIdentityFailure } from "./recovery.js";
import { createComputerMcpServer } from "./server.js";

const reason =
  "ax_window_unresolved: window_id 5300 exists and is owned by pid 65985, but none of the 0 AXWindow element(s) under that pid reports this CGWindowID.";

describe("driver window identity diagnostics", () => {
  it.each(["code", "degraded_reason"])(
    "recognizes diagnostic reasons in %s",
    (field) => {
      expect(isWindowIdentityFailure({ [field]: reason })).toBe(true);
      expect(isWindowIdentityFailure({ [field]: "ax_window_unresolved" })).toBe(
        true,
      );
      expect(isWindowIdentityFailure({ [field]: "window_id_not_found" })).toBe(
        true,
      );
    },
  );

  it.each([
    null,
    {},
    { degraded_reason: 42 },
    { degraded_reason: "ax_window_unresolved_other" },
    { degraded_reason: "unrelated: ax_window_unresolved" },
    { code: "px_capture_unavailable" },
  ])("does not rediscover unrelated failures: %j", (value) => {
    expect(isWindowIdentityFailure(value)).toBe(false);
  });

  it("rediscovers once for a detailed AX failure without selecting a target or issuing a snapshot", async () => {
    const failure = {
      degraded: true,
      degraded_reason: reason,
      elements: [],
      tree_markdown: "",
      screenshot_frame_valid: false,
      screenshot_error: { code: "px_capture_unavailable" },
    };
    const windows = [{ pid: 65985, window_id: 5304 }];
    const dispatch = vi.fn(async (name: string) => {
      if (name === "get_window_state") return failure;
      if (name === "list_windows") return { windows };
      throw new Error(`Unexpected tool: ${name}`);
    });
    const server = createComputerMcpServer(
      { getStatus: vi.fn(), callTool: dispatch },
      { sessionId: "ax-recovery" },
    );
    const client = new Client({ name: "ax-recovery", version: "1" });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
      const response = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "get_window_state",
          args: { pid: 65985, window_id: 5300, include_screenshot: true },
        },
      });
      const result = JSON.parse(
        (response.content as Array<{ text: string }>)[0]!.text,
      );
      expect(result).toMatchObject({
        ok: false,
        errorCode: "CUA_UNAVAILABLE",
        data: failure,
        recovery: {
          requested_target: { pid: 65985, window_id: 5300 },
          target_selected: false,
          discovery: { tool: "list_windows", ok: true, data: { windows } },
        },
      });
      expect(result).not.toHaveProperty("snapshot_id");
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
        "get_window_state",
        "list_windows",
      ]);
      expect(dispatch).toHaveBeenLastCalledWith(
        "list_windows",
        { session: "ax-recovery" },
        expect.objectContaining({
          sessionId: "ax-recovery",
          observationPurpose: "recovery",
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
