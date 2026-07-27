/**
 * provider:* IPC handlers。
 *
 *   - PROVIDER_LIST（只读：目录元数据 + 各供应商实时连接状态）。
 *   - PROVIDER_CUSTOM_CREATE / UPDATE / DELETE（自定义供应商**配置** CRUD，配置入 localDb）。
 *
 * 内置三家（Anthropic / OpenAI / XD）的「连接 / 断开」**复用各 agent 已有的鉴权通道**，不另立通道。
 * 自定义供应商用 CRUD 替代连接/断开。
 *
 * 密钥**不经这些 handler**：renderer 用通用 safe-storage IPC 写 `provider_key_<id>`（与
 * XdGatewayKeyDialog 同源），delete 时同样由 renderer 经通用 safe-storage-remove 清密钥。
 *
 * 副作用（CRUD 成功后刷新 active-catalog + 广播 PROVIDER_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import {
  isProviderRequestPath,
  type AgentKind,
  type CustomProviderConfig,
  type ProviderPreset,
  type ProviderView,
} from '@cindy/model-providers';

import type { LocalCliDetection } from '../../shared/localCliDetect.js';

import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createCustomProvider,
  customProviderExists,
  deleteCustomProvider,
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

const VALID_AGENTS: readonly string[] = ['claude-code', 'codex'];

export interface ProviderHandlerDeps {
  /** 当前供应商视图（含实时连接状态）；见 createDesktopProviderService。 */
  listProviders(): Promise<ProviderView[]>;
  /**
   * 「模型显示/隐藏」override 快照(renderer → main 镜像,生产 = getModelVisibilityMirrorSnapshot)。
   * PROVIDER_LIST 附带回传,供 device-link 控制端(手机)按被控端用户开关过滤模型列表;
   * key = `${agent}:${providerId}:${modelId}`,与 renderer modelVisibilityPrefs.keyOf 一致。
   */
  getModelVisibilityOverrides(): Record<string, boolean>;
  /** CRUD 成功后重算 active-catalog（生产 = refreshCustomProvidersIntoCatalog）。 */
  refreshCatalog(): Promise<void>;
  /** CRUD 成功后广播变更（生产 = 向所有窗口 send PROVIDER_CHANGED）。 */
  broadcastChanged(): void;
  /** 目录 presets 段（生产 = () => getActiveCatalog().presets ?? []）。 */
  listPresets(): ProviderPreset[];
  /** 测试连接（生产 = testProviderConnection；单测注入 stub 不联网）。 */
  testConnection(input: ProviderTestInput): Promise<ProviderTestResult>;
  /** 获取模型列表（生产 = fetchProviderModels；单测注入 stub 不联网）。 */
  fetchModels(spec: ProviderModelsFetchSpec): Promise<ProviderModelsFetchResult>;
  /**
   * 通用 OAuth 登录 / 登出 / 取消（生产接 generic-oauth Runner + 目录描述符解析；
   * login 成功后由生产 deps 负责模型发现与 PROVIDER_CHANGED 广播）。
   */
  oauthLogin(providerId: string): Promise<{ ok: boolean; reason?: string }>;
  oauthLogout(providerId: string): Promise<void>;
  oauthCancel(providerId: string): void;
  /** 删除自定义供应商时清理其 OAuth 凭证 blob（生产 = logoutGenericOAuth；幂等）。 */
  clearOAuthCredentials(providerId: string): void;
  /**
   * 本机 agent CLI 安装 / 登录态扫描(生产 = scanLocalCliAuth(createLocalCliScanDeps());
   * 单测注入 stub 不碰真实 home)。只 stat 不读内容(规则 23)。
   */
  scanLocalCli(): Promise<LocalCliDetection[]>;
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
    if (typeof spec.baseUrl !== 'string' || spec.baseUrl.length === 0) return null;
    try {
      const u = new URL(spec.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    if (typeof spec.modelId !== 'string' || spec.modelId.length === 0) return null;
    if (spec.apiKey !== undefined && spec.apiKey !== null && typeof spec.apiKey !== 'string') return null;
    if (spec.headers !== undefined) {
      if (!spec.headers || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) return null;
      if (Object.values(spec.headers as Record<string, unknown>).some((v) => typeof v !== 'string')) return null;
    }
    if (spec.wireProtocol !== undefined) {
      const allowed = spec.agent === 'claude-code'
        ? ['anthropic-messages']
        : ['openai-responses', 'openai-chat'];
      if (typeof spec.wireProtocol !== 'string' || !allowed.includes(spec.wireProtocol)) return null;
    }
    if (spec.requestPath !== undefined && !isProviderRequestPath(spec.requestPath)) return null;
    return {
      kind: 'adhoc',
      spec: {
        agent: spec.agent as AgentKind,
        baseUrl: spec.baseUrl,
        modelId: spec.modelId,
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
  if (spec.apiKey !== undefined && spec.apiKey !== null && typeof spec.apiKey !== 'string') return null;
  if (spec.headers !== undefined) {
    if (!spec.headers || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) return null;
    if (Object.values(spec.headers as Record<string, unknown>).some((v) => typeof v !== 'string')) return null;
  }
  return {
    agent: spec.agent as AgentKind,
    baseUrl: spec.baseUrl,
    modelsUrl: (spec.modelsUrl as string | null | undefined) ?? null,
    apiKey: (spec.apiKey as string | null | undefined) ?? null,
    headers: spec.headers as Record<string, string> | undefined,
  };
}

export function registerProviderHandlers(
  registry: IpcHandlerRegistry,
  deps: ProviderHandlerDeps,
): void {
  // 只读聚合：loadCatalog 永不抛（最差回退内置目录），故无需 throwIpcError 包裹。
  registry.handle(
    MAKER_INVOKE.PROVIDER_LIST,
    async (): Promise<{
      providers: ProviderView[];
      modelVisibilityOverrides: Record<string, boolean>;
    }> => {
      const providers = await deps.listProviders();
      return { providers, modelVisibilityOverrides: deps.getModelVisibilityOverrides() };
    },
  );

  // CRUD 成功后统一收尾：刷新 active-catalog + 广播。
  async function afterChange(): Promise<void> {
    await deps.refreshCatalog();
    deps.broadcastChanged();
  }

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_CREATE, async (_event, input: unknown) => {
    const v = validateCustomProviderConfig(input);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomProviderConfig;
    if (await customProviderExists(config.id)) {
      throwIpcError('ALREADY_EXISTS', `custom provider '${config.id}' already exists`);
    }
    await createCustomProvider(config);
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_UPDATE, async (_event, input: unknown) => {
    const v = validateCustomProviderConfig(input);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomProviderConfig;
    const updated = await updateCustomProvider(config.id, config);
    if (!updated) throwIpcError('NOT_FOUND', `custom provider '${config.id}' not found`);
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.PROVIDER_CUSTOM_DELETE, async (_event, providerId: unknown) => {
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    await deleteCustomProvider(providerId);
    // OAuth 形态自定义供应商的凭证 blob 一并清掉（apiKey 形态无 blob，幂等无害）。
    deps.clearOAuthCredentials(providerId);
    await afterChange();
    return { ok: true };
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

  // 获取模型列表：查询型结构化返回（同上例外条款）；网络/上游失败在结果 code 里，不抛。
  registry.handle(MAKER_INVOKE.PROVIDER_MODELS_FETCH, async (_event, input: unknown) => {
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

  // 通用 OAuth 登录 / 登出 / 取消。login 是查询型返回（{ok, reason}——取消/超时是正常流程
  // 分支不是异常）；描述符缺失等配置错误由生产 deps 抛错 → INVALID_PARAMS。
  function requireProviderId(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    return input;
  }
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_LOGIN, async (_event, providerId: unknown) => {
    const id = requireProviderId(providerId);
    try {
      return await deps.oauthLogin(id);
    } catch (err) {
      throwIpcError('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
    }
  });
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_LOGOUT, async (_event, providerId: unknown) => {
    await deps.oauthLogout(requireProviderId(providerId));
    await afterChange();
    return { ok: true };
  });
  registry.handle(MAKER_INVOKE.PROVIDER_OAUTH_CANCEL, async (_event, providerId: unknown) => {
    deps.oauthCancel(requireProviderId(providerId));
    return { ok: true };
  });
}
