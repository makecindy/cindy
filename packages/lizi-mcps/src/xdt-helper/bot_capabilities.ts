import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface BotCapabilityCallbacks {
  models?(params: { callerSessionId: string }): Promise<ControlResult<{
    current: AppDefaultModelRoute | null;
    available: { id: string; route: AppDefaultModelRoute; efforts: string[]; supportsFastMode?: boolean }[];
  }, string>>;
  setDefaultModel?(params: { callerSessionId: string; id: string; effort?: string }): Promise<ControlResult<{
    current: AppDefaultModelRoute;
  }, string>>;
  /** Host resolves the caller; tools never accept another Bot's id or raw config. */
  inspect?(params: { callerSessionId: string }): Promise<ControlResult<{ state: BotControlState }, string>>;
  updateProfile?(params: {
    callerSessionId: string;
    expectedVersion: number;
    name?: string;
    description?: string;
    identitySource?: string;
    modelChain?: { id: string; effort?: string; fastMode?: boolean }[] | null;
  }): Promise<ControlResult<{ effective: "next-turn" }, string>>;
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

export interface AppDefaultModelRoute {
  harness: 'claude' | 'codex' | 'pi'; providerId: string | null;
  model: string; effort: string; fastMode: boolean;
}

export interface BotControlState {
  profile: { id: string; name: string; description: string; identitySource: string; version: number };
  session: { id: string; workingDir: string | null; remoteHostId: string | null };
  model: { source: "override" | "default"; candidates: { harness: string; providerId?: string | null; model: string }[] };
  memory: { enabled: boolean; scope: "self" };
  references: { skills: string[]; mcpServers: string[]; toolsets: string[] };
}

/** Same instructions in the runtime baseline and tool descriptions. */
export const TEAMMATE_CONTROL_GUIDANCE = [
  'Use `get_teammate_state` to inspect your current profile, stable chat, configured model candidates, memory switch and capability references. Candidates and selected references are not proof of the model or tools running this turn; the live runtime and registered tools are authoritative.',
  'The references arrays contain optional external grants, not the shared teammate guide or your personal Skill shelf. Empty references do not mean you have no Skills. Report the preloaded shared guide separately; personal Skill storage and learning depend on the current runtime mounting your own shelf, as described in the teammate guide.',
  'Use `update_teammate_profile` when the user asks to change your name, introduction, identity or your own model selection. Read the current version first and patch only the requested fields. For modelChain, first read `get_app_default_model` for enabled route ids and supported effort/Fast settings; supply the complete ordered chain (1–5 routes), preserving existing candidates unless the user asks to replace them. Set modelChain to null to remove your override and follow the application default again. This saves only your profile through the same settings service, persists across restarts, and applies next turn; it never changes the application default, other teammates, personal Skills, memory or chat history. A next-turn save is not proof of the model running this turn.',
  'For project work, set working_dir to the actual project and use_worktree=true for isolation before starting. check_session_task returns the registered directory. Shell cd/worktree creation does not relocate a Session. timeout_ms defaults to 30 minutes and supports up to 24 hours at creation; terminal follow-up inherits the original budget. Do not claim an existing deadline was extended without a verified host response.',
  'message_session_task returns queued_message_id for queued or steered input. check_session_task exposes only your own queue; optionally query queued_message_id for queued/consuming/dispatched/not-found/unavailable; queue restore errors preserve task results and cannot prove a message is missing. Dispatched means accepted into host history, not proof of model action. Use mode=edit with message or mode=withdraw for your own unconsumed item; consuming input cannot be edited or withdrawn.',
  'Control your own background tasks with `message_session_task` (mode=queue by default, mode=steer for same-turn input, mode=resume for a reversible pause) and `stop_session_task` (mode=cancel by default, request-stop for a graceful stop request, pause to hold execution and queued input). General control tools are not part of the teammate toolset. A successful queue receipt is not a steer, and pausing/requested/unconfirmed is not proof the engine stopped. Check the returned control state; unsupported engines fail explicitly. Pause preserves the same task and Session, holds timers and automatic input, and resumes without replaying completed work. If paused, resume without a message before answering a pending interaction. Only tasks owned by your teammate are controllable.',
  'Use `get_capabilities` for application features and UI guidance. It describes the product, not a permission grant or proof that every feature is available here. Use the matching live tool to act, and verify its result before claiming success.',
].join('\n');

/** @deprecated Internal compatibility export; new teammate guidance uses the product name. */
export const BOT_CONTROL_GUIDANCE = TEAMMATE_CONTROL_GUIDANCE;

const FIND_BOT_CAPABILITIES_CORE =
  "按需查找应用已有的 Skill、MCP 连接或内置工具集，返回可用性和当前伙伴是否已加入。";
const FIND_BOT_CAPABILITIES_PLUGIN_SENTENCE =
  "插件用已安装插件网关的 ghost_list / ghost_info 发现并直接按现有授权调用。";

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
    tool.name === "find_teammate_capabilities"
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
  if (deps.callbacks.models) registry.register({
    name: 'get_app_default_model', category: 'bots',
    description: '读取当前用户在应用中选择的默认模型，以及已连接、已启用且引擎可用的型号。修改默认模型前先读此表；不要猜型号或启用用户关闭的型号。伙伴显式配置的模型链可能与此默认值不同。',
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.models!({ callerSessionId });
      return result.ok ? okPayload({ current: result.current, available: result.available }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.setDefaultModel) registry.register({
    name: 'set_app_default_model', category: 'bots',
    description: '用户明确要求更换应用默认模型时，使用 get_app_default_model 返回的可用型号 id 保存并读回确认。作用于以后新建任务及跟随应用默认的伙伴；不覆盖已有任务、伙伴单独配置的模型或全局伙伴模型链。仅换当前伙伴时不要改这个全局默认值。失败后重新查询，不得声称已修改。',
    inputShape: { id: z.string().min(1).max(2048), effort: z.string().max(64).optional() },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.setDefaultModel!({ ...input, callerSessionId });
      return result.ok ? okPayload({ current: result.current, effective: 'new-tasks-and-following-bots', overridesPreserved: true }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.inspect) registry.register({
    name: "get_teammate_state",
    category: "bots",
    description: TEAMMATE_CONTROL_GUIDANCE,
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.inspect!({ callerSessionId });
      return result.ok ? okPayload({ state: result.state }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.updateProfile) registry.register({
    name: "update_teammate_profile",
    category: "bots",
    description: TEAMMATE_CONTROL_GUIDANCE,
    inputShape: {
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(12000).optional(),
      identitySource: z.string().max(12000).optional(),
      modelChain: z.array(z.strictObject({
        id: z.string().min(1).max(2048).describe('Enabled route id from get_app_default_model.'),
        effort: z.string().max(64).optional(),
        fastMode: z.boolean().optional(),
      })).min(1).max(5).nullable().optional().describe('Complete model chain for this teammate; null removes its override and follows the application default.'),
    },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      if (input.name === undefined && input.description === undefined && input.identitySource === undefined && input.modelChain === undefined)
        return errorPayload("INVALID_PARAMS", "请选择要修改的资料");
      const result = await deps.callbacks.updateProfile!({ ...input, callerSessionId });
      return result.ok ? okPayload({ effective: result.effective }) : errorPayload(result.errorCode, result.message);
    },
  });
  const kind = z.enum(["skill", "mcp", "toolset"]);
  registry.register({
    name: "find_teammate_capabilities",
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
    name: "set_teammate_capability",
    category: "bots",
    description:
      "把查到的已有能力加入当前伙伴，或从当前伙伴移除。复用应用已有安装和连接，不修改共享源、凭证或全局开关。新挂载在下一轮生效；当前轮不要声称已有尚未挂载的工具。",
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
  for (const [legacy, name] of [
    ['get_bot_state', 'get_teammate_state'],
    ['update_bot_profile', 'update_teammate_profile'],
    ['find_bot_capabilities', 'find_teammate_capabilities'],
    ['set_bot_capability', 'set_teammate_capability'],
  ]) if (registry.has(name)) registry.registerAlias(legacy, name);
}
