import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface BotCapabilityCallbacks {
  list(params: {
    callerSessionId: string;
    kind: "skill" | "mcp" | "toolset";
    query?: string;
  }): Promise<
    ControlResult<
      {
        capabilities: {
          id: string;
          name: string;
          description: string;
          joined: boolean;
          available: boolean;
        }[];
      },
      string
    >
  >;
  select(params: {
    callerSessionId: string;
    kind: "skill" | "mcp" | "toolset";
    id: string;
    joined: boolean;
  }): Promise<
    ControlResult<{ effective: "next-turn"; joined: boolean }, string>
  >;
}

const FIND_BOT_CAPABILITIES_CORE =
  "按需查找 Cindy 已有的 Skill、MCP 连接或内置工具集，返回可用性和当前伙伴是否已加入。";
const FIND_BOT_CAPABILITIES_PLUGIN_SENTENCE =
  "插件用 cindy 的 ghost_list / ghost_info 发现并直接按现有授权调用。";

/**
 * Local Cindy sessions keep the plugin/`ghost_*` sentence byte-identical.
 * SSH Claude/Codex mount `cindy_helper` but not the `cindy` gateway, so that
 * sentence must be omitted or the model is told to call unreachable tools.
 */
export function buildFindBotCapabilitiesDescription(cindyAvailable = true): string {
  return cindyAvailable
    ? `${FIND_BOT_CAPABILITIES_CORE}${FIND_BOT_CAPABILITIES_PLUGIN_SENTENCE}`
    : FIND_BOT_CAPABILITIES_CORE;
}

export function withCindyGatedBotToolDescriptions<T extends { name: string; description?: string }>(
  tools: readonly T[],
  cindyAvailable: boolean,
): T[] {
  if (cindyAvailable) return [...tools];
  return tools.map((tool) =>
    tool.name === "find_bot_capabilities"
      ? { ...tool, description: buildFindBotCapabilitiesDescription(false) }
      : tool,
  );
}

/** Shared capability discovery keeps schemas out of the companion's initial context. */
export function registerBotCapabilityTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    callbacks: BotCapabilityCallbacks;
    cindyAvailable?: boolean;
  },
): void {
  const kind = z.enum(["skill", "mcp", "toolset"]);
  registry.register({
    name: "find_bot_capabilities",
    category: "bots",
    description: buildFindBotCapabilitiesDescription(deps.cindyAvailable !== false),
    inputShape: { kind, query: z.string().max(200).optional() },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId)
        return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.list({ ...input, callerSessionId });
      return result.ok
        ? okPayload({ capabilities: result.capabilities })
        : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: "set_bot_capability",
    category: "bots",
    description:
      "把查到的已有能力加入当前伙伴，或从当前伙伴移除。复用 Cindy 已有安装和连接，不修改共享源、凭证或全局开关。新挂载在下一轮生效；当前轮不要声称已有尚未挂载的工具。",
    inputShape: { kind, id: z.string().min(1).max(512), joined: z.boolean() },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId)
        return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.select({ ...input, callerSessionId });
      return result.ok
        ? okPayload({ effective: result.effective, joined: result.joined })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
