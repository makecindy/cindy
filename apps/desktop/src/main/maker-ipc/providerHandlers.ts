/**
 * provider:* IPC handlers。
 *
 *   - PROVIDER_LIST（只读：目录元数据 + 各供应商实时连接状态）。
 *   - PROVIDER_CUSTOM_CREATE / UPDATE / DELETE（自定义供应商配置 + API key CRUD）。
 *
 * 内置三家（Anthropic / OpenAI / XD）的「连接 / 断开」**复用各 agent 已有的鉴权通道**，不另立通道。
 * 自定义供应商用 CRUD 替代连接/断开。
 *
 * create / update / delete 的密钥与配置在同一 provider mutation queue 内暂存 / 回滚，
 * 避免多个窗口并发编辑时出现“配置 A + 密钥 B”或旧回滚覆盖新写入。
 *
 * 副作用（CRUD 成功后刷新 active-catalog + 广播 PROVIDER_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import {
  isLoopbackProviderUrl,
  isProviderRequestPath,
  type AgentKind,
  type CustomProviderConfig,
  type ProviderModelDiscoveryFailure,
  type ProviderPreset,
  type ProviderView,
} from '@cindy/model-providers';

import type { LocalCliDetection } from '../../shared/localCliDetect.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type {
  ModelPriceOverrideDesiredQuote,
  ModelPriceOverrideTarget,
  ModelPriceOverrideView,
} from '../../shared/modelPriceOverride.js';
import type { MoneyCurrency } from '../../shared/regionalMoney.js';
import {
  BUILTIN_REFRESHABLE_PROVIDER_IDS,
  isBuiltinRefreshableProviderId,
  isProviderModelAutoRefreshRendererTrigger,
  PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS,
  type BuiltinRefreshableProviderId,
  type ProviderModelAutoRefreshRendererTrigger,
  type ProviderModelAutoRefreshResult,
  type ProviderModelRefreshResult,
} from '../../shared/providerModelRefresh.js';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createCustomProvider,
  customProviderExists,
  deleteCustomProvider,
  getCustomProvider,
  updateCustomProvider,
  validateCustomProviderConfig,
} from '../maker-host/custom-provider-store.js';
import type { ProviderProbeSpec, ProviderTestInput, ProviderTestResult } from '../maker-host/provider-diagnostics.js';
import type {
  ProviderModelsFetchResult,
  ProviderModelsFetchSpec,
} from '../maker-host/provider-model-fetch.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const log = createLogger('maker-ipc:provider');

const VALID_AGENTS: readonly string[] = ['claude-code', 'codex'];
const VALID_ADHOC_AUTH_METHODS: readonly string[] = ['apiKey', 'oauth', 'none'];
const PROVIDER_OAUTH_OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
type RuntimeKeys = Partial<Record<AgentKind, string>>;

type ProviderOAuthRendererSender = {
  readonly id: number;
  once?: (event: 'destroyed', listener: () => void) => unknown;
  removeListener?: (event: 'destroyed', listener: () => void) => unknown;
};

function providerOAuthOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'provider OAuth options must be an object');
  }
  return value as Record<string, unknown>;
}

function requireProviderOAuthOwnerId(value: unknown, required = false): string | undefined {
  if (value === undefined) {
    if (required) throwIpcError('INVALID_PARAMS', 'ownerId is required');
    return undefined;
  }
  if (typeof value !== 'string' || !PROVIDER_OAUTH_OWNER_ID_PATTERN.test(value)) {
    throwIpcError('INVALID_PARAMS', 'ownerId must be a valid opaque OAuth owner token');
  }
  return value;
}

function requireProviderOAuthLoginOptions(value: unknown): { ownerId?: string } {
  if (value === undefined) return {};
  const options = providerOAuthOptions(value);
  return { ownerId: requireProviderOAuthOwnerId(options.ownerId) };
}

function requireProviderOAuthCancelOptions(
  value: unknown,
): { releaseOwner: boolean; ownerId?: string } {
  if (value === undefined) return { releaseOwner: false };
  const options = providerOAuthOptions(value);
  if (options.releaseOwner !== undefined && typeof options.releaseOwner !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'releaseOwner must be a boolean');
  }
  const releaseOwner = options.releaseOwner === true;
  const ownerId = requireProviderOAuthOwnerId(options.ownerId, releaseOwner);
  if (!releaseOwner && ownerId) {
    throwIpcError('INVALID_PARAMS', 'ownerId requires releaseOwner');
  }
  return { releaseOwner, ownerId };
}

function providerOAuthRendererSender(event: unknown): ProviderOAuthRendererSender | null {
  if (!event || typeof event !== 'object') return null;
  const sender = (event as { sender?: unknown }).sender;
  if (!sender || typeof sender !== 'object') return null;
  const id = (sender as { id?: unknown }).id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  const once = (sender as { once?: unknown }).once;
  const removeListener = (sender as { removeListener?: unknown }).removeListener;
  if (once !== undefined && typeof once !== 'function') return null;
  if (removeListener !== undefined && typeof removeListener !== 'function') return null;
  return sender as ProviderOAuthRendererSender;
}

function parseRuntimeKeys(input: unknown): RuntimeKeys | null {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (
    entries.some(([agent, value]) => !VALID_AGENTS.includes(agent) || typeof value !== 'string')
  ) return null;
  return Object.fromEntries(entries) as RuntimeKeys;
}

function sortedStringRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function oauthDescriptorSignature(config: CustomProviderConfig | null): string | null {
  if (config?.auth?.method !== 'oauth') return null;
  const oauth = config.auth.oauth;
  const common = {
    tokenUrl: oauth.tokenUrl,
    clientId: oauth.clientId,
    scopes: oauth.scopes,
    modelsDiscoveryUrl: oauth.modelsDiscoveryUrl,
  };
  return oauth.flow === 'device-code'
    ? JSON.stringify({
        ...common,
        flow: 'device-code',
        deviceAuthorizationUrl: oauth.deviceAuthorizationUrl,
        extraDeviceParams: sortedStringRecord(oauth.extraDeviceParams),
      })
    : JSON.stringify({
        ...common,
        flow: 'authorization-code',
        authorizeUrl: oauth.authorizeUrl,
        redirectPort: oauth.redirectPort,
        extraAuthParams: sortedStringRecord(oauth.extraAuthParams),
      });
}

export interface ProviderHandlerDeps {
  /**
   * 当前供应商视图（含实时连接状态）；见 createDesktopProviderService。
   *
   * `allowSideEffects` 控制是否允许顺带做本机绑定自愈与随之而来的清单拉取。这条通道同时
   * 服务 device-link（合成 event）与可能不受信的渲染上下文，所以默认纯读，只有确认 sender
   * 是本机主页面时才放行副作用（PR #548 review）。
   */
  listProviders(opts?: { allowSideEffects?: boolean }): Promise<ProviderView[]>;
  /**
   * 「模型显示/隐藏」override 快照(renderer → main 镜像,生产 = getModelVisibilityMirrorSnapshot)。
   * PROVIDER_LIST 附带回传,供 device-link 控制端(手机)按被控端用户开关过滤模型列表;
   * key = `${agent}:${providerId}:${modelId}`,与 renderer modelVisibilityPrefs.keyOf 一致。
   */
  getModelVisibilityOverrides(): Record<string, boolean>;
  /** CRUD 成功后重算 active-catalog（生产 = refreshCustomProvidersIntoCatalog）。 */
  refreshCatalog(): Promise<void>;
  /**
   * 配置、secret 与 active catalog 切换期间暂停该 provider 的新请求；返回幂等 release。
   * 生产 = beginProviderRouteMutation。
   */
  beginRouteMutation(providerId: string): () => void;
  /** CRUD 成功后广播变更（生产 = 向所有窗口 send PROVIDER_CHANGED）。 */
  broadcastChanged(): void;
  /** 目录 presets 段（生产 = () => getActiveCatalog().presets ?? []）。 */
  listPresets(): ProviderPreset[];
  /** 测试连接（生产 = testProviderConnection；单测注入 stub 不联网）。 */
  testConnection(input: ProviderTestInput): Promise<ProviderTestResult>;
  /** 获取模型列表（生产 = fetchProviderModels；单测注入 stub 不联网）。 */
  fetchModels(spec: ProviderModelsFetchSpec): Promise<ProviderModelsFetchResult>;
  /** 内置四家的模型真源刷新；生产按 providerId 分派到既有 discovery 机制。 */
  refreshBuiltinModels(providerId: BuiltinRefreshableProviderId): Promise<void>;
  /** Renderer 自动刷新提示；Main 侧负责静默失败、冷却和跨窗口去重。 */
  requestModelsAutoRefresh(
    trigger: ProviderModelAutoRefreshRendererTrigger,
  ): Promise<void>;
  /**
   * 重新发现某供应商的动态清单（生产 = anthropic 的 refreshAnthropicModelsFromHttp）。
   * 返回本次结束后的失败归因，成功为 null。不认识的 providerId 直接返回 null（没有
   * 动态发现通道 = 没什么可重试的），不抛错。
   */
  rediscoverModels(providerId: string): Promise<ProviderModelDiscoveryFailure | null>;
  /**
   * sender 归属校验（生产 = security/trustedAppRenderer 的 assertTrustedAppRendererEvent，
   * 不通过时抛 PERMISSION_DENIED）。经 deps 注入而非直接 import：本文件的 handler body
   * 刻意不依赖 Electron，好让内存 registry 直接 invoke 单测（规则 14）。
   *
   * 类型上可选、语义上必需：未注入时 rediscover 直接拒绝，而不是放行。
   */
  assertTrustedSender?(event: unknown): void;
  /**
   * sender 是否是本机主页面（生产 = isTrustedAppRendererEvent）。与 assertTrustedSender
   * 的区别：**不抛**，只用于决定「这次读取要不要放行本机副作用」。device-link 的合成
   * event 与不受信的子 frame 都会得到 false，于是退化为纯读。缺省视为不可信。
   */
  isTrustedSender?(event: unknown): boolean;
  /**
   * 通用 OAuth 登录 / 登出 / 取消（生产接 generic-oauth Runner + 目录描述符解析；
   * login 成功后由生产 deps 负责模型发现与 PROVIDER_CHANGED 广播）。
   */
  oauthLogin(
    providerId: string,
    isCurrent: () => boolean,
  ): Promise<{
    ok: boolean;
    reason?: string;
    rollbackCredentials?: () => boolean;
  }>;
  oauthLogout(providerId: string): Promise<void>;
  oauthCancel(providerId: string): void;
  /**
   * 可回滚地移除 OAuth 凭证。null 表示持久删除失败；返回闭包供配置写失败时恢复旧 blob。
   */
  removeOAuthCredentials(providerId: string): (() => boolean) | null;
  /**
   * 自定义 provider API key 的严格快照读取：不存在返回 null，不可解密 / 不可读时抛错。
   * 与配置 CRUD 共用 per-provider mutation queue。
   */
  readCustomProviderKeyForMutation(providerId: string, agent: AgentKind): string | null;
  storeCustomProviderKey(providerId: string, agent: AgentKind, value: string): boolean;
  removeCustomProviderKey(
    providerId: string,
    agent: AgentKind,
  ): { success: boolean; error?: string };
  /**
   * 本机 agent CLI 安装 / 登录态扫描(生产 = scanLocalCliAuth(createLocalCliScanDeps());
   * 单测注入 stub 不碰真实 home)。只 stat 不读内容(规则 23)。
   */
  scanLocalCli(): Promise<LocalCliDetection[]>;
  /**
   * 「模型 / 供应商停用」override 写入(生产 = model-disable-store 的 setModelsDisabled /
   * setProviderDisabled)。写成功后由 handler 统一广播 PROVIDER_CHANGED。
   */
  setModelsDisabled(providerId: string, modelIds: readonly string[], disabled: boolean): void;
  setProviderDisabled(providerId: string, disabled: boolean): void;
  /**
   * 「恢复默认」= 删除该供应商的整组停用 override(供应商级 + 全部逐模型条目,含
   * 指向已下架模型的陈旧条目)。语义遵循 docs/dev-rules/configuration-and-overrides.md
   * §4:删 override 跟随默认,不写静态快照。生产 = clearProviderDisableOverrides。
   */
  clearProviderDisableOverrides?(providerId: string): void;
  /**
   * 自定义供应商删除事务内的停用 override 清理(供应商级 + 逐模型):同步清掉并
   * 返回恢复函数 —— 后续删除步骤失败时把停用状态原样写回;清理自身抛错 = 事务未
   * 产生破坏,删除整体中止。否则同 id 重建的新供应商会带着旧停用状态复活
   * (PR #744 review 第十九、二十轮)。
   */
  stageClearProviderDisableOverrides?(providerId: string): () => boolean;
  /**
   * 当前数据归属账号 id(生产 = getCurrentDataOwnerId)。停用写入是 owner-scoped
   * 持久化(model-disable-prefs.json 按账号分目录),而 handler 内有异步窗口(串行
   * 队列排队 + 目录校验的 listProviders await)—— 期间切了账号,写入会落进**新**账号
   * 的偏好文件。在入口捕获、持久化前复核,变了就拒(PR #744 review 第七轮)。
   * 可选:未注入(单测最小桩)= 不做归属校验。
   */
  currentOwnerId?(): string | null;
  /** Active account ledger currency; used to reject unsupported reverse-FX overrides. */
  getLedgerCurrency(): MoneyCurrency;
  readModelPriceOverride(target: ModelPriceOverrideTarget): ModelPriceOverrideView;
  writeModelPriceOverride(
    target: ModelPriceOverrideTarget,
    desired: ModelPriceOverrideDesiredQuote,
  ): void;
  clearModelPriceOverride(target: ModelPriceOverrideTarget): void;
  stageClearProviderModelPriceOverrides?(providerId: string): () => boolean;
  broadcastPricingChanged(): void;
}

/** 校验 PROVIDER_TEST_CONNECTION 入参形状（确定性代码校验，非法直接 INVALID_PARAMS）。 */
function parseTestInput(input: unknown): ProviderTestInput | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (i.kind === 'saved') {
    if (typeof i.providerId !== 'string' || i.providerId.length === 0) return null;
    if (typeof i.agent !== 'string' || !VALID_AGENTS.includes(i.agent)) return null;
    return { kind: 'saved', providerId: i.providerId, agent: i.agent as AgentKind };
  }
  if (i.kind === 'adhoc') {
    const s = i.spec;
    if (!s || typeof s !== 'object') return null;
    const spec = s as Record<string, unknown>;
    if (typeof spec.agent !== 'string' || !VALID_AGENTS.includes(spec.agent)) return null;
    if (
      typeof spec.authMethod !== 'string'
      || !VALID_ADHOC_AUTH_METHODS.includes(spec.authMethod)
    ) return null;
    if (typeof spec.baseUrl !== 'string' || spec.baseUrl.length === 0) return null;
    try {
      const u = new URL(spec.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    if (spec.authMethod === 'none' && !isLoopbackProviderUrl(spec.baseUrl)) return null;
    if (typeof spec.modelId !== 'string' || spec.modelId.length === 0) return null;
    if (spec.apiKey !== undefined && spec.apiKey !== null && typeof spec.apiKey !== 'string') return null;
    if (spec.headers !== undefined) {
      if (!spec.headers || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) return null;
      if (Object.values(spec.headers as Record<string, unknown>).some((v) => typeof v !== 'string')) return null;
    }
    if (spec.wireProtocol !== undefined) {
      const allowed = spec.agent === 'claude-code'
        ? ['anthropic-messages']
        : ['openai-responses', 'openai-chat', 'anthropic-messages'];
      if (typeof spec.wireProtocol !== 'string' || !allowed.includes(spec.wireProtocol)) return null;
    }
    if (spec.requestPath !== undefined && !isProviderRequestPath(spec.requestPath)) return null;
    return {
      kind: 'adhoc',
      spec: {
        agent: spec.agent as AgentKind,
        baseUrl: spec.baseUrl,
        modelId: spec.modelId,
        authMethod: spec.authMethod as ProviderProbeSpec['authMethod'],
        wireProtocol: spec.wireProtocol as ProviderProbeSpec['wireProtocol'],
        requestPath: spec.requestPath as string | undefined,
        apiKey: (spec.apiKey as string | null | undefined) ?? null,
        headers: spec.headers as Record<string, string> | undefined,
      },
    };
  }
  return null;
}

/** 校验 PROVIDER_MODELS_FETCH 入参形状（确定性代码校验，非法直接 INVALID_PARAMS）。 */
function parseModelsFetchInput(input: unknown): ProviderModelsFetchSpec | null {
  if (!input || typeof input !== 'object') return null;
  const spec = input as Record<string, unknown>;
  if (typeof spec.agent !== 'string' || !VALID_AGENTS.includes(spec.agent)) return null;
  if (
    typeof spec.authMethod !== 'string'
    || !VALID_ADHOC_AUTH_METHODS.includes(spec.authMethod)
  ) return null;
  if (typeof spec.baseUrl !== 'string' || spec.baseUrl.length === 0) return null;
  const httpUrlOk = (v: string): boolean => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  };
  if (!httpUrlOk(spec.baseUrl)) return null;
  if (spec.modelsUrl !== undefined && spec.modelsUrl !== null) {
    if (typeof spec.modelsUrl !== 'string' || !httpUrlOk(spec.modelsUrl)) return null;
  }
  if (
    spec.authMethod === 'none'
    && (
      !isLoopbackProviderUrl(spec.baseUrl)
      || (
        typeof spec.modelsUrl === 'string'
        && spec.modelsUrl.trim().length > 0
        && !isLoopbackProviderUrl(spec.modelsUrl)
      )
    )
  ) return null;
  if (spec.apiKey !== undefined && spec.apiKey !== null && typeof spec.apiKey !== 'string') return null;
  if (spec.wireProtocol !== undefined) {
    const allowed = spec.agent === 'claude-code'
      ? ['anthropic-messages']
      : ['openai-responses', 'openai-chat', 'anthropic-messages'];
    if (typeof spec.wireProtocol !== 'string' || !allowed.includes(spec.wireProtocol)) return null;
  }
  if (spec.headers !== undefined) {
    if (!spec.headers || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) return null;
    if (Object.values(spec.headers as Record<string, unknown>).some((v) => typeof v !== 'string')) return null;
  }
  return {
    agent: spec.agent as AgentKind,
    baseUrl: spec.baseUrl,
    authMethod: spec.authMethod as ProviderModelsFetchSpec['authMethod'],
    modelsUrl: (spec.modelsUrl as string | null | undefined) ?? null,
    apiKey: (spec.apiKey as string | null | undefined) ?? null,
    headers: spec.headers as Record<string, string> | undefined,
    ...(typeof spec.wireProtocol === 'string'
      ? { wireProtocol: spec.wireProtocol as ProviderModelsFetchSpec['wireProtocol'] }
      : {}),
  };
}

export function registerProviderHandlers(
  registry: IpcHandlerRegistry,
  deps: ProviderHandlerDeps,
): void {
  const oauthMutationGeneration = new Map<string, symbol>();
  const beginOAuthMutation = (providerId: string): symbol => {
    // Unique token avoids ABA when a completed entry is deleted and the same provider starts again.
    const generation = Symbol(providerId);
    oauthMutationGeneration.set(providerId, generation);
    return generation;
  };
  const isOAuthMutationCurrent = (providerId: string, generation: symbol): boolean =>
    oauthMutationGeneration.get(providerId) === generation;
  const finishOAuthMutation = (providerId: string, generation: symbol): void => {
    if (isOAuthMutationCurrent(providerId, generation)) {
      oauthMutationGeneration.delete(providerId);
    }
  };
  type ProviderOAuthOwner = {
    providerId: string;
    generation: symbol;
    sender: ProviderOAuthRendererSender;
  };
  const providerOAuthOwners = new Map<string, ProviderOAuthOwner>();
  const providerOAuthSenderOwners = new Map<
    ProviderOAuthRendererSender,
    { ownerIds: Set<string>; onDestroyed: () => void }
  >();
  const removeProviderOAuthOwner = (
    ownerId: string,
    expectedSender?: ProviderOAuthRendererSender,
    expectedOwner?: ProviderOAuthOwner,
  ): ProviderOAuthOwner | null => {
    const owner = providerOAuthOwners.get(ownerId);
    if (
      !owner
      || (expectedSender && owner.sender !== expectedSender)
      || (expectedOwner && owner !== expectedOwner)
    ) {
      return null;
    }
    providerOAuthOwners.delete(ownerId);
    const subscription = providerOAuthSenderOwners.get(owner.sender);
    subscription?.ownerIds.delete(ownerId);
    if (subscription && subscription.ownerIds.size === 0) {
      owner.sender.removeListener?.('destroyed', subscription.onDestroyed);
      providerOAuthSenderOwners.delete(owner.sender);
    }
    return owner;
  };
  const cancelOwnedProviderOAuth = (owner: ProviderOAuthOwner): void => {
    if (!isOAuthMutationCurrent(owner.providerId, owner.generation)) return;
    const cancellationGeneration = beginOAuthMutation(owner.providerId);
    try {
      deps.oauthCancel(owner.providerId);
    } catch (err) {
      log.warn('failed to cancel owned provider OAuth login during teardown', {
        providerId: owner.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      finishOAuthMutation(owner.providerId, cancellationGeneration);
    }
  };
  const handleProviderOAuthRendererDestroyed = (
    sender: ProviderOAuthRendererSender,
  ): void => {
    const subscription = providerOAuthSenderOwners.get(sender);
    if (!subscription) return;
    for (const ownerId of [...subscription.ownerIds]) {
      const owner = removeProviderOAuthOwner(ownerId, sender);
      if (owner) cancelOwnedProviderOAuth(owner);
    }
  };
  const registerProviderOAuthOwner = (
    providerId: string,
    generation: symbol,
    sender: ProviderOAuthRendererSender,
    ownerId: string,
  ): ProviderOAuthOwner => {
    if (providerOAuthOwners.has(ownerId)) {
      throwIpcError('INVALID_PARAMS', 'ownerId is already bound to another OAuth operation');
    }
    let subscription = providerOAuthSenderOwners.get(sender);
    if (!subscription) {
      const onDestroyed = (): void => handleProviderOAuthRendererDestroyed(sender);
      subscription = { ownerIds: new Set(), onDestroyed };
      providerOAuthSenderOwners.set(sender, subscription);
      sender.once?.('destroyed', onDestroyed);
    }
    const owner = { providerId, generation, sender };
    subscription.ownerIds.add(ownerId);
    providerOAuthOwners.set(ownerId, owner);
    return owner;
  };
  const clearProviderOAuthOwners = (providerId: string): void => {
    for (const [ownerId, owner] of [...providerOAuthOwners]) {
      if (owner.providerId === providerId) removeProviderOAuthOwner(ownerId);
    }
  };
  const providerConfigMutationCounts = new Map<string, number>();
  const providerConfigMutationTails = new Map<string, Promise<void>>();
  const beginProviderConfigMutation = (providerId: string): void => {
    providerConfigMutationCounts.set(
      providerId,
      (providerConfigMutationCounts.get(providerId) ?? 0) + 1,
    );
  };
  const finishProviderConfigMutation = (providerId: string): void => {
    const remaining = (providerConfigMutationCounts.get(providerId) ?? 1) - 1;
    if (remaining <= 0) providerConfigMutationCounts.delete(providerId);
    else providerConfigMutationCounts.set(providerId, remaining);
  };
  const withProviderConfigMutation = async <T>(
    providerId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const finishRouteMutation = deps.beginRouteMutation(providerId);
    const previous = providerConfigMutationTails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    providerConfigMutationTails.set(providerId, tail);
    // 排队时即计入 mutation，避免等待前序写入期间启动新的 OAuth flow。
    beginProviderConfigMutation(providerId);
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      release();
      if (providerConfigMutationTails.get(providerId) === tail) {
        providerConfigMutationTails.delete(providerId);
      }
      finishProviderConfigMutation(providerId);
      finishRouteMutation();
    }
  };
  type KeySnapshot = { agent: AgentKind; previous: string | null };
  type KeyMutation = { agent: AgentKind; replacement: string | null };
  const restoreProviderKeys = (
    providerId: string,
    snapshots: readonly KeySnapshot[],
  ): boolean => {
    let restored = true;
    for (const { agent, previous } of [...snapshots].reverse()) {
      if (previous !== null) {
        if (!deps.storeCustomProviderKey(providerId, agent, previous)) restored = false;
      } else if (!deps.removeCustomProviderKey(providerId, agent).success) {
        restored = false;
      }
    }
    return restored;
  };
  const planProviderKeyMutations = (
    config: CustomProviderConfig,
    keys: RuntimeKeys,
    mode: 'create' | 'update',
  ): KeyMutation[] => {
    const mutations: KeyMutation[] = [];
    const usesApiKey = !config.auth || config.auth.method === 'apiKey';
    for (const agent of VALID_AGENTS as readonly AgentKind[]) {
      const replacement = keys[agent]?.trim();
      if (mode === 'create') {
        if (usesApiKey && config.runtimes[agent] && replacement) {
          mutations.push({ agent, replacement });
        }
        continue;
      }
      const shouldRemove = !usesApiKey || !config.runtimes[agent];
      if (shouldRemove) mutations.push({ agent, replacement: null });
      else if (replacement) mutations.push({ agent, replacement });
    }
    return mutations;
  };
  const stageProviderKeys = (
    providerId: string,
    mutations: readonly KeyMutation[],
  ): KeySnapshot[] => {
    const snapshots: KeySnapshot[] = [];
    try {
      for (const { agent, replacement } of mutations) {
        let previous: string | null;
        try {
          previous = deps.readCustomProviderKeyForMutation(providerId, agent);
        } catch {
          throwIpcError('INTERNAL', `failed to read existing ${agent} provider credential`);
        }
        snapshots.push({ agent, previous });
        const succeeded = replacement === null
          ? deps.removeCustomProviderKey(providerId, agent).success
          : deps.storeCustomProviderKey(providerId, agent, replacement);
        if (!succeeded) {
          throwIpcError('INTERNAL', `failed to update ${agent} provider credential`);
        }
      }
      return snapshots;
    } catch (error) {
      if (!restoreProviderKeys(providerId, snapshots)) {
        throwIpcError('INTERNAL', 'provider credential update failed and could not be rolled back');
      }
      throw error;
    }
  };

  // 只读聚合：loadCatalog 永不抛（最差回退内置目录），故无需 throwIpcError 包裹。
  registry.handle(
    MAKER_INVOKE.PROVIDER_LIST,
    async (
      event,
    ): Promise<{
      providers: ProviderView[];
      modelVisibilityOverrides: Record<string, boolean>;
    }> => {
      // 只有本机主页面能顺带触发绑定自愈与清单拉取:这条通道也服务 device-link(合成
      // event)和可能不受信的渲染上下文,它们只该拿到只读快照(PR #548 review)。
      const allowSideEffects = deps.isTrustedSender?.(event) === true;
      const providers = await deps.listProviders({ allowSideEffects });
      return { providers, modelVisibilityOverrides: deps.getModelVisibilityOverrides() };
    },
  );

  registry.handle(
    MAKER_INVOKE.PROVIDER_MODELS_REFRESH,
    async (event, providerId: unknown): Promise<ProviderModelRefreshResult> => {
      assertTrustedProviderMutationSender(event);
      if (!isBuiltinRefreshableProviderId(providerId)) {
        throwIpcError(
          'INVALID_PARAMS',
          `providerId must be one of: ${BUILTIN_REFRESHABLE_PROVIDER_IDS.join(', ')}`,
        );
      }
      try {
        await deps.refreshBuiltinModels(providerId);
      } catch (err) {
        if (isIpcError(err)) throw err;
        log.warn('built-in provider model refresh failed', {
          providerId,
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', `model list refresh failed for '${providerId}'`);
      }
      return { ok: true, providerId };
    },
  );

  registry.handle(
    MAKER_INVOKE.PROVIDER_MODELS_AUTO_REFRESH,
    async (event, trigger: unknown): Promise<ProviderModelAutoRefreshResult> => {
      assertTrustedProviderMutationSender(event);
      if (!isProviderModelAutoRefreshRendererTrigger(trigger)) {
        throwIpcError(
          'INVALID_PARAMS',
          `trigger must be one of: ${PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS.join(', ')}`,
        );
      }
      await deps.requestModelsAutoRefresh(trigger);
      return { ok: true };
    },
  );

  // CRUD 成功后统一收尾：刷新 active-catalog + 广播。
  async function afterChange(): Promise<void> {
    await deps.refreshCatalog();
    deps.broadcastChanged();
  }

  function assertTrustedProviderMutationSender(event: unknown): void {
    if (!deps.assertTrustedSender) {
      throwIpcError('PERMISSION_DENIED', 'sender trust guard unavailable');
    }
    deps.assertTrustedSender(event);
  }

  // 「模型 / 供应商停用」override 写入。设置类写操作:仅本机主页面可调(device-link
  // 合成 event 与不受信 frame 一律拒绝 —— 远程改被控端全局设置越权);守卫缺席按拒绝
  // 处理(assertTrustedProviderMutationSender)。写的是 main 侧持久化 override,目录
  // 本身没变,**不**走 refreshCatalog,只广播 PROVIDER_CHANGED 让各端重拉视图。
  // 入参尺寸上限:本通道会把内容同步序列化落盘(model-disable-prefs.json),sender 守卫
  // 挡不住 Cindy 自身主页面被 XSS 的情形 —— 超长 id / 超大数组必须在边界拒绝,防止
  // 拖死 main 或往磁盘灌垃圾、预埋不存在的目录 id(PR #744 review)。上限取目录现实
  // 规模的宽裕倍数:单 id ≤256 字符(目录 id 实际 <64),一次 ≤512 个模型 id。
  const MAX_DISABLE_ID_LENGTH = 256;
  const MAX_DISABLE_MODEL_IDS = 512;
  // 写入全局串行队列:成员校验里的 listProviders() 是异步的,并发放行时先到的「停用」
  // 可能在校验等待期间被后到的「启用」(恢复 = 删条目,无目录校验、不等待)超车,
  // 落盘顺序反转 = 用户最后一次操作被更早的请求覆盖(PR #744 review 第五轮)。
  // 同步形状校验留在队列外(到达序执行,非法入参不占队列);写操作稀疏且轻,全局
  // 单队列足够,不需要 per-provider 粒度。
  let modelDisableMutationTail: Promise<unknown> = Promise.resolve();
  // 所有 override 写入(停用/启用/删除清理/失败恢复)共用同一串行队列:删除事务的
  // 清理若绕开队列,在途的停用写(等 listProviders 校验)可能在清理之后落盘,同 id
  // 重建照旧复活旧停用状态(PR #744 review 第二十一轮)。
  const enqueueDisableWrite = <T,>(run: () => T | Promise<T>): Promise<T> => {
    const previous = modelDisableMutationTail;
    const result = previous.catch(() => undefined).then(run);
    modelDisableMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  registry.handle(MAKER_INVOKE.MODEL_DISABLE_SET, async (event, input: unknown) => {
    assertTrustedProviderMutationSender(event);
    if (!input || typeof input !== 'object') throwIpcError('INVALID_PARAMS', 'invalid input');
    const i = input as Record<string, unknown>;
    if (
      typeof i.providerId !== 'string' ||
      i.providerId.length === 0 ||
      i.providerId.length > MAX_DISABLE_ID_LENGTH
    ) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    if (i.kind !== 'model' && i.kind !== 'provider' && i.kind !== 'reset') {
      throwIpcError('INVALID_PARAMS', 'kind must be "model", "provider" or "reset"');
    }
    // reset = 删除整组 override(恢复默认),无 disabled 语义;其余两种必须显式带方向。
    if (i.kind !== 'reset' && typeof i.disabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'disabled required');
    }
    if (
      i.kind === 'model' &&
      (!Array.isArray(i.modelIds) ||
        i.modelIds.length === 0 ||
        i.modelIds.length > MAX_DISABLE_MODEL_IDS ||
        i.modelIds.some(
          (id) => typeof id !== 'string' || id.length === 0 || id.length > MAX_DISABLE_ID_LENGTH,
        ))
    ) {
      throwIpcError('INVALID_PARAMS', 'modelIds must be a bounded non-empty string[]');
    }
    // 目录成员校验(仅 disabled=true 的写入):落盘的是无界 key-value 文件,尺寸校验挡
    // 不住「合法长度但不存在的 id」被批量预埋。停用必须指向当前目录里真实存在的
    // provider / model(chat 各 agent 清单 ∪ imageModels ∪ videoModels);恢复启用是
    // 删条目,故意不校验 —— 目录漂移后用户仍能清掉指向已下架 id 的陈旧 override。
    const requireCatalogProvider = async (providerId: string): Promise<ProviderView> => {
      const provider = (await deps.listProviders()).find((p) => p.id === providerId);
      if (!provider) throwIpcError('INVALID_PARAMS', `unknown providerId "${providerId}"`);
      return provider;
    };
    // 落盘异常统一转结构化 INTERNAL:userData 只读 / 磁盘满等原始 fs 错误可能带内部
    // 绝对路径,不过 IPC 边界;原文只进 main 日志(PR #744 review 第五轮)。
    const persist = (write: () => void): void => {
      try {
        write();
      } catch (err) {
        log.warn('model disable override persist failed', {
          providerId: i.providerId,
          kind: i.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        throwIpcError('INTERNAL', 'failed to persist model disable override');
      }
    };
    // 归属捕获:store 路径按账号分目录且在 run() 执行时才解析,队列排队 + 目录校验
    // 的 await 窗口内切账号会把 A 的点击写进 B 的偏好 —— 持久化前复核,变了就拒
    // (PR #744 review 第七轮)。
    const ownerAtIngress = deps.currentOwnerId?.() ?? null;
    const assertSameOwner = (): void => {
      if (deps.currentOwnerId && (deps.currentOwnerId() ?? null) !== ownerAtIngress) {
        throwIpcError('INTERNAL', 'active account changed before persisting model disable override');
      }
    };
    const run = async () => {
      if (i.kind === 'reset') {
        // 恢复默认 = 删除该供应商整组 override(含指向已下架模型的陈旧条目)。删除
        // 与「恢复启用」同语义,故意不做目录成员校验 —— 目录漂移后也要能清干净
        // (configuration-and-overrides.md §4;PR #744 review 第二十四轮)。
        if (!deps.clearProviderDisableOverrides) {
          throwIpcError('INTERNAL', 'disable override reset is not wired');
        }
        assertSameOwner();
        persist(() => deps.clearProviderDisableOverrides?.(i.providerId as string));
        deps.broadcastChanged();
        return { ok: true };
      }
      if (i.kind === 'model') {
        const modelIds = i.modelIds as string[];
        if (i.disabled) {
          const provider = await requireCatalogProvider(i.providerId as string);
          const known = new Set<string>();
          for (const list of Object.values(provider.models)) {
            for (const m of list ?? []) known.add(m.id);
          }
          for (const m of provider.imageModels ?? []) known.add(m.id);
          for (const m of provider.videoModels ?? []) known.add(m.id);
          const unknown = modelIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throwIpcError(
              'INVALID_PARAMS',
              `unknown modelIds for provider "${i.providerId}": ${unknown.slice(0, 5).join(', ')}`,
            );
          }
        }
        assertSameOwner();
        persist(() => deps.setModelsDisabled(i.providerId as string, modelIds, i.disabled as boolean));
      } else {
        if (i.disabled) await requireCatalogProvider(i.providerId as string);
        assertSameOwner();
        persist(() => deps.setProviderDisabled(i.providerId as string, i.disabled as boolean));
      }
      deps.broadcastChanged();
      return { ok: true };
    };
    return enqueueDisableWrite(run);
  });

  const parsePriceTarget = (value: unknown): ModelPriceOverrideTarget => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throwIpcError('INVALID_PARAMS', 'price override target must be an object');
    }
    const target = value as Record<string, unknown>;
    if (
      typeof target.providerId !== 'string' ||
      target.providerId.length === 0 ||
      target.providerId.length > MAX_DISABLE_ID_LENGTH ||
      !VALID_AGENTS.includes(String(target.agent)) ||
      typeof target.modelId !== 'string' ||
      target.modelId.length === 0 ||
      target.modelId.length > MAX_DISABLE_ID_LENGTH
    ) {
      throwIpcError('INVALID_PARAMS', 'invalid price override target');
    }
    return {
      providerId: target.providerId,
      agent: target.agent as AgentKind,
      modelId: target.modelId,
    };
  };
  const parseDesiredPrice = (value: unknown): ModelPriceOverrideDesiredQuote => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throwIpcError('INVALID_PARAMS', 'price override quote must be an object');
    }
    const quote = value as Record<string, unknown>;
    const validNumber = (candidate: unknown): candidate is number =>
      typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0;
    const validNullableNumber = (candidate: unknown): boolean =>
      candidate === undefined || candidate === null || validNumber(candidate);
    if (
      (quote.currency !== 'USD' && quote.currency !== 'CNY') ||
      !validNumber(quote.inputPerMtok) ||
      !validNumber(quote.outputPerMtok) ||
      !validNullableNumber(quote.cacheReadPerMtok) ||
      !validNullableNumber(quote.cacheCreatePerMtok)
    ) {
      throwIpcError('INVALID_PARAMS', 'invalid price override quote');
    }
    return {
      currency: quote.currency,
      inputPerMtok: quote.inputPerMtok,
      outputPerMtok: quote.outputPerMtok,
      ...(quote.cacheReadPerMtok === null || validNumber(quote.cacheReadPerMtok)
        ? { cacheReadPerMtok: quote.cacheReadPerMtok }
        : {}),
      ...(quote.cacheCreatePerMtok === null || validNumber(quote.cacheCreatePerMtok)
        ? { cacheCreatePerMtok: quote.cacheCreatePerMtok }
        : {}),
    };
  };
  const requirePriceTargetModel = async (
    target: ModelPriceOverrideTarget,
  ): Promise<ProviderView> => {
    const provider = (await deps.listProviders({ allowSideEffects: false }))
      .find((candidate) => candidate.id === target.providerId);
    const known = provider?.models[target.agent]?.some((model) => model.id === target.modelId);
    if (!provider || !known) {
      throwIpcError('INVALID_PARAMS', 'price override target is not in the active catalog');
    }
    return provider;
  };
  let priceMutationTail: Promise<unknown> = Promise.resolve();
  const enqueuePriceMutation = <T,>(run: () => T | Promise<T>): Promise<T> => {
    const result = priceMutationTail.catch(() => undefined).then(run);
    priceMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  registry.handle(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_GET, async (event, input: unknown) => {
    assertTrustedProviderMutationSender(event);
    const target = parsePriceTarget(input);
    await requirePriceTargetModel(target);
    return deps.readModelPriceOverride(target);
  });

  registry.handle(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_SET, async (event, targetInput: unknown, quoteInput: unknown) => {
    assertTrustedProviderMutationSender(event);
    const target = parsePriceTarget(targetInput);
    const desired = parseDesiredPrice(quoteInput);
    if (target.providerId === 'xd') {
      throwIpcError('INVALID_PARAMS', 'Cindy AI Gateway pricing is server-controlled');
    }
    if (desired.currency === 'CNY' && deps.getLedgerCurrency() === 'USD') {
      throwIpcError('INVALID_PARAMS', 'CNY price overrides cannot project into a USD ledger');
    }
    const ownerAtIngress = deps.currentOwnerId?.() ?? null;
    return withProviderConfigMutation(target.providerId, () =>
      enqueuePriceMutation(async () => {
        await requirePriceTargetModel(target);
        if (deps.currentOwnerId && (deps.currentOwnerId() ?? null) !== ownerAtIngress) {
          throwIpcError('INTERNAL', 'active account changed before persisting price override');
        }
        try {
          deps.writeModelPriceOverride(target, desired);
        } catch (err) {
          log.warn('model price override persist failed', {
            providerId: target.providerId,
            agent: target.agent,
            modelId: target.modelId,
            error: err instanceof Error ? err.message : String(err),
          });
          throwIpcError('INTERNAL', 'failed to persist model price override');
        }
        deps.broadcastPricingChanged();
        return deps.readModelPriceOverride(target);
      }),
    );
  });

  registry.handle(MAKER_INVOKE.MODEL_PRICE_OVERRIDE_RESET, async (event, input: unknown) => {
    assertTrustedProviderMutationSender(event);
    const target = parsePriceTarget(input);
    const ownerAtIngress = deps.currentOwnerId?.() ?? null;
    return withProviderConfigMutation(target.providerId, () =>
      enqueuePriceMutation(async () => {
        if (deps.currentOwnerId && (deps.currentOwnerId() ?? null) !== ownerAtIngress) {
          throwIpcError('INTERNAL', 'active account changed before resetting price override');
        }
        try {
          deps.clearModelPriceOverride(target);
        } catch (err) {
          log.warn('model price override reset failed', {
            providerId: target.providerId,
            agent: target.agent,
            modelId: target.modelId,
            error: err instanceof Error ? err.message : String(err),
          });
          throwIpcError('INTERNAL', 'failed to reset model price override');
        }
        deps.broadcastPricingChanged();
        return deps.readModelPriceOverride(target);
      }),
    );
  });

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, async (event, input: unknown, keyInput?: unknown) => {
    assertTrustedProviderMutationSender(event);
    const v = validateCustomProviderConfig(input);
    if (!v.ok) throwIpcError(v.code, v.message);
    const keys = parseRuntimeKeys(keyInput);
    if (!keys) throwIpcError('INVALID_PARAMS', 'invalid provider runtime keys');
    const config = input as CustomProviderConfig;
    return withProviderConfigMutation(config.id, async () => {
      if (await customProviderExists(config.id)) {
        throwIpcError('ALREADY_EXISTS', `custom provider '${config.id}' already exists`);
      }
      const keySnapshots = stageProviderKeys(
        config.id,
        planProviderKeyMutations(config, keys, 'create'),
      );
      try {
        await createCustomProvider(config);
      } catch (error) {
        if (!restoreProviderKeys(config.id, keySnapshots)) {
          throwIpcError(
            'INTERNAL',
            'provider creation failed and credentials could not be rolled back',
          );
        }
        throw error;
      }
      await afterChange();
      return { ok: true };
    });
  });

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, async (event, input: unknown, keyInput?: unknown) => {
    assertTrustedProviderMutationSender(event);
    const v = validateCustomProviderConfig(input);
    if (!v.ok) throwIpcError(v.code, v.message);
    const keys = parseRuntimeKeys(keyInput);
    if (!keys) throwIpcError('INVALID_PARAMS', 'invalid provider runtime keys');
    const config = input as CustomProviderConfig;
    return withProviderConfigMutation(config.id, async () => {
      let generation: symbol | null = null;
      try {
        const previous = await getCustomProvider(config.id);
        if (!previous) throwIpcError('NOT_FOUND', `custom provider '${config.id}' not found`);
        // 即便 OAuth 描述符没变，runtime / model 编辑也必须让旧登录尾部的自动发现失效，
        // 否则旧 endpoint 的迟到结果可能合并进刚保存的新配置。
        generation = beginOAuthMutation(config.id);
        const shouldResetOAuth =
          config.auth?.method !== 'oauth'
          || oauthDescriptorSignature(previous) !== oauthDescriptorSignature(config);
        // API key 的写 / 删与配置更新处于同一 main 队列；若后续 OAuth 清理或 DB 写失败，
        // 用原值回滚，确保并发窗口不能把另一份配置和密钥拼在一起。
        const keySnapshots = stageProviderKeys(
          config.id,
          planProviderKeyMutations(config, keys, 'update'),
        );
        // 先阻止在途 flow 写回，再改描述符；否则旧 flow 可能在 clear 后迟到落一枚旧 token。
        if (shouldResetOAuth) deps.oauthCancel(config.id);
        // 旧 client / endpoint 下签发的 token 不能沿用到新 OAuth 描述符；切到 API key /
        // 无鉴权时也清掉不再可达的 blob。删除失败时必须在配置变更前中止，避免重启后
        // 旧 token 被新 client / endpoint 重新激活。
        let restoreOAuthCredentials: (() => boolean) | null = null;
        let updated: CustomProviderConfig | null;
        try {
          if (shouldResetOAuth) {
            restoreOAuthCredentials = deps.removeOAuthCredentials(config.id);
            if (!restoreOAuthCredentials) {
              throwIpcError('INTERNAL', 'failed to remove existing OAuth credentials');
            }
          }
          updated = await updateCustomProvider(config.id, config);
        } catch (err) {
          const oauthRestored = !restoreOAuthCredentials || restoreOAuthCredentials();
          const keysRestored = restoreProviderKeys(config.id, keySnapshots);
          if (!oauthRestored || !keysRestored) {
            throwIpcError(
              'INTERNAL',
              'provider update failed and existing credentials could not be restored',
            );
          }
          throw err;
        }
        if (!updated) {
          const oauthRestored = !restoreOAuthCredentials || restoreOAuthCredentials();
          const keysRestored = restoreProviderKeys(config.id, keySnapshots);
          if (!oauthRestored || !keysRestored) {
            throwIpcError(
              'INTERNAL',
              'provider disappeared during update and existing credentials could not be restored',
            );
          }
          throwIpcError('NOT_FOUND', `custom provider '${config.id}' not found`);
        }
        await afterChange();
        return { ok: true };
      } finally {
        if (generation !== null) finishOAuthMutation(config.id, generation);
      }
    });
  });

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, async (event, providerId: unknown) => {
    assertTrustedProviderMutationSender(event);
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    return withProviderConfigMutation(providerId, async () => {
      const generation = beginOAuthMutation(providerId);
      try {
        deps.oauthCancel(providerId);
        const keySnapshots = stageProviderKeys(
          providerId,
          (VALID_AGENTS as readonly AgentKind[]).map((agent) => ({
            agent,
            replacement: null,
          })),
        );
        // OAuth 形态自定义供应商的凭证 blob 一并清掉（apiKey 形态无 blob，幂等无害）。
        let restoreOAuthCredentials: (() => boolean) | null = null;
        let restoreDisableOverrides: (() => boolean) | null = null;
        let restorePriceOverrides: (() => boolean) | null = null;
        // 整个删除事务(清 override → 删凭证 → 删配置 → 刷目录)在 disable 写队列**内**
        // 执行,持队列直到 afterChange 刷完 active-catalog:只把清理入队的话,清理落盘
        // 后队列即释放,「删除完成前」的窗口里并发 MODEL_DISABLE_SET 仍能从未刷新的
        // listProviders() 里找到该 provider、预埋新 override,同 id 重建照旧复活停用
        // 状态。整体持锁后,并发写会排到目录刷新之后,成员校验自然拒绝
        // (PR #744 review 第二十二轮)。队列内不得再调 enqueueDisableWrite(自等死锁),
        // 清理与恢复都直接调用。
        await enqueueDisableWrite(async () => {
          try {
            // 停用 override 清理进事务(第二十轮):放在配置删除之前,后续任一步失败
            // 由恢复函数把停用状态原样写回;清理自身抛错时事务未产生破坏,删除中止,
            // 不再出现「配置删了、override 残留」让同 id 重建复活旧停用状态。
            restoreDisableOverrides =
              deps.stageClearProviderDisableOverrides?.(providerId) ?? null;
            restorePriceOverrides =
              deps.stageClearProviderModelPriceOverrides?.(providerId) ?? null;
            restoreOAuthCredentials = deps.removeOAuthCredentials(providerId);
            if (!restoreOAuthCredentials) {
              throwIpcError('INTERNAL', 'failed to remove existing OAuth credentials');
            }
            await deleteCustomProvider(providerId);
          } catch (err) {
            const overridesRestored = !restoreDisableOverrides || restoreDisableOverrides();
            const pricesRestored = !restorePriceOverrides || restorePriceOverrides();
            const oauthRestored = !restoreOAuthCredentials || restoreOAuthCredentials();
            const keysRestored = restoreProviderKeys(providerId, keySnapshots);
            if (!oauthRestored || !keysRestored || !overridesRestored || !pricesRestored) {
              throwIpcError(
                'INTERNAL',
                'provider deletion failed and existing credentials could not be restored',
              );
            }
            throw err;
          }
          // 刷目录也在队列内:队列释放的那一刻 listProviders() 必须已看不到该
          // provider。afterChange 失败时配置已删,凭证/override 不回写(与改动前
          // 语义一致 —— 恢复只覆盖删除本身失败的场景)。
          await afterChange();
          deps.broadcastPricingChanged();
        });
        return { ok: true };
      } finally {
        finishOAuthMutation(providerId, generation);
      }
    });
  });

  // 只读：目录 presets 段（创建对话框「从模板创建」消费）。
  registry.handle(
    MAKER_INVOKE.PROVIDER_PRESETS_LIST,
    async (): Promise<{ presets: ProviderPreset[] }> => ({ presets: deps.listPresets() }),
  );

  // 测试连接：查询型结构化返回（规则 13 例外条款——renderer 需要 code 渲染分类文案）。
  // 入参非法 / saved 解析失败（供应商不存在等）仍走 throwIpcError。
  registry.handle(MAKER_INVOKE.PROVIDER_TEST_CONNECTION, async (_event, input: unknown) => {
    const parsed = parseTestInput(input);
    if (!parsed) throwIpcError('INVALID_PARAMS', 'invalid test-connection input');
    try {
      return await deps.testConnection(parsed);
    } catch (err) {
      // resolveSavedProbeSpec 的解析错误（provider 不存在 / 无该 runtime）→ INVALID_PARAMS。
      throwIpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
    }
  });

  // 获取模型列表：查询型结构化返回（同上例外条款）；仅网络/上游失败在结果 code 里，不抛。
  registry.handle(MAKER_INVOKE.PROVIDER_MODELS_FETCH, async (event, input: unknown) => {
    // 这条查询会把 renderer 提供的 API key / 自定义 headers 带到目标 endpoint；
    // 与重新发现一样，必须先确认调用方是 Cindy 自有顶层页面，避免 WebView / 子 frame
    // 把 Main 变成可向任意 http(s) 地址发凭证请求的代理。
    assertTrustedProviderMutationSender(event);
    const parsed = parseModelsFetchInput(input);
    if (!parsed) throwIpcError('INVALID_PARAMS', 'invalid models-fetch input');
    return deps.fetchModels(parsed);
  });

  // 本机 CLI 扫描：查询型；任何失败降级空数组（检测建议是增强,不是功能依赖,
  // renderer 空列表即不显示建议区,规则 13 例外条款）。
  registry.handle(MAKER_INVOKE.PROVIDER_LOCAL_CLI_SCAN, async () => {
    try {
      return { detections: await deps.scanLocalCli() };
    } catch {
      return { detections: [] as LocalCliDetection[] };
    }
  });

  // 动态清单重新发现（用户在失败态下点「重试」）：查询型返回,把最新失败归因回给 renderer
  // 渲染分类文案;成功则 failure 缺席。
  //
  // 意外异常转 INTERNAL(规则 13:IPC 错误必须是结构化 IpcErrorCode)。发现流程内部只记账
  // 不抛穿,但那是多层实现细节共同保证的(缓存写入的 catch、广播收口的 catch);哪天有一层
  // 变了,裸 Error 会以非结构化形态漏给 renderer —— 在边界上收口一次,代价可忽略。
  //
  // **不**在这里广播:发现流程自己已经收口了两条路径 —— 成功经 active-catalog 的
  // markChanged、失败经 setAnthropicDiscoveryFailureListener,重复广播只会让 renderer 白
  // refetch 一次。
  registry.handle(MAKER_INVOKE.PROVIDER_MODELS_REDISCOVER, async (event, input: unknown) => {
    // sender 归属校验:这条通道会用订阅凭证发起真实上游请求并重启退避,不该被子 frame /
    // WebView 触发。经 deps 注入(生产 = assertTrustedAppRendererEvent),既保住本文件
    // 「不依赖 Electron、可用内存 registry 直测」的设计,又不让新通道继承既有缺口。
    //
    // 守卫缺席按拒绝处理:可选依赖用 `?.()` 调用时,漏接线会静默退化成「无守卫」,而这种
    // 退化没有任何编译期或运行期信号。宁可在接线回归时把功能打死,也不要让它悄悄敞开
    // (PR #548 review)。
    assertTrustedProviderMutationSender(event);
    const providerId = requireProviderId(input);
    let failure: ProviderModelDiscoveryFailure | null;
    try {
      failure = await deps.rediscoverModels(providerId);
    } catch (err) {
      // 原文只进 Main 日志:凭证读取 / token 刷新等依赖抛出的消息可能含内部路径或上游
      // 敏感文本,throwIpcError 只加结构化 code、不做脱敏,原样回传等于把它送给 renderer
      // (以及 device-link 对端)。renderer 只需要知道「失败了」——分类文案走 failure.kind。
      log.warn('rediscover models failed', {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      throwIpcError('INTERNAL', 'rediscover models failed');
    }
    // 与 buildRegistry 的投影同口径:detail 可能是上游原始响应体,不能过 IPC 边界。
    // 这是独立于 provider 列表的第二条返回路径,必须各自剥离(PR #548 review)。
    if (!failure) return { ok: true };
    const failureView = { ...failure };
    delete failureView.detail;
    return { ok: false, failure: failureView };
  });

  // 通用 OAuth 登录 / 登出 / 取消。login 是查询型返回（{ok, reason}——取消/超时是正常流程
  // 分支不是异常）；描述符缺失等配置错误由生产 deps 抛错 → INVALID_PARAMS。
  function requireProviderId(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    return input;
  }
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, async (
    event,
    providerId: unknown,
    rawOptions?: unknown,
  ) => {
    const id = requireProviderId(providerId);
    const { ownerId } = requireProviderOAuthLoginOptions(rawOptions);
    const sender = providerOAuthRendererSender(event);
    if (ownerId && !sender) {
      throwIpcError('INVALID_PARAMS', 'ownerId requires an Electron sender');
    }
    if (ownerId && providerOAuthOwners.has(ownerId)) {
      throwIpcError('INVALID_PARAMS', 'ownerId is already bound to another OAuth operation');
    }
    // 更新事务从旧配置读取、写库到 refresh 完成前是一个整体。期间拒绝新登录，避免 runner
    // 读取旧描述符后在新配置生效时写回旧 client / endpoint 签发的 token。
    if (providerConfigMutationCounts.has(id)) {
      return { ok: false, reason: 'provider_update_in_progress' };
    }
    const generation = beginOAuthMutation(id);
    let owner: ProviderOAuthOwner | null = null;
    try {
      if (ownerId && sender) {
        owner = registerProviderOAuthOwner(id, generation, sender, ownerId);
      }
      const result = await deps.oauthLogin(id, () => isOAuthMutationCurrent(id, generation));
      if (isOAuthMutationCurrent(id, generation)) {
        return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) };
      }
      if (result.ok && result.rollbackCredentials && !result.rollbackCredentials()) {
        throwIpcError('INTERNAL', 'failed to remove credentials from cancelled OAuth login');
      }
      return { ok: false, reason: 'login_cancelled' };
    } catch (err) {
      if (isIpcError(err)) throw err;
      throwIpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
    } finally {
      if (ownerId && owner) removeProviderOAuthOwner(ownerId, sender ?? undefined, owner);
      finishOAuthMutation(id, generation);
    }
  });
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_LOGOUT, async (_event, providerId: unknown) => {
    const id = requireProviderId(providerId);
    const generation = beginOAuthMutation(id);
    // Invalidate and stop an active flow immediately, then serialize credential deletion with
    // config CRUD so a failed earlier update cannot restore a token after this explicit logout.
    deps.oauthCancel(id);
    try {
      return await withProviderConfigMutation(id, async () => {
        try {
          await deps.oauthLogout(id);
          await afterChange();
          return { ok: true };
        } catch (err) {
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      });
    } finally {
      finishOAuthMutation(id, generation);
    }
  });
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_CANCEL, async (
    event,
    providerId: unknown,
    rawOptions?: unknown,
  ) => {
    const id = requireProviderId(providerId);
    const { releaseOwner, ownerId } = requireProviderOAuthCancelOptions(rawOptions);
    if (releaseOwner) {
      const sender = providerOAuthRendererSender(event);
      if (!sender) {
        throwIpcError('INVALID_PARAMS', 'owner release requires an Electron sender');
      }
      const expectedOwner = providerOAuthOwners.get(ownerId!);
      if (
        !expectedOwner
        || expectedOwner.sender !== sender
        || expectedOwner.providerId !== id
      ) {
        return { ok: true };
      }
      const owner = removeProviderOAuthOwner(ownerId!, sender, expectedOwner);
      if (owner) cancelOwnedProviderOAuth(owner);
      return { ok: true };
    }
    clearProviderOAuthOwners(id);
    const generation = beginOAuthMutation(id);
    try {
      deps.oauthCancel(id);
      return { ok: true };
    } finally {
      // Cancel is synchronous; retaining arbitrary renderer-supplied ids here would grow the map forever.
      finishOAuthMutation(id, generation);
    }
  });
}
