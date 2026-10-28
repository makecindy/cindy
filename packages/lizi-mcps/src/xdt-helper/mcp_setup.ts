import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

type McpSetupToolResult = {
  operationId: string;
  status: string;
  errorCode?: string;
  serverId?: string;
  verification?: string;
  activation?: string;
};
export interface McpSetupCallbacks {
  request(
    context: LiziMcpSessionContext,
    proposal: { name?: string; url?: string; transport?: "http" | "sse" },
  ): Promise<McpSetupToolResult>;
  status(
    context: LiziMcpSessionContext,
    operationId: string,
  ): Promise<McpSetupToolResult | null>;
}
export function registerMcpSetupTools(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: McpSetupCallbacks,
) {
  function context() {
    const ctx = getContext();
    return ctx.sessionId &&
      ctx.sessionInstanceId &&
      !ctx.remoteHostId &&
      ctx.mcpCallerKind !== "descendant"
      ? ctx
      : null;
  }
  registry.register({
    name: "request_mcp_setup",
    category: "auth",
    description:
      "Ask the owner to add a custom HTTP/SSE MCP server on this Cindy Desktop. Opens the same form as Settings. Supply only optional public display name, endpoint and transport. Never ask for, read, accept or pass tokens, authorization headers, URL credentials or secret query parameters through conversation, tools, files or logs. The owner enters credentials directly into a trusted local form; they never return to you. The owner reviews the final target before verifying and saving. Returns pending metadata with operationId. End your turn and wait for [MCP setup ended]; do not poll, use browser/DOM inspection, generic cindy-ui input, or edit config files to bypass the form. Saved servers apply to the next Agent session; the current running Agent session capability set stays fixed. One pending setup per task.",
    inputShape: {
      name: z.string().trim().min(1).max(60).optional(),
      url: z.string().trim().max(2048).optional(),
      transport: z.enum(["http", "sse"]).optional(),
    },
    handler: async (proposal) => {
      const ctx = context();
      if (!ctx)
        return errorPayload(
          "CAPABILITY_NOT_AVAILABLE",
          "A local parent Cindy task is required.",
        );
      try {
        return okPayload({ ...(await callbacks.request(ctx, proposal)) });
      } catch {
        return errorPayload(
          "MCP_SETUP_UNAVAILABLE",
          "Could not open setup. Use a public HTTPS or loopback HTTP endpoint without credentials or query parameters.",
        );
      }
    },
  });
  registry.register({
    name: "get_mcp_setup_status",
    category: "auth",
    description:
      "Recover the credential-free result of a previous request_mcp_setup in this task after reconnect/restart. Do not repeatedly poll pending operations. Returns only status, fixed error code and server id, never the endpoint or credentials.",
    inputShape: { operation_id: z.string().uuid() },
    handler: async ({ operation_id }) => {
      const ctx = context();
      if (!ctx)
        return errorPayload(
          "CAPABILITY_NOT_AVAILABLE",
          "A local parent Cindy task is required.",
        );
      try {
        const result = await callbacks.status(ctx, operation_id);
        return result
          ? okPayload({ ...result })
          : errorPayload(
              "REQUEST_EXPIRED",
              "Setup expired. Request a new card.",
            );
      } catch {
        return errorPayload(
          "MCP_SETUP_UNAVAILABLE",
          "Could not recover the setup status.",
        );
      }
    },
  });
}
