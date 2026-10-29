import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";
import type { TeammateMediaModels, TeammateMediaCatalog } from '@cindy/maker-shared/teammate-media-models';

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
    modelChain?: { id: string; effort?: string; fastMode?: boolean | 'ultrafast' }[] | null;
    mediaModels?: TeammateMediaModels | null;
  }): Promise<ControlResult<{ effective: "next-turn" }, string>>;
  list(params: {
    callerSessionId: string;
    kind: TeammateCapabilityKind;
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
    kind: TeammateCapabilityKind;
    id: string;
    joined: boolean;
  }): Promise<
    ControlResult<{ effective: "next-turn"; joined: boolean }, string>
  >;
}

/**
 * `feature` covers this teammate's own switches: `memory` and the system Skills
 * (`todo`, `routine`, `follow`). The others reference shared installations.
 */
export type TeammateCapabilityKind = "skill" | "mcp" | "toolset" | "feature";

export interface AppDefaultModelRoute {
  harness: 'claude' | 'codex' | 'pi'; providerId: string | null;
  model: string; effort: string; fastMode: boolean | 'ultrafast';
}

export interface BotControlState {
  mediaModels?: { overrides: TeammateMediaModels | null; available?: TeammateMediaCatalog };
  conversations?: {
    scope: 'local';
    teammateId: string;
    connections: { channel: string; connectionId?: string; status: string }[];
    connectionsAvailable: boolean;
    guidance: string;
  };
  profile: { id: string; name: string; description: string; identitySource: string; version: number };
  session: { id: string; workingDir: string | null; remoteHostId: string | null };
  model: { source: "override" | "default"; candidates: { harness: string; providerId?: string | null; model: string }[] };
  memory: { enabled: boolean; scope: "self" };
  /** System Skills this teammate turned off; the rest are on. */
  systemSkillsOff?: string[];
  references: { skills: string[]; mcpServers: string[]; toolsets: string[] };
}

/** Same instructions in the runtime baseline and tool descriptions. */
const MEDIA_MODEL_GUIDANCE = 'For this teammate’s Vision Bridge, image or video generation model settings, read get_teammate_state.mediaModels. update_teammate_profile accepts mediaModels with vision:{primary:{providerId,modelId},fallback:{providerId,modelId}|null}, image:{providerId,modelId}, video:{providerId,modelId}. Use exact available references; preserve unrequested overrides. null removes the whole override; omit/null a category to inherit app settings. Vision does not change the app enable switch or target models; Pi native tools apply changes on restart. Generation choices apply to Cindy media execution, not independent services with their own model settings.';


/** Shared by the core prompt's self-knowledge and the profile tools' descriptions; details live in read_teammate_skill. */
export const TEAMMATE_CONTROL_GUIDANCE = [
  'Use `get_teammate_state` to inspect your profile, stable chat, configured model candidates, memory switch, turned-off system Skills and capability references. Candidates and references are not proof of the model or tools running this turn; the live runtime and registered tools are authoritative. Empty references do not mean you have no Skills: the shared core and your personal shelf are separate.',
  'Use `update_teammate_profile` when the user asks to change your name, introduction, identity or your own model selection. Read the current version first and patch only the requested fields; for modelChain read `get_app_default_model` first and supply the complete ordered chain (1–5 routes), or null to follow the application default. Saves apply next turn and never change the application default, other teammates, Skills, memory or chat history. Details: `read_teammate_skill` name=models.',
].join('\n');

/** @deprecated Internal compatibility export; new teammate guidance uses the product name. */
export const BOT_CONTROL_GUIDANCE = TEAMMATE_CONTROL_GUIDANCE;

const FIND_BOT_CAPABILITIES_CORE =
  "按需查找应用已有的 Skill、MCP 连接或内置工具集，返回可用性和当前伙伴是否已加入；kind=feature 列出自己的记忆与系统技能开关。";
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
    description: '读取当前用户在应用中选择的默认模型，以及已连接、已启用且引擎可用的型号。修改默认模型或为 start_session_task 单独选模前先读此表；查询不会更改设置。将 available 中的 id 用于 model_selection，它同时绑定型号、来源账号与引擎；不要猜型号或启用用户关闭的型号。伙伴显式配置的模型链可能与此默认值不同。',
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
    description: TEAMMATE_CONTROL_GUIDANCE + '\n主人私聊中还返回本机消息平台连接与跨渠道历史检索指引。按话题接续时使用 profile.id 作为 history 工具的 teammate_id，不需要主人先点名渠道；连接不证明旧记录归属。',
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
    description: TEAMMATE_CONTROL_GUIDANCE + '\n' + MEDIA_MODEL_GUIDANCE,
    inputShape: {
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(12000).optional(),
      identitySource: z.string().max(12000).optional(),
      mediaModels: z.strictObject({
        vision: z.strictObject({
          primary: z.strictObject({ providerId: z.string().trim().min(1).max(512), modelId: z.string().trim().min(1).max(2048) }),
          fallback: z.strictObject({ providerId: z.string().trim().min(1).max(512), modelId: z.string().trim().min(1).max(2048) }).nullable(),
        }).nullable().optional(),
        image: z.strictObject({ providerId: z.string().trim().min(1).max(512), modelId: z.string().trim().min(1).max(2048) }).nullable().optional(),
        video: z.strictObject({ providerId: z.string().trim().min(1).max(512), modelId: z.string().trim().min(1).max(2048) }).nullable().optional(),
      }).nullable().optional().describe('Complete media overrides for this teammate. Omitted/null categories inherit app settings. null resets all media overrides.'),
      modelChain: z.array(z.strictObject({
        id: z.string().min(1).max(2048).describe('Enabled route id from get_app_default_model.'),
        effort: z.string().max(64).optional(),
        fastMode: z.union([z.boolean(), z.literal('ultrafast')]).optional(),
      })).min(1).max(5).nullable().optional().describe('Complete model chain for this teammate; null removes its override and follows the application default.'),
    },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      if (input.name === undefined && input.description === undefined && input.identitySource === undefined && input.modelChain === undefined && input.mediaModels === undefined)
        return errorPayload("INVALID_PARAMS", "请选择要修改的资料");
      const result = await deps.callbacks.updateProfile!({ ...input, callerSessionId });
      return result.ok ? okPayload({ effective: result.effective }) : errorPayload(result.errorCode, result.message);
    },
  });
  const kind = z.enum(["skill", "mcp", "toolset", "feature"]);
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
      "把查到的已有能力加入当前伙伴，或从当前伙伴移除。复用应用已有安装和连接，不修改共享源、凭证或全局开关。kind=feature 开关自己的记忆（memory）与系统技能（todo、routine、follow），只在主人要求时使用。新挂载在下一轮生效；当前轮不要声称已有尚未挂载的工具。",
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
