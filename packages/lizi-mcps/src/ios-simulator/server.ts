import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  IOSSimulatorMcpCallContext,
  IOSSimulatorMcpDeps,
  LiziMcpSessionContext,
} from "../types.js";
import { jsonObjectArg } from "../json-object-arg.js";
import { IOSSimulatorToolRegistry } from "./tool-registry.js";
import { registerIOSSimulatorTools } from "./tools.js";

export interface IOSSimulatorMcpServerOptions {
  sessionId?: string;
  getSessionContext?: () => LiziMcpSessionContext;
}

function readContext(
  options: IOSSimulatorMcpServerOptions,
): IOSSimulatorMcpCallContext | undefined {
  const sessionContext = options.getSessionContext?.();
  const sessionId = sessionContext?.sessionId ?? options.sessionId;
  return sessionId
    ? {
        sessionId,
        ...(sessionContext?.workingDir
          ? { workingDir: sessionContext.workingDir }
          : {}),
        origin: "agent",
      }
    : undefined;
}

export function createIOSSimulatorMcpServer(
  deps: IOSSimulatorMcpDeps,
  options: IOSSimulatorMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "cindy_ios_simulator",
    version: "0.1.0",
  });
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] }),
  );
  const registry = new IOSSimulatorToolRegistry();
  registerIOSSimulatorTools(registry, deps, () => readContext(options));

  server.tool(
    "list_tools",
    "Discover Cindy's embedded iOS Simulator tools. Use this entry point when the embedded route is selected for opening, running, testing, or debugging an iOS app in Cindy. Everything behind it acts on a simulated Apple device: never use it to browse the web, fetch HTTP data, or automate this Mac — use the browser, fetch, or computer tools for those. Start with check_environment before selecting a device.",
    { category: z.enum(["ios_simulator"]).optional() },
    async () => {
      const availability = await deps.describeTools?.(readContext(options));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              category: "ios_simulator",
              tools: registry.list(availability?.tools),
              ...(availability ? { availability } : {}),
              workflow:
                "Use this embedded viewer workflow: check_environment, then list_simulator_devices and either create_instance or attach_device, then start_instance. Build, install, and launch the app through this server. Route mutations with instanceId, generation, and leaseId.",
            }),
          },
        ],
      };
    },
  );
  server.tool(
    "call_tool",
    "Invoke a validated iOS Simulator tool for the current Cindy session. Every tool here targets a simulated Apple device, so do not route web browsing, HTTP fetching, or host automation through it.",
    {
      name: z.string(),
      args: jsonObjectArg("Arguments object for the selected tool"),
    },
    async ({ name, args }) => registry.call(name, args),
  );
  return server;
}
