import type {
  CodexHostDynamicToolProvider,
  DynamicToolCallResponse,
} from '@cindy/maker-core';
import {
  IOSSimulatorToolRegistry,
  registerIOSSimulatorTools,
  type IOSSimulatorMcpDeps,
} from '@cindy/mcps';

const NAMESPACE = 'cindy_ios_simulator';
const FLAT_TOOL_SEPARATOR = '__';
const LIST_TOOLS_NAME = `${NAMESPACE}${FLAT_TOOL_SEPARATOR}list_tools`;
const CALL_TOOL_NAME = `${NAMESPACE}${FLAT_TOOL_SEPARATOR}call_tool`;

const TOOLS = [
  {
    type: 'function',
    name: LIST_TOOLS_NAME,
    description:
      "Discover Cindy's embedded iOS Simulator tools. Use this deterministic Host gateway when the embedded route is selected for iOS app work. Every tool behind it acts on a simulated Apple device: never use it to browse the web, fetch HTTP data, or automate this Mac. Start with check_environment.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: ['ios_simulator'] },
      },
    },
    deferLoading: false,
  },
  {
    type: 'function',
    name: CALL_TOOL_NAME,
    description:
      "Invoke a validated embedded iOS Simulator tool for the current Cindy session. Call list_tools first, then pass the selected inner tool name and arguments. Every tool here targets a simulated Apple device, so do not route web browsing, HTTP fetching, or host automation through it.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'args'],
      properties: {
        name: { type: 'string', minLength: 1 },
        args: { type: 'object', additionalProperties: true },
      },
    },
    deferLoading: false,
  },
] as const;

function innerToolName(
  params: Parameters<CodexHostDynamicToolProvider['callTool']>[0],
): 'list_tools' | 'call_tool' | undefined {
  if (params.namespace === null) {
    if (params.tool === LIST_TOOLS_NAME) return 'list_tools';
    if (params.tool === CALL_TOOL_NAME) return 'call_tool';
    return undefined;
  }
  if (params.namespace !== NAMESPACE) return undefined;
  if (params.tool === 'list_tools' || params.tool === 'call_tool') {
    return params.tool;
  }
  return undefined;
}

function textResponse(
  value: unknown,
  success = true,
): DynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    success,
  };
}

/**
 * Exposes the existing validated simulator registry as eager Codex dynamic
 * tools while preserving Desktop's project enablement and session ownership.
 */
export function createIOSSimulatorCodexDynamicToolProvider(options: {
  deps: IOSSimulatorMcpDeps;
}): CodexHostDynamicToolProvider {
  return {
    listTools: () => (process.platform === 'darwin' ? TOOLS : []),
    callTool: async (params, context) => {
      const toolName = innerToolName(params);
      if (!toolName) return undefined;
      if (process.platform !== 'darwin') {
        return textResponse(
          {
            ok: false,
            errorCode: 'IOS_SIMULATOR_DISABLED',
            data: { message: 'The embedded iOS Simulator is available only on macOS.' },
          },
          false,
        );
      }
      if (!context.sessionId) {
        return textResponse(
          {
            ok: false,
            errorCode: 'IOS_SIMULATOR_HOST_ERROR',
            data: { message: 'The current Cindy session is unavailable.' },
          },
          false,
        );
      }

      const registry = new IOSSimulatorToolRegistry();
      registerIOSSimulatorTools(registry, options.deps, () => ({
        sessionId: context.sessionId!,
        workingDir: context.workingDir,
        origin: 'agent',
      }));

      if (toolName === 'list_tools') {
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        const invalidKeys = Object.keys(args).filter((key) => key !== 'category');
        if (
          invalidKeys.length > 0 ||
          (args.category !== undefined && args.category !== 'ios_simulator')
        ) {
          return textResponse(
            {
              ok: false,
              errorCode: 'INVALID_ARGS',
              data: { tool: 'list_tools' },
            },
            false,
          );
        }
        const availability = await options.deps.describeTools?.({
          sessionId: context.sessionId,
          workingDir: context.workingDir,
          origin: 'agent',
        });
        return textResponse({
          ok: true,
          category: 'ios_simulator',
          tools: registry.list(availability?.tools),
          ...(availability ? { availability } : {}),
          workflow:
            'Use this embedded viewer workflow: check_environment, then list_simulator_devices and either create_instance or attach_device, then start_instance. Build, install, and launch the app through this gateway. Route mutations with instanceId, generation, and leaseId.',
        });
      }

      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : null;
      if (
        !args ||
        Object.keys(args).some((key) => key !== 'name' && key !== 'args') ||
        typeof args.name !== 'string' ||
        !args.args ||
        typeof args.args !== 'object' ||
        Array.isArray(args.args)
      ) {
        return textResponse(
          {
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: { tool: 'call_tool' },
          },
          false,
        );
      }

      const result = await registry.call(args.name, args.args);
      return {
        contentItems: result.content.map((block) => ({
          type: 'inputText' as const,
          text: block.text,
        })),
        success: result.isError !== true,
      };
    },
  };
}
