import { useSyncExternalStore } from 'react';
import { effectiveSourceIdForModel, getModel } from '@cindy/model-providers';
import { getDraft, getPersistedVendorModel } from '@/state/newMakerDraft';
import { getDefaultModelForVendor } from '@/lib/modelDefinitions';
import { pickFirstConnectedModelForAgent } from '@/lib/draftModelCalibration';
import { refreshLocalCatalogSnapshot } from '@/lib/localCatalogSnapshot';
import { getCachedProvidersSnapshot } from '@/lib/providersSnapshotStore';
import {
  NEW_BOT_DEFAULT_HARNESS,
  NEW_BOT_DEFAULT_PI_EFFORT,
  NEW_BOT_DEFAULT_PI_MODEL,
  NEW_BOT_DEFAULT_PI_PROVIDER,
} from '../../../shared/botDefaults';
import {
  getBotLastReadAtMap,
  pruneBotReadState,
  seedMissingBotReadState,
} from './botReadState';
import type { BotGender } from '../../../shared/botGender';
import type { BotHealthReport } from '../../../shared/botLifecycle';
import {
  BOT_FAILURE_REASONS,
  type BotFailureReason,
} from '../../../shared/botFailureReason';
import {
  NEW_BOT_DEFAULT_PERMISSIONS,
  normalizeBotPermissions,
} from './botCapabilityDefaults';
import {
  BOT_MODEL_CHAIN_MAX,
  normalizeBotHarness,
  normalizeBotModelChain,
  type BotHarness,
  type BotModelRoute,
} from '../../../shared/botModelChain';

export type BotChannel =
  'telegram' | 'feishu' | 'slack' | 'discord' | 'wechat' | 'dingtalk' | 'wecom' | 'x' | 'local';

export interface BotCapabilities {
  model: string;
  /** Only present when the user explicitly chose a model for this Bot. */
  modelOverride?: BotModelOverride | null;
  providerId?: string | null;
  effort: string;
  fastMode: boolean;
  harness: 'claude' | 'codex' | 'pi';
  /** Ordered, complete runtime routes. The first route is the normal choice. */
  modelChain: BotModelRoute[];
  /** null follows the global Bot default; an array is this Bot's explicit chain. */
  modelChainOverride?: BotModelRoute[] | null;
  skillMode: 'inherit' | 'allowlist';
  /**
   * @deprecated 旧版“跟随全局”配置的兼容字段。Bot 已不继承全局 Skill，
   * 运行时不会读取它；暂时保留形状，避免旧 Profile/跨端快照解析失败。
   */
  skillsExcluded: string[];
  toolsetMode: 'inherit' | 'allowlist';
  toolsets: string[];
  mcpMode: 'inherit' | 'allowlist';
  mcpServers: string[];
  memory: boolean;
  permissions: 'ask' | 'trusted';
}

export interface BotModelOverride {
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean;
}

export type { BotHarness, BotModelRoute };
export { BOT_MODEL_CHAIN_MAX };

function vendorForHarness(harness: BotCapabilities['harness']): 'cc' | 'codex' | 'pi' {
  return harness === 'claude' ? 'cc' : harness;
}

function normalizeBotModel(model: unknown, harness: BotCapabilities['harness']): string {
  if (typeof model === 'string' && model.trim()) return model.trim();
  // 旧记录缺 model 时走与新建同一条口径,不另读 lastByVendor 的种子快照。
  return defaultBotModel(vendorForHarness(harness));
}

function normalizeBotModelOverride(
  value: unknown,
  capabilities: Partial<BotCapabilities>,
  harness: BotCapabilities['harness'],
): BotModelOverride | null {
  if (value === null) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.model === 'string' && record.model.trim()) {
      return {
        model: record.model.trim(),
        providerId: typeof record.providerId === 'string' ? record.providerId : null,
        effort: typeof record.effort === 'string' ? record.effort : '',
        fastMode: record.fastMode === true,
      };
    }
  }
  // Legacy profiles had no source marker. Preserve the concrete value as an
  // explicit choice instead of silently changing a user's established Bot.
  if (typeof capabilities.model === 'string' && capabilities.model.trim()) {
    return {
      model: capabilities.model.trim(),
      providerId: typeof capabilities.providerId === 'string' ? capabilities.providerId : null,
      effort: typeof capabilities.effort === 'string' ? capabilities.effort : '',
      fastMode: capabilities.fastMode === true,
    };
  }
  return getEffectiveBotModelSettings(vendorForHarness(harness), null);
}

function normalizeSkillMode(
  value: unknown,
  configuredSkills: unknown,
): BotCapabilities['skillMode'] {
  // `inherit` is retained only as a compatible stored value. Runtime treats
  // it as no external grants; it never means ambient Cindy Skill inheritance.
  if (value === 'inherit' || value === 'allowlist') return value;
  return Array.isArray(configuredSkills) && configuredSkills.length > 0
    ? 'allowlist'
    : 'inherit';
}

function normalizeCapabilityMode(_value: unknown, _configured: unknown): 'inherit' | 'allowlist' {
  return 'allowlist';
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export interface BotSessionProjection {
  id: string;
  title: string;
  kind: 'chat' | 'route' | 'worker' | 'history';
  channel: BotChannel;
  updatedAt: number;
  status?: 'active' | 'archived' | 'deleted';
  role?: 'canonical' | 'route' | 'group' | 'history';
  profileVersion?: number;
  runtimeSnapshot?: {
    profileVersion: number;
    agentKind: 'claude-code' | 'codex' | 'pi';
    status: 'prepared' | 'applied' | 'degraded' | 'failed';
    preparedAt: number;
    appliedAt?: number;
    failedAt?: number;
    failure?: Record<string, unknown>;
    configured: Record<string, unknown>;
    resolved: Record<string, unknown>;
  };
}

export interface BotProfile {
  id: string;
  name: string;
  channel: BotChannel;
  description: string;
  /**
   * 角色性别 —— 只影响界面文案里用「她」还是「他」(裁决:不用「TA」)。
   * 老 profile 与用户自建伙伴没有这个字段,归一为 neutral,文案改用伙伴名字。
   */
  gender?: BotGender;
  identitySource?: string;
  userContextSource?: string;
  avatar: string;
  avatarColor: string;
  enabled: boolean;
  /** Roster-only visibility; hidden Bots keep running and remain mentionable. */
  hiddenAt?: number | null;
  /** Roster pin; does not pin or replace the canonical Cindy Session. */
  pinnedAt?: number | null;
  /** Latest durable Hermes-style failure projected by main. */
  failureReason?: BotFailureReason | null;
  needsAttention?: boolean;
  status?: import('../../../shared/botLifecycle').BotProfileLifecycleStatus;
  currentVersion?: number;
  skills: string[];
  capabilities: BotCapabilities;
  /** The real Cindy Session that backs this Bot's canonical conversation. */
  canonicalSessionId?: string;
  /**
   * Plain-text preview of the latest visible message in the canonical chat,
   * projected main-side (read-only). Null when the conversation is still empty.
   */
  /** 伙伴的家在磁盘上的位置(主进程投影)。远端会话没有本机路径时为空。 */
  homeDir?: string | null;
  lastMessagePreview?: string | null;
  /** Timestamp of that message (unix ms), null when there is none. */
  lastMessageAt?: number | null;
  /** Who sent that message — lets the list read like a chat list, not a log. */
  lastMessageRole?: 'user' | 'assistant' | null;
  createdAt: number;
  sessions: BotSessionProjection[];
}

/**
 * Resolve canonical ownership from the projected bot_session_links registry.
 * The top-level canonicalSessionId remains a migration/output mirror only.
 */
export function canonicalBotSession(bot: BotProfile): BotSessionProjection | undefined {
  const matches = bot.sessions.filter((session) => session.role === 'canonical');
  return matches.length === 1 ? matches[0] : undefined;
}

export function canonicalBotSessionId(bot: BotProfile): string | undefined {
  return canonicalBotSession(bot)?.id;
}

const STORAGE_KEY = 'cindy.bots.v1';

/**
 * 伙伴该用哪个模型:用户真正选过的优先,没选过就跟系统默认。
 *
 * 新建伙伴与**设置页换 harness** 共用这一条 —— 换 harness 时原来直接读
 * `lastByVendor[vendor].model`,把种子快照当成用户的选择,与新建那边曾经的
 * bug 完全同形。同一个决定不留两份实现。
 *
 * 两条都必须走既有来源,这里只加一层有界首选:
 *  - `lastByVendor` 的整份快照会随任意 draft 写入落盘,里面的 model 即使用户从没碰过
 *    也带着种子默认 —— 直接读它,新建的每个伙伴都会撞上种子档,与用户自己选的无关
 *    (2026-08-21 用户实测投诉)。`modelChosenByVendor` 才是「真选过」的判据,
 *    `getPersistedVendorModel` 就是按它做的读取。
 *  - 新建 Pi Bot 优先 GLM-5.3-Flash,但只有它在当前**已连接来源**里真的可路由才选;
 *    否则取当前可选模型的第一项。一个可选模型都没有时 model 留空,让选择器展示空态。
 *    model / provider / effort 始终从同一个来源条目一起解析。
 *  - 其它 harness 仍直接取 `getDefaultModelForVendor()`,也就是模型选择器给新对话用的
 *    同一个默认值(服务端目录的 newSessionDefault)。
 */
function defaultBotModelSettings(vendor: ReturnType<typeof vendorForHarness>): BotModelOverride {
  if (vendor === 'pi') {
    const providers = getCachedProvidersSnapshot()?.providers ?? [];
    const preferredProviderId = effectiveSourceIdForModel(
      providers,
      null,
      NEW_BOT_DEFAULT_PI_MODEL,
      'pi',
    );
    if (preferredProviderId) {
      const provider = providers.find((item) => item.id === preferredProviderId);
      const preferred = provider
        ? getModel(provider, NEW_BOT_DEFAULT_PI_MODEL, 'pi')
        : undefined;
      return {
        model: NEW_BOT_DEFAULT_PI_MODEL,
        providerId: preferredProviderId,
        effort: preferred?.defaultEffort ?? '',
        fastMode: false,
      };
    }
    const fallback = pickFirstConnectedModelForAgent(providers, 'pi');
    if (fallback) {
      const provider = providers.find((item) => item.id === fallback.providerId);
      const model = provider ? getModel(provider, fallback.model, 'pi') : undefined;
      return {
        model: fallback.model,
        providerId: fallback.providerId,
        effort: model?.defaultEffort ?? '',
        fastMode: false,
      };
    }
    // The Bot default is a durable product choice, not a transient projection
    // of whether the provider catalog happened to finish loading first.
    return {
      model: NEW_BOT_DEFAULT_PI_MODEL,
      providerId: NEW_BOT_DEFAULT_PI_PROVIDER,
      effort: NEW_BOT_DEFAULT_PI_EFFORT,
      fastMode: false,
    };
  }
  const fallback = getDefaultModelForVendor(vendor);
  return {
    model: fallback.id,
    providerId: null,
    effort: fallback.defaultEffort ?? '',
    fastMode: false,
  };
}

export function defaultBotModel(vendor: ReturnType<typeof vendorForHarness>): string {
  // `||` 不是 `??`:「没选过」在 getPersistedVendorModel 里是空串,不是 null。
  return getPersistedVendorModel(vendor) || defaultBotModelSettings(vendor).model;
}

const BOT_GLOBAL_MODEL_KEY = 'cindy.bots.global-model-overrides.v1';
const BOT_GLOBAL_MODEL_CHAIN_KEY = 'cindy.bots.global-model-chain.v2';
type BotModelVendor = ReturnType<typeof vendorForHarness>;
const botModelListeners = new Set<() => void>();
let globalModelChainCache: BotModelRoute[] | null = null;

function readGlobalModelOverrides(): Partial<Record<BotModelVendor, BotModelOverride>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BOT_GLOBAL_MODEL_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Partial<Record<BotModelVendor, BotModelOverride>> = {};
    for (const vendor of ['cc', 'codex', 'pi'] as const) {
      const item = (value as Record<string, unknown>)[vendor];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.model !== 'string' || !record.model.trim()) continue;
      result[vendor] = {
        model: record.model.trim(),
        providerId: typeof record.providerId === 'string' ? record.providerId : null,
        effort: typeof record.effort === 'string' ? record.effort : '',
        fastMode: record.fastMode === true,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function getBotGlobalModelOverride(vendor: BotModelVendor): BotModelOverride | null {
  return readGlobalModelOverrides()[vendor] ?? null;
}

export function getEffectiveBotModelSettings(
  vendor: BotModelVendor,
  override?: BotModelOverride | null,
): BotModelOverride {
  const selected = override ?? getBotGlobalModelOverride(vendor);
  if (selected) return selected;
  return defaultBotModelSettings(vendor);
}

export function setBotGlobalModelOverride(
  vendor: BotModelVendor,
  override: BotModelOverride | null,
): void {
  if (typeof window === 'undefined') return;
  const current = readGlobalModelOverrides();
  if (override) current[vendor] = override;
  else delete current[vendor];
  window.localStorage.setItem(BOT_GLOBAL_MODEL_KEY, JSON.stringify(current));
  for (const listener of botModelListeners) listener();
}

export function subscribeBotGlobalModel(listener: () => void): () => void {
  botModelListeners.add(listener);
  return () => botModelListeners.delete(listener);
}

export function getBotGlobalModelChain(): BotModelRoute[] | null {
  return globalModelChainCache;
}

function readLegacyBotGlobalModelChain(): BotModelRoute[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BOT_GLOBAL_MODEL_CHAIN_KEY);
    if (!raw) return null;
    const chain = normalizeBotModelChain(JSON.parse(raw) as unknown);
    return chain.length > 0 ? chain : null;
  } catch {
    return null;
  }
}

export function getEffectiveBotModelChain(
  _fallbackHarness: BotHarness = NEW_BOT_DEFAULT_HARNESS,
): BotModelRoute[] {
  const stored = getBotGlobalModelChain();
  if (stored) return stored;
  return [{
    harness: NEW_BOT_DEFAULT_HARNESS,
    model: NEW_BOT_DEFAULT_PI_MODEL,
    providerId: NEW_BOT_DEFAULT_PI_PROVIDER,
    effort: NEW_BOT_DEFAULT_PI_EFFORT,
    fastMode: false,
  }];
}

export async function setBotGlobalModelChain(chain: BotModelRoute[]): Promise<void> {
  const api = botsApi();
  if (!api || typeof api.setModelChainSettings !== 'function') {
    throw new Error('Bot model settings are not ready');
  }
  const normalized = normalizeBotModelChain(chain);
  if (normalized.length === 0) throw new Error('Choose at least one Bot model route');
  const state = await api.setModelChainSettings({ modelChain: normalized });
  const persisted = normalizeBotModelChain(state.modelChain);
  if (persisted.length === 0) throw new Error('Bot model settings were not saved');
  globalModelChainCache = persisted;
  window.localStorage.removeItem(BOT_GLOBAL_MODEL_CHAIN_KEY);
  const primary = persisted[0]!;
  profiles = profiles.map((bot) => bot.capabilities.modelChainOverride === null
    ? {
        ...bot,
        capabilities: {
          ...bot.capabilities,
          ...primary,
          modelOverride: null,
          modelChain: persisted,
          modelChainOverride: null,
        },
      }
    : bot);
  for (const listener of botModelListeners) listener();
  emit();
}

function defaultCapabilities(
  harness: BotCapabilities['harness'] = NEW_BOT_DEFAULT_HARNESS,
): BotCapabilities {
  const vendor = vendorForHarness(harness);
  const prefs = getDraft().lastByVendor[vendor];
  const override = getBotGlobalModelOverride(vendor);
  const resolved = getEffectiveBotModelSettings(vendor, override);
  const globalChain = getEffectiveBotModelChain(harness);
  const primary = globalChain[0] ?? { harness, ...resolved };
  const model = primary.model;
  return {
    model,
    modelOverride: null,
    // 模型没沿用 lastByVendor 时,来源也不能沿用 —— providerId 与 model 必须同源,
    // 否则会拿一个来源去解析另一个来源的模型 id。
    providerId: primary.providerId ?? (model === prefs.model ? (prefs.providerId ?? null) : null),
    effort: model ? (primary.effort || prefs.effort) : '',
    fastMode: model ? primary.fastMode : false,
    harness: primary.harness,
    modelChain: globalChain,
    modelChainOverride: null,
    // A Bot starts with its own/profile capabilities, not the entire Cindy
    // environment. Explicit grants remain available through the advanced UI.
    skillMode: 'allowlist',
    skillsExcluded: [],
    toolsetMode: 'allowlist',
    toolsets: [],
    mcpMode: 'allowlist',
    mcpServers: [],
    memory: true,
    // 新建伙伴默认放手做(产品裁决 2026-08-18)。**只作用于「新建」**:读取既有
    // profile 的两条路径都显式跑 normalizeBotPermissions,缺字段的历史数据仍落
    // 'ask',与 main 侧投影一致,不会因为默认值变了就把老伙伴悄悄升成信任。
    permissions: NEW_BOT_DEFAULT_PERMISSIONS,
  };
}

export interface CreateBotProfileInput {
  name: string;
  description: string;
  /** Kept for legacy callers; every new Bot is local-first and Channels mount later. */
  channel?: BotChannel;
  identitySource?: string;
  userContextSource?: string;
  /**
   * 角色性别,界面文案据它取「她 / 他」。自建伙伴不给 → 文案改用它自己的名字。
   *
   * 此前这个字段**不在类型里**,阵容页用对象展开传进来,TypeScript 对展开不做
   * 多余属性检查,于是一路被静默丢弃、没有任何报错:卡片上写着「让她加入」,
   * 点进去设置页却是「林律是谁」(2026-08-21 实机才发现)。
   */
  gender?: BotGender;
  avatar?: string;
  avatarColor?: string;
  skills?: string[];
  capabilities?: Partial<BotCapabilities>;
}

function readProfiles(): BotProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): BotProfile[] => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Partial<BotProfile>;
      if (!(
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.channel === 'string' &&
        typeof value.enabled === 'boolean' &&
        Array.isArray(value.sessions)
      ))
        return [];
      const capabilities = value.capabilities ?? defaultCapabilities();
      const harness = normalizeBotHarness(capabilities.harness);
      const defaults = defaultCapabilities(harness);
      const modelOverride = normalizeBotModelOverride(capabilities.modelOverride, capabilities, harness);
      const resolvedModel = modelOverride ?? getEffectiveBotModelSettings(vendorForHarness(harness), null);
      const inheritedChain = normalizeBotModelChain(
        capabilities.modelChain,
        {
          harness,
          model: resolvedModel.model || capabilities.model,
          providerId: resolvedModel.providerId ?? capabilities.providerId,
          effort: resolvedModel.effort || capabilities.effort,
          fastMode: resolvedModel.fastMode || capabilities.fastMode === true,
        },
      );
      const primaryRoute = inheritedChain[0];
      const legacyTools = normalizeStringList(
        (capabilities as unknown as { tools?: unknown }).tools,
      );
      const toolsets =
        normalizeStringList(capabilities.toolsets).length > 0
          ? normalizeStringList(capabilities.toolsets)
          : legacyTools.every((item) => ['files', 'browser', 'mcp'].includes(item))
            ? []
            : legacyTools;
      return [
        {
          ...(value as BotProfile),
          avatar: typeof value.avatar === 'string' ? value.avatar : '🤖',
          avatarColor: typeof value.avatarColor === 'string' ? value.avatarColor : 'violet',
          skills: Array.isArray(value.skills) ? value.skills : [],
          userContextSource:
            typeof value.userContextSource === 'string' ? value.userContextSource : '',
          capabilities: {
            ...defaults,
            ...capabilities,
            harness: primaryRoute?.harness ?? harness,
            modelChain: inheritedChain,
            modelChainOverride: Array.isArray(capabilities.modelChainOverride)
              ? normalizeBotModelChain(capabilities.modelChainOverride)
              : capabilities.modelOverride && typeof capabilities.modelOverride === 'object'
                ? inheritedChain
                : null,
            providerId:
              primaryRoute?.providerId
              ?? (capabilities.modelOverride === null
                ? resolvedModel.providerId
                : modelOverride
                ? modelOverride.providerId
                : typeof capabilities.providerId === 'string'
                ? capabilities.providerId
                  : capabilities.providerId === null
                    ? null
                    : resolvedModel.providerId),
            effort:
              primaryRoute?.effort
              || (capabilities.modelOverride === null
                ? resolvedModel.effort
                : modelOverride?.effort
                  ? modelOverride.effort
                : typeof capabilities.effort === 'string' && capabilities.effort
                ? capabilities.effort
                : defaults.effort),
            fastMode: primaryRoute?.fastMode
              ?? (capabilities.modelOverride === null
                ? resolvedModel.fastMode
                : modelOverride?.fastMode === true),
            permissions: normalizeBotPermissions(capabilities.permissions),
            skillMode: normalizeSkillMode(capabilities.skillMode, value.skills),
            skillsExcluded: normalizeStringList(capabilities.skillsExcluded),
            model: primaryRoute?.model
              || resolvedModel.model
              || normalizeBotModel(capabilities.model, harness),
            modelOverride:
              capabilities.modelOverride === null ? null : modelOverride,
            toolsetMode: normalizeCapabilityMode(capabilities.toolsetMode, toolsets),
            toolsets,
            mcpMode: normalizeCapabilityMode(capabilities.mcpMode, capabilities.mcpServers),
            mcpServers: normalizeStringList(capabilities.mcpServers),
          },
          canonicalSessionId:
            typeof value.canonicalSessionId === 'string' ? value.canonicalSessionId : undefined,
          sessions: value.sessions.filter(
            (session) => typeof session?.id === 'string' && !session.id.startsWith('bot-chat-'),
          ),
        },
      ];
    });
  } catch {
    return [];
  }
}

let profiles = readProfiles();
const listeners = new Set<() => void>();
let hydrated = false;
const hydrationPromises = new Set<Promise<void>>();
const deletingBotIds = new Set<string>();
/** 每个伙伴各自的写入代际 —— 见 updateBotProfile 里的 isLatestWrite。 */
const profileWriteGenerations = new Map<string, number>();

function trackHydration(): void {
  const promise = hydrateFromDatabase();
  hydrationPromises.add(promise);
  void promise.then(
    () => hydrationPromises.delete(promise),
    () => hydrationPromises.delete(promise),
  );
}

async function waitForHydration(): Promise<void> {
  while (hydrationPromises.size > 0) {
    await Promise.all([...hydrationPromises]);
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }
  emit();
}

function botsApi(): NonNullable<typeof window.electronAPI.localDb>['bots'] | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI?.localDb?.bots ?? null;
}

function normalizeDbProfile(value: unknown): BotProfile | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<BotProfile>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const channel =
    item.channel &&
    [
      'telegram',
      'feishu',
      'slack',
      'discord',
      'wechat',
      'dingtalk',
      'wecom',
      'x',
      'local',
    ].includes(item.channel)
      ? item.channel
      : 'local';
  const harness = normalizeBotHarness(item.capabilities?.harness);
  const rawCapabilities = item.capabilities as (BotCapabilities & { tools?: unknown }) | undefined;
  const defaults = defaultCapabilities(harness);
  const modelOverride = normalizeBotModelOverride(rawCapabilities?.modelOverride, rawCapabilities ?? {}, harness);
  const resolvedModel = modelOverride ?? getEffectiveBotModelSettings(vendorForHarness(harness), null);
  const modelChain = normalizeBotModelChain(
    rawCapabilities?.modelChain,
    {
      harness,
      model: resolvedModel.model || rawCapabilities?.model,
      providerId: resolvedModel.providerId ?? rawCapabilities?.providerId,
      effort: resolvedModel.effort || rawCapabilities?.effort,
      fastMode: resolvedModel.fastMode || rawCapabilities?.fastMode === true,
    },
  );
  const primaryRoute = modelChain[0];
  const legacyTools = normalizeStringList(rawCapabilities?.tools);
  const toolsets =
    normalizeStringList(rawCapabilities?.toolsets).length > 0
      ? normalizeStringList(rawCapabilities?.toolsets)
      : legacyTools.every((entry) => ['files', 'browser', 'mcp'].includes(entry))
        ? []
        : legacyTools;
  return {
    id: item.id,
    name: item.name,
    channel,
    description: typeof item.description === 'string' ? item.description : '',
    identitySource: typeof item.identitySource === 'string' ? item.identitySource : '',
    userContextSource: typeof item.userContextSource === 'string' ? item.userContextSource : '',
    // 落库回读的性别。老档案没有 → 留空 → 界面按名字称呼(与升级前一致)。
    ...(item.gender === 'female' || item.gender === 'male' ? { gender: item.gender } : {}),
    avatar: typeof item.avatar === 'string' ? item.avatar : '🤖',
    avatarColor: typeof item.avatarColor === 'string' ? item.avatarColor : 'violet',
    enabled: item.enabled !== false,
    hiddenAt:
      typeof item.hiddenAt === 'number' && Number.isFinite(item.hiddenAt) ? item.hiddenAt : null,
    pinnedAt:
      typeof item.pinnedAt === 'number' && Number.isFinite(item.pinnedAt) ? item.pinnedAt : null,
    failureReason: BOT_FAILURE_REASONS.includes(item.failureReason as BotFailureReason)
      ? item.failureReason as BotFailureReason
      : null,
    needsAttention: item.needsAttention === true,
    status:
      item.status === 'active' ||
      item.status === 'paused' ||
      item.status === 'error' ||
      item.status === 'archived' ||
      item.status === 'deleting'
        ? item.status
        : item.enabled === false
          ? 'paused'
          : 'active',
    currentVersion: typeof item.currentVersion === 'number' ? item.currentVersion : undefined,
    skills: Array.isArray(item.skills)
      ? item.skills.filter((x): x is string => typeof x === 'string')
      : [],
    capabilities: {
      ...defaults,
      ...(item.capabilities ?? {}),
      harness: primaryRoute?.harness ?? harness,
      modelChain,
      modelChainOverride: Array.isArray(rawCapabilities?.modelChainOverride)
        ? normalizeBotModelChain(rawCapabilities.modelChainOverride)
        : rawCapabilities?.modelOverride && typeof rawCapabilities.modelOverride === 'object'
          ? modelChain
          : null,
      providerId:
        primaryRoute?.providerId
        ?? (rawCapabilities?.modelOverride === null
          ? resolvedModel.providerId
          : modelOverride
          ? modelOverride.providerId
          : typeof rawCapabilities?.providerId === 'string'
          ? rawCapabilities.providerId
            : rawCapabilities?.providerId === null
              ? null
              : resolvedModel.providerId),
      effort:
        primaryRoute?.effort
        || (rawCapabilities?.modelOverride === null
          ? resolvedModel.effort
          : modelOverride?.effort
            ? modelOverride.effort
          : typeof rawCapabilities?.effort === 'string' && rawCapabilities.effort
          ? rawCapabilities.effort
          : defaults.effort),
      fastMode: primaryRoute?.fastMode
        ?? (rawCapabilities?.modelOverride === null
          ? resolvedModel.fastMode
          : modelOverride?.fastMode === true),
      permissions: normalizeBotPermissions(rawCapabilities?.permissions),
      skillMode: normalizeSkillMode(item.capabilities?.skillMode, item.skills),
      skillsExcluded: normalizeStringList(rawCapabilities?.skillsExcluded),
      model: primaryRoute?.model || resolvedModel.model || normalizeBotModel(item.capabilities?.model, harness),
      modelOverride: rawCapabilities?.modelOverride === null ? null : modelOverride,
      toolsetMode: normalizeCapabilityMode(rawCapabilities?.toolsetMode, toolsets),
      toolsets,
      mcpMode: normalizeCapabilityMode(rawCapabilities?.mcpMode, rawCapabilities?.mcpServers),
      mcpServers: normalizeStringList(rawCapabilities?.mcpServers),
    },
    canonicalSessionId:
      typeof item.canonicalSessionId === 'string' ? item.canonicalSessionId : undefined,
    homeDir: typeof item.homeDir === 'string' && item.homeDir ? item.homeDir : null,
    lastMessagePreview:
      typeof item.lastMessagePreview === 'string' && item.lastMessagePreview
        ? item.lastMessagePreview
        : null,
    lastMessageAt:
      typeof item.lastMessageAt === 'number' && Number.isFinite(item.lastMessageAt)
        ? item.lastMessageAt
        : null,
    lastMessageRole:
      item.lastMessageRole === 'user' || item.lastMessageRole === 'assistant'
        ? item.lastMessageRole
        : null,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    sessions: Array.isArray(item.sessions)
      ? item.sessions.filter((s): s is BotSessionProjection => !!s && typeof s.id === 'string')
      : [],
  };
}

/**
 * Unread replies per Bot, as counted main-side against this renderer's read
 * positions. Kept beside the profiles rather than inside them: single-Bot
 * refreshes (`get` / `update` / route mutations) carry no read state, so a
 * merged field would blink the badge off on every unrelated settings save.
 */
let unreadCounts: Record<string, number> = {};

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function applyUnreadCounts(rows: unknown[]): void {
  const next: Record<string, number> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { id?: unknown; unreadCount?: unknown };
    if (typeof item.id !== 'string') continue;
    const count = item.unreadCount;
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      next[item.id] = Math.floor(count);
    }
  }
  if (!sameCounts(unreadCounts, next)) unreadCounts = next;
}

export function getBotUnreadCounts(): Record<string, number> {
  return unreadCounts;
}

/** Unread badge source for the Bots sidebar; shares the profile listener set. */
export function useBotUnreadCounts(): Record<string, number> {
  return useSyncExternalStore(subscribeBotProfiles, getBotUnreadCounts, getBotUnreadCounts);
}

async function hydrateFromDatabase(): Promise<void> {
  const api = botsApi();
  // 副窗口(右侧栏 detached host)只桥接了 Bot 的只读交付物投影,没有 profile
  // 列表 —— 有 `bots` 命名空间不等于有完整 API,按能力探测而不是按存在性判定。
  if (!api || typeof api.list !== 'function' || hydrated) return;
  hydrated = true;
  try {
    if (typeof api.getModelChainSettings === 'function') {
      try {
        let state = await api.getModelChainSettings();
        const legacy = readLegacyBotGlobalModelChain();
        if (!state.isCustomized && legacy && typeof api.setModelChainSettings === 'function') {
          state = await api.setModelChainSettings({ modelChain: legacy });
        }
        const persisted = normalizeBotModelChain(state.modelChain);
        if (persisted.length > 0) {
          globalModelChainCache = persisted;
          window.localStorage.removeItem(BOT_GLOBAL_MODEL_CHAIN_KEY);
          for (const listener of botModelListeners) listener();
        }
      } catch {
        // Profile hydration remains usable if the settings file is temporarily
        // unavailable. A later explicit refresh retries the Main-owned source.
      }
    }
    const rows = await api.list({ lastReadAtByBotId: getBotLastReadAtMap() });
    const dbProfiles = rows.map(normalizeDbProfile).filter((item): item is BotProfile => !!item);
    profiles = dbProfiles;
    applyUnreadCounts(rows);
    // A Bot we have never tracked starts read: shipping unread badges must not
    // retroactively mark every existing conversation as unread. Pruning keeps
    // the stored map from growing with deleted Bots.
    const visibleIds = profiles.map((bot) => bot.id);
    seedMissingBotReadState(visibleIds);
    pruneBotReadState(visibleIds);
    emit();
  } catch {
    // DB readiness can race the first renderer render during account/bootstrap.
    // The Bots layout explicitly calls refreshBotProfiles when entered, so do
    // not keep polling a signed-out renderer in the background.
    hydrated = false;
  }
}

trackHydration();

export function refreshBotProfiles(): void {
  hydrated = false;
  trackHydration();
}

export async function getBotHealth(botId: string): Promise<BotHealthReport> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  return api.health(botId);
}

export async function runBotLifecycleAction(
  request: import('../../../shared/botLifecycle').BotLifecycleActionRequest,
): Promise<import('../../../shared/botLifecycle').BotLifecycleActionResult> {
  const isDelete = request.action === 'delete';
  if (isDelete) {
    // Legacy migration can still be writing a profile when the first renderer
    // opens. Let it finish before deleting, otherwise its stale snapshot can
    // recreate the Bot immediately after the delete transaction commits.
    await waitForHydration();
    deletingBotIds.add(request.botId);
  }
  try {
    const result = await window.electronAPI.maker.runBotLifecycleAction(request);
    const api = botsApi();
    if (result.status === 'deleted') {
      profiles = profiles.filter((bot) => bot.id !== request.botId);
      persist();
      return result;
    }
    if (api) {
      const refreshed = normalizeDbProfile(await api.get(request.botId));
      if (refreshed) {
        profiles = profiles.map((bot) => (bot.id === request.botId ? refreshed : bot));
        persist();
      }
    }
    return result;
  } finally {
    if (isDelete) deletingBotIds.delete(request.botId);
  }
}

export function getBotProfiles(): BotProfile[] {
  return profiles;
}

export function subscribeBotProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotProfiles(): BotProfile[] {
  return useSyncExternalStore(subscribeBotProfiles, getBotProfiles, getBotProfiles);
}

export function addBotProfile(input: CreateBotProfileInput): BotProfile {
  const now = Date.now();
  const requested = input.capabilities ?? {};
  const defaults = defaultCapabilities();
  const explicitChain = Array.isArray(requested.modelChainOverride)
    ? normalizeBotModelChain(requested.modelChainOverride)
    : requested.modelOverride && typeof requested.modelOverride === 'object'
      ? normalizeBotModelChain(requested.modelChain, {
          harness: requested.harness,
          ...requested.modelOverride,
        })
      : [];
  const explicitPrimary = explicitChain[0] ?? null;
  const defaultPrimary = defaults.modelChain[0]!;
  const capabilities = {
    ...defaults,
    ...requested,
    ...(explicitPrimary
      ? {
          ...explicitPrimary,
          modelChain: explicitChain,
          modelChainOverride: explicitChain,
        }
      : {
          ...defaultPrimary,
          modelOverride: null,
          modelChain: defaults.modelChain,
          modelChainOverride: null,
        }),
  };
  const bot: BotProfile = {
    id: `bot_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'New Bot',
    // A Bot is always created as a local profile. IM surfaces are mounts, not
    // the Bot's identity/type; the requested channel is attached below.
    channel: 'local',
    description: input.description.trim(),
    identitySource: input.identitySource?.trim() || undefined,
    userContextSource: input.userContextSource?.trim() ?? '',
    // 角色性别:阵容卡传进来,界面文案据它取「她 / 他」。这里漏掉的话后面每一层
    // 都拿不到 —— 卡上写着「让她加入」,进去就变成按名字称呼(2026-08-21 实机)。
    ...(input.gender ? { gender: input.gender } : {}),
    avatar: input.avatar?.trim() || '🤖',
    avatarColor: input.avatarColor?.trim() || 'violet',
    enabled: true,
    skills: normalizeStringList(input.skills),
    capabilities,
    createdAt: now,
    // The real canonical Session is created by BotsHomeView after the profile
    // exists. Never create a fake bot-chat-* projection.
    sessions: [],
  };
  profiles = [bot, ...profiles];
  persist();
  return bot;
}

/** Create the local projection and wait until main/SQLite owns the profile. */
export async function addBotProfileAndWait(input: CreateBotProfileInput): Promise<BotProfile> {
  const harness = normalizeBotHarness(
    input.capabilities?.harness ?? NEW_BOT_DEFAULT_HARNESS,
  );
  const needsPiDefault = harness === 'pi' && input.capabilities?.model === undefined;
  if (
    needsPiDefault
    && getCachedProvidersSnapshot() === null
    && typeof window !== 'undefined'
  ) {
    await refreshLocalCatalogSnapshot();
  }
  const bot = addBotProfile(input);
  const api = botsApi();
  if (!api) return bot;
  try {
    const created = normalizeDbProfile(
      await api.create({
        id: bot.id,
        name: bot.name,
        description: bot.description,
        avatar: bot.avatar,
        avatarColor: bot.avatarColor,
        skills: bot.skills,
        capabilities: bot.capabilities,
        identitySource: bot.identitySource ?? '',
        userContextSource: bot.userContextSource ?? '',
        // 性别必须一起发过去,否则落库时丢掉,界面只能回落成「用名字称呼」——
        // 阵容卡上明明写着「让她加入」,进去就变成「林律是谁」(2026-08-21 实机)。
        ...(bot.gender ? { gender: bot.gender } : {}),
      }),
    );
    if (!created) throw new Error('Bot profile create returned an invalid profile');
    profiles = profiles.map((item) => (item.id === bot.id ? created : item));
    persist();
  } catch (error) {
    // The renderer projection is optimistic, but a failed main/SQLite create
    // must not leave a ghost Bot that can never be opened or migrated.
    profiles = profiles.filter((item) => item.id !== bot.id);
    persist();
    throw error;
  }
  return profiles.find((item) => item.id === bot.id) ?? bot;
}

export type BotProfileUpdatePatch = Partial<
    Pick<
      BotProfile,
      | 'name'
      | 'description'
      | 'identitySource'
      | 'userContextSource'
      | 'avatar'
      | 'avatarColor'
      | 'enabled'
      | 'skills'
      | 'capabilities'
      | 'canonicalSessionId'
      | 'sessions'
    >
  > & { avatarUploadToken?: string };

export function updateBotProfile(id: string, patch: BotProfileUpdatePatch): Promise<BotProfile> {
  const before = profiles.find((bot) => bot.id === id);
  if (!before) return Promise.reject(new Error('Bot not found'));
  const { avatarUploadToken, ...profilePatch } = patch;
  // 这一行的写入代际。回填与回滚都要求「我仍然是这一行最新的那次写」——
  // 落后的响应一律丢弃,不许覆盖更新的状态(见下面两处 isLatestWrite)。
  const generation = (profileWriteGenerations.get(id) ?? 0) + 1;
  profileWriteGenerations.set(id, generation);
  const isLatestWrite = () => profileWriteGenerations.get(id) === generation;
  profiles = profiles.map((bot) => (bot.id === id ? { ...bot, ...profilePatch } : bot));
  persist();
  const optimistic = profiles.find((bot) => bot.id === id) ?? { ...before, ...profilePatch };
  const api = botsApi();
  if (!api) return Promise.resolve(optimistic);
  return api
    .update({
      id,
      ...profilePatch,
      ...(avatarUploadToken ? { avatarUploadToken } : {}),
      ...(profilePatch.avatar !== undefined || avatarUploadToken
        ? { expectedAvatar: before.avatar }
        : {}),
      identitySource: profilePatch.identitySource,
    })
    .then((value) => {
      const next = normalizeDbProfile(value);
      if (!next) throw new Error('Bot profile update returned invalid data');
      // 同一行已经有更新的写在飞:那次的乐观值更接近用户此刻的意图,
      // 让它赢。调用方仍然拿到自己这次的服务端结果。
      if (!isLatestWrite()) return next;
      profiles = profiles.map((bot) => (bot.id === id ? next : bot));
      persist();
      return next;
    })
    .catch((error) => {
      /*
        只回滚**这一行**,而且只在自己仍是最新那次写的时候回滚。

        原先这里是 `profiles = previous`,拿整张列表的旧快照覆盖回去 ——
        从乐观写到失败之间落地的任何其它写入都被静默撤销。三个并发写入方
        是真实存在的(生命周期设置、伙伴设置页、对话界面的模型回写),
        其中模型回写是 `void … .catch(() => {})` 即发即忘、失败无声,
        它的回滚会把用户刚在设置页保存的修改一起抹掉。

        而且不会自愈:伙伴列表只在进入伙伴页时重新投影(hydrateFromDatabase
        有 hydrated 闸),所以数据库里是对的,界面上却一直显示被还原的旧值。
      */
      if (isLatestWrite()) {
        profiles = profiles.map((bot) => (bot.id === id ? before : bot));
        persist();
      }
      throw error;
    });
}

async function setBotRosterFlag(
  id: string,
  flag: 'hidden' | 'pinned',
  value: boolean,
): Promise<BotProfile> {
  const api = botsApi();
  if (!api) throw new Error('Bot storage is not ready');
  const next = normalizeDbProfile(await api.update({ id, [flag]: value }));
  if (!next) throw new Error('Bot profile update returned invalid data');
  profiles = profiles.map((bot) => (bot.id === id ? next : bot));
  persist();
  return next;
}

/** Hide only changes the Bots roster. Runtime, @ mentions, groups and channels stay live. */
export function setBotHidden(id: string, hidden: boolean): Promise<BotProfile> {
  return setBotRosterFlag(id, 'hidden', hidden);
}

/** Pin only changes roster ordering; it never mutates the canonical Session pin. */
export function setBotPinned(id: string, pinned: boolean): Promise<BotProfile> {
  return setBotRosterFlag(id, 'pinned', pinned);
}

function duplicateBotName(sourceName: string): string {
  const names = new Set(profiles.map((bot) => bot.name.trim().toLocaleLowerCase()));
  for (let number = 2; number < 100; number += 1) {
    const suffix = `-${number}`;
    const candidate = `${sourceName.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('No free name for the duplicate Bot');
}

/**
 * Hermes duplicate semantics: copy the Profile and look, but not creation time,
 * roster flags, channel mounts, canonical ownership, or transcript.
 */
export async function duplicateBotProfile(id: string): Promise<BotProfile> {
  const source = profiles.find((bot) => bot.id === id);
  if (!source) throw new Error('Bot not found');
  return addBotProfileAndWait({
    name: duplicateBotName(source.name),
    description: source.description,
    identitySource: source.identitySource,
    userContextSource: source.userContextSource,
    ...(source.gender ? { gender: source.gender } : {}),
    avatar: source.avatar,
    avatarColor: source.avatarColor,
    skills: [...source.skills],
    capabilities: {
      ...source.capabilities,
      skillsExcluded: [...source.capabilities.skillsExcluded],
      toolsets: [...source.capabilities.toolsets],
      mcpServers: [...source.capabilities.mcpServers],
    },
  });
}

/**
 * Move the previous canonical Session into the Bot history projection and make
 * the supplied Session the new canonical chat. The real transcript remains in
 * the shared sessions/messages tables; this projection only owns Bot navigation.
 */
export function setCanonicalBotSession(
  botId: string,
  session: Pick<BotSessionProjection, 'id' | 'title' | 'updatedAt'>,
): void {
  profiles = profiles.map((bot) => {
    if (bot.id !== botId) return bot;
    const previousId = canonicalBotSessionId(bot);
    const current = bot.sessions.find((item) => item.id === session.id);
    if (
      previousId === session.id &&
      current?.kind === 'chat' &&
      current.status === 'active' &&
      current.title === session.title
    ) {
      return bot;
    }
    const history = bot.sessions
      .filter((item) => item.id !== session.id)
      .map((item) =>
        item.id === previousId
          ? { ...item, kind: 'history' as const, status: 'archived' as const }
          : item,
      );
    return {
      ...bot,
      canonicalSessionId: session.id,
      sessions: [
        {
          id: session.id,
          title: session.title,
          kind: 'chat' as const,
          channel: bot.channel,
          updatedAt: session.updatedAt,
          status: 'active' as const,
          role: 'canonical' as const,
        },
        ...history,
      ],
    };
  });
  persist();
}

export function markBotSessionArchived(
  botId: string,
  sessionId: string,
  updatedAt = Date.now(),
): void {
  profiles = profiles.map((bot) =>
    bot.id === botId
      ? {
          ...bot,
          sessions: bot.sessions.map((item) =>
            item.id === sessionId
              ? {
                  ...item,
                  kind: 'history' as const,
                  role: 'history' as const,
                  status: 'archived' as const,
                  updatedAt,
                }
              : item,
          ),
        }
      : bot,
  );
  persist();
  const api = botsApi();
  if (api) void api.linkSession({ botId, sessionId, role: 'history' }).catch(() => undefined);
}

export function removeBotProfile(id: string): void {
  profiles = profiles.filter((bot) => bot.id !== id);
  persist();
}
