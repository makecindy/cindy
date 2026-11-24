import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export const teammateProfilePatch = z.strictObject({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(12000).optional(),
  avatar: z.string().min(1).max(256).optional(),
  avatarFile: z.enum(['avatar.png', 'avatar.jpg', 'avatar.webp']).optional().describe('Image in your own .cindy/settings folder. Apply separately with expectedAvatar and expectedVersion.'),
  expectedAvatar: z.string().max(256).optional(),
  userContextSource: z.string().max(12000).optional(),
  identitySource: z.string().max(12000).optional(),
  modelChain: z.array(z.strictObject({
    id: z.string().min(1).max(2048).describe('Enabled route id from get_app_default_model.'),
    effort: z.string().max(64).optional(),
    fastMode: z.union([z.boolean(), z.literal('ultrafast')]).optional(),
  })).min(1).max(5).nullable().optional().describe('Complete model chain for this buddy; null removes its override and follows the application default.'),
});

const speechRoute = z.strictObject({
  modelId: z.string().min(1).max(256),
  providerId: z.string().max(256).optional(),
  agent: z.enum(['claude-code', 'codex', 'pi']).optional(),
  protocol: z.enum(['openai', 'elevenlabs', 'minimax', 'qwen-tts', 'dashscope-tts']).optional(),
});
const voiceRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('voices'), route: speechRoute }),
  z.strictObject({ action: z.literal('apply'), revision: z.string().length(64),
    selection: speechRoute.extend({ voice: z.string().min(1).max(256), speed: z.number().positive().optional() }).nullable().optional(),
    sentencePlayback: z.boolean().nullable().optional() }),
]);
export type TeammateVoiceRequest = z.infer<typeof voiceRequest>;
export const groupRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect'), group: z.string().trim().min(1).max(512) }),
  z.strictObject({ action: z.literal('apply'), group: z.string().trim().min(1).max(512),
    connectionRef: z.string().regex(/^[a-f0-9]{12}$/), revision: z.string().max(100),
    replyMode: z.enum(['always', 'mention']) }),
]);
export type TeammateGroupRequest = z.infer<typeof groupRequest>;
export interface TeammateGroupBinding {
  connectionRef: string;
  group: string;
  name: string;
  assignedToSelf: boolean;
  revision: string;
  replyMode: 'always' | 'mention';
}
export interface BotCapabilityCallbacks {
  removePersonalSkill?(input: { callerSessionId: string; slug: string }): Promise<ControlResult<{ changed: boolean }, string>>;
  restoreStandard?(input: { callerSessionId: string }): Promise<ControlResult<{ changed: boolean }, string>>;
  voice?(input: { callerSessionId: string; request: TeammateVoiceRequest }): Promise<ControlResult<{ result: unknown }, string>>;
  iMessageGroup?(input: { callerSessionId: string; request: TeammateGroupRequest | { action: "applyFromProject"; revision: string } }): Promise<
    ControlResult<{ groups: TeammateGroupBinding[] }, string>>;
  models?(params: { callerSessionId: string }): Promise<ControlResult<{
    current: AppDefaultModelRoute | null;
    available: { id: string; route: AppDefaultModelRoute; efforts: string[]; supportsFastMode?: boolean; supportsUltrafastMode?: boolean;
      /** A plugin engine on this computer: valid only in the teammate's own model chain, never as the application default. */
      teammateOnly?: true; engine?: string; displayName?: string }[];
  }, string>>;
  setDefaultModel?(params: { callerSessionId: string; id: string; effort?: string; fastMode?: boolean | 'ultrafast' }): Promise<ControlResult<{
    current: AppDefaultModelRoute;
  }, string>>;
  /** Host resolves the caller; tools never accept another Bot's id or raw config. */
  inspect?(params: { callerSessionId: string }): Promise<ControlResult<{ state: BotControlState }, string>>;
  updateProfile?(params: z.infer<typeof teammateProfilePatch> & {
    callerSessionId: string;
    fromProject?: true;
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
 * `feature` covers this teammate's own `memory` switch. The others reference shared installations.
 */
export type TeammateCapabilityKind = "skill" | "mcp" | "toolset" | "feature";

export interface AppDefaultModelRoute {
  /** `acp` only on teammateOnly choices (this computer's plugin engines). */
  harness: 'claude' | 'codex' | 'pi' | 'acp'; providerId: string | null;
  model: string; effort: string; fastMode: boolean | 'ultrafast';
}

export interface BotControlState {
  settings?: { directory: string | null; device: string; permissionMode: string | null; permissionAuthority: 'host' };
  conversations?: {
    scope: 'local';
    teammateId: string;
    connections: { channel: string; connectionId?: string; status: string; group?: string; replyMode?: string }[];
    connectionsAvailable: boolean;
    guidance: string;
  };
  profile: { id: string; name: string; description: string; identitySource: string; version: number; avatar?: string; userContextSource?: string };
  session: { id: string; workingDir: string | null; remoteHostId: string | null };
  model: { source: "override" | "default"; candidates: { harness: string; providerId?: string | null; model: string }[] };
  memory: { enabled: boolean; scope: "self" };
  references: { skills: string[]; mcpServers: string[]; toolsets: string[] };
}

/** Shared by the core prompt's self-knowledge and the profile tools' descriptions; details live in read_teammate_skill. */
export const TEAMMATE_CONTROL_GUIDANCE = [
  'Use `get_teammate_state` to inspect your profile, stable chat, configured model candidates, memory switch and capability references. Candidates and references are not proof of the model or tools running this turn; the live runtime and registered tools are authoritative. Empty references do not mean you have no Skills: the shared core and your personal shelf are separate.',
  'Use `update_teammate_profile` when the user asks to change your name, introduction, identity or your own model selection. Read the current version first and patch only the requested fields; for modelChain read `get_app_default_model` first and supply the complete ordered chain (1–5 routes), or null to follow the application default. Saves apply next turn and never change the application default, other buddies, Skills, memory or chat history. Details: `read_teammate_skill` name=models.',
].join('\n');

/** @deprecated Internal compatibility export; new teammate guidance uses the product name. */
export const BOT_CONTROL_GUIDANCE = TEAMMATE_CONTROL_GUIDANCE;

const FIND_BOT_CAPABILITIES_CORE =
  "按需查找应用已有的 Skill、MCP 连接或内置工具集，返回可用性和当前伙伴是否已加入；kind=feature 列出自己的记忆开关。";
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
  registerAppDefaultModelTools(registry, deps);
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
  if (deps.callbacks.removePersonalSkill) registry.register({
    name: 'remove_teammate_personal_skill',
    category: 'bots',
    description: 'Remove one active personal project skill requested by the owner. Inspect its ownership with list_teammate_skills first, then reread the list.',
    inputShape: { slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) },
    handler: async ({ slug }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.removePersonalSkill!({ callerSessionId, slug });
      return result.ok ? okPayload({ changed: result.changed }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.restoreStandard) registry.register({
    name: 'restore_teammate_standard_skills',
    category: 'bots',
    description: 'Repair missing standard project skills. Keep personal files, own rules and explicit disables. Read the project skill shelf afterwards.',
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.restoreStandard!({ callerSessionId });
      return result.ok ? okPayload({ changed: result.changed }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.voice) registry.register({
    name: 'configure_teammate_voice',
    category: 'bots',
    description: 'Read your voice preference, source and available speech models, list voices for a model, or apply your selection and sentence playback with the observed revision.',
    inputShape: { request: voiceRequest },
    handler: async ({ request }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.voice!({ callerSessionId, request });
      return result.ok ? okPayload({ result: result.result }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.iMessageGroup) registry.register({
    name: 'configure_teammate_imessage_group',
    category: 'bots',
    description: 'Inspect a named local authorized iMessage group in your owner conversation. To receive that group, apply its exact GUID, connection reference, revision and reply mode. The host verifies the server and callback before switching. Other chats keep their routes.',
    inputShape: { request: z.union([groupRequest, z.strictObject({ action: z.literal('applyFromProject'), revision: z.string().min(1).max(100) })]) },
    handler: async ({ request }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务');
      const result = await deps.callbacks.iMessageGroup!({ callerSessionId, request });
      return result.ok ? okPayload({ groups: result.groups }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.updateProfile) registry.register({
    name: "update_teammate_profile",
    category: "bots",
    description: TEAMMATE_CONTROL_GUIDANCE,
    inputShape: {
      ...teammateProfilePatch.shape,
      fromProject: z.literal(true).optional().describe('Apply .cindy/settings/profile.json in your own project at this expectedVersion. Use alone with expectedVersion.'),
    },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      if ((input.fromProject && Object.keys(input).length !== 2) || Object.keys(input).length < 2)
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
      "把查到的已有能力加入当前伙伴，或从当前伙伴移除。复用应用已有安装和连接，不修改共享源、凭证或全局开关。kind=feature 开关自己的记忆（memory），只在主人要求时使用。新挂载在下一轮生效；当前轮不要声称已有尚未挂载的工具。",
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

/** The same default-model contract is available to ordinary tasks and teammates. */
export function registerAppDefaultModelTools(
  registry: XdtHelperToolRegistry,
  deps: { getSessionContext: () => LiziMcpSessionContext;
    callbacks: Pick<BotCapabilityCallbacks, 'models' | 'setDefaultModel'>;
    category?: 'settings' | 'bots'; },
): void {
  if (deps.callbacks.models) registry.register({
    name: 'get_app_default_model', category: deps.category ?? 'bots',
    description: '读取当前用户在应用中选择的默认模型，以及已连接、已启用且引擎可用的型号。修改默认模型前先读此表；查询不会更改设置。available 中的 id 同时绑定型号、来源账号与引擎；不要猜型号或启用用户关闭的型号。伙伴显式配置的模型链可能与此默认值不同。伙伴调用时还会列出这台电脑的插件引擎（teammateOnly: true），只能用于伙伴自己的 modelChain，不能设为应用默认。',
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用未绑定任务');
      const result = await deps.callbacks.models!({ callerSessionId });
      return result.ok ? okPayload({ current: result.current, available: result.available }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.setDefaultModel) registry.register({
    name: 'set_app_default_model', category: deps.category ?? 'bots',
    description: '用户明确要求更换应用默认模型时，使用 get_app_default_model 返回的可用型号 id 保存并读回确认。作用于以后新建任务及跟随应用默认的伙伴；不覆盖已有任务、伙伴单独配置的模型或全局伙伴模型链。仅换当前伙伴时不要改这个全局默认值。失败后重新查询，不得声称已修改。',
    inputShape: { id: z.string().min(1).max(2048), effort: z.string().max(64).optional(),
      fastMode: z.union([z.boolean(), z.literal('ultrafast')]).optional().describe('只有所选型号声明支持时可开启；省略保留该型号偏好。') },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用未绑定任务');
      const result = await deps.callbacks.setDefaultModel!({ ...input, callerSessionId });
      return result.ok ? okPayload({ current: result.current, effective: 'new-tasks-and-following-bots', overridesPreserved: true }) : errorPayload(result.errorCode, result.message);
    },
  });
}
