/**
 * pi agent 的 desktop host 装配 —— auth / runtimeConfig / 二进制解析 / 构造,
 * 集中在本模块,maker-host/index.ts 只做一次 buildPiAgent() 调用。
 *
 * P0 范围(实验性,dev-first):
 *  - 凭证:按会话来源复用 Cindy AI / Claude.ai / ChatGPT / SuperGrok 既有连接态。
 *    pi 子进程只拿网关 key或无权限占位 key；订阅 OAuth 由本地 compat proxy
 *    从安全存储注入，models.json 不落任何真实订阅凭证。
 *  - endpoint:统一走 anthropic-compat-proxy。pi 说标准 Anthropic Messages，
 *    proxy 按 x-cindy-pi-session-id 读取会话来源；ChatGPT / Grok 由现有
 *    Responses bridge 翻译，Claude / Cindy AI 走透明 Anthropic 路由。
 *  - 二进制:与 cc/codex 同链 —— splash prepare 经 agent-binaries 按 CDN manifest
 *    的 pi 字段下载整目录 tar.gz 到 userData/pi/<version>/(SHA256 校验,清单一变
 *    下次启动即换新)。dev 期使用 apps/pi-bin 中 pnpm install:pi 的产物；正式版
 *    不内置 Pi，清单缺失或下载失败时 buildPiAgent 返回 null，本次不注册 pi，
 *    对 Cindy 启动零影响。
 */

import path from 'node:path';
import { app } from 'electron';

import { PiAgent, type AgentDeps, type AuthAdapter, type AuthState } from '@cindy/maker-core';
import type {
  AgentRuntimeConfig,
  AuthAdapterOptions,
  PiNativeApi,
  PiNativeProviderSpec,
  PiNativeProvidersResult,
} from '@cindy/maker-core';
import { PI_REASONING_EFFORTS } from '@cindy/model-providers';
import type { PiReasoningEffort, ProviderWireProtocol } from '@cindy/model-providers';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import { listCustomProvidersWithSecureHeaders } from './custom-provider-header-secrets.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { getClaudeEndpoint } from './anthropic-compat-proxy-host.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import { hasGrokOAuthLogin } from './grok-oauth-login.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import piSystemPrompt from './pi-system-prompt.md?raw';
import { createLogger } from '../logger.js';
import { readMemorySettings } from './memory-settings-store.js';
import { registerPiProxySession } from './pi-proxy-session-auth.js';
import { getDesktopMcpToolApprovalPolicy } from './mcp-tool-approval-policy.js';
import { getRipgrepBinaryPath } from './runtime-configs.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';

/**
 * 订阅 OAuth provider:网关 `cindy` 块经 compat proxy 用安全存储里的 OAuth 服务这些模型,
 * models.json 的 $CINDY_PI_API_KEY 只需占位(真凭证由 proxy 按 session-id 注入)。
 * 自定义 BYOM provider **不在此列** —— 它们走各自原生块 + 独立 key,而网关块仍需真网关 key
 * 以便会话中途切回网关模型可用,故 BYOM 会话不能写占位符毒化网关块。
 */
const PI_OAUTH_SUBSCRIPTION_PROVIDERS = new Set(['anthropic', 'openai', 'xai']);

/**
 * 解析 pi 主执行文件绝对路径;找不到返回 null(pi 为可选实验 agent,不阻塞启动)。
 * pi 产物是目录形态(主二进制 + theme/ 等运行时资产),路径指向其中的可执行文件。
 * 路径只来自 agent-binaries 受管链：正式版是 CDN 下载到 userData/pi/<version>/
 * 的已校验目录，dev 是 apps/pi-bin/<platform>/ 中 pnpm install:pi 的产物。
 */
export function resolvePiBinaryPath(): string | null {
  return getReadyBinaryPath('pi') ?? null;
}

// ── AuthAdapter(XD 网关 key)─────────────────────────────────────────────────

class DesktopPiAuthAdapter implements AuthAdapter {
  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    const providerId = options?.providerId?.trim() || null;
    if (providerId === 'anthropic') {
      return hasClaudeAiOAuth()
        ? { authenticated: true, identity: 'Claude.ai', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'anthropic_oauth_unavailable' };
    }
    if (providerId === 'openai') {
      return desktopCodexAuthAdapter.getState({ credentialMode: 'oauth-bearer' });
    }
    if (providerId === 'xai') {
      return hasGrokOAuthLogin()
        ? { authenticated: true, identity: 'SuperGrok', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'xai_oauth_unavailable' };
    }
    if (providerId) {
      try {
        const custom = (await listCustomProvidersWithSecureHeaders()).find(
          (provider) => provider.id === providerId && provider.runtimes.pi,
        );
        if (custom) {
          const method = custom.auth?.method ?? 'apiKey';
          if (method === 'none') {
            // AuthState 只有 oauth/api-key 两种“子进程凭证族”；keyless native provider
            // 归入 provider-key 族即可，实际 models.json 使用固定 dummy key。
            return { authenticated: true, identity: custom.name, authSource: 'api-key' };
          }
          if (method === 'apiKey') {
            const hasHeaderCredential = Object.keys(custom.runtimes.pi?.headers ?? {}).length > 0;
            return readCustomProviderKey(providerId, 'pi') || hasHeaderCredential
              ? { authenticated: true, identity: custom.name, authSource: 'api-key' }
              : { authenticated: false, errorReason: 'pi_native_api_key_unavailable' };
          }
          return { authenticated: false, errorReason: 'pi_native_oauth_unsupported' };
        }
      } catch (err) {
        log.warn('pi auth: custom provider lookup failed', {
          providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const key = readClaudeApiKey();
    if (!key) {
      return { authenticated: false, errorReason: 'cindy_gateway_key_unavailable' };
    }
    return { authenticated: true, identity: 'Cindy AI', authSource: 'api-key' };
  }

  async triggerLogin(): Promise<AuthState> {
    // pi 无独立登录面;网关 key 随 Cindy 账号凭据同步下发。
    return this.getState();
  }

  async logout(): Promise<void> {
    // 网关 key 生命周期归账号体系管,pi 侧无可清理凭证。
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    // 订阅 OAuth provider 用占位符(真凭证由 compat proxy 注入)。
    if (options?.providerId && PI_OAUTH_SUBSCRIPTION_PROVIDERS.has(options.providerId)) {
      return { [PI_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
    }
    const key = readClaudeApiKey();
    // 纯 BYOM 不依赖 Cindy 登录。models.json 始终包含 gateway `cindy` 块，Pi 启动
    // 会解析它，所以无网关 key 时给不可用占位值；当前原生 provider 使用独立 key。
    return { [PI_API_KEY_ENV]: key ?? PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
  }
}

export const desktopPiAuthAdapter: AuthAdapter = new DesktopPiAuthAdapter();

// ── RuntimeConfig ────────────────────────────────────────────────────────────

export function composePiSystemPrompt(hostPrompt: string, agentPrompt: string): string {
  return [hostPrompt, agentPrompt]
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function buildDesktopPiRuntimeConfig(): AgentRuntimeConfig {
  const ripgrepPath = getRipgrepBinaryPath();
  const config: AgentRuntimeConfig = {
    // 保留 host 共用身份段,再追加 Pi 专属行为段；maker-core 会整体追加到 Pi 原生 prompt。
    systemPrompt: composePiSystemPrompt(hostSystemPrompt, piSystemPrompt),
    // Pi 的 grep 以及 Cindy 覆盖的 find 都固定复用随 Desktop 校验、打包的 rg。
    // 下发绝对路径而非 PATH，避免 Windows 从不受信工作目录优先命中同名 rg.exe。
    managedExecutablePaths: { ripgrep: ripgrepPath },
    userDataPath: app.getPath('userData'),
  };
  // 网关 endpoint 随 model-access 凭据同步就绪,用 getter 惰性读(与 claude remoteEndpoint 同理)。
  Object.defineProperty(config, 'endpoint', {
    get: () => getClaudeEndpoint(),
    enumerable: true,
    configurable: false,
  });
  Object.defineProperties(config, {
    memoryEnabled: {
      get: () => readMemorySettings().pi,
      enumerable: true,
    },
    makerMemoryEnabled: {
      get: () => readMemorySettings().maker,
      enumerable: true,
    },
  });
  return config;
}

// ── 构造入口 ─────────────────────────────────────────────────────────────────

export interface BuildPiAgentOpts {
  logger: AgentDeps['logger'];
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  capabilityAdditions?: AgentDeps['capabilityAdditions'];
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'];
  /** Cindy MCP providers(与 claude/codex 同源工厂产物);经 HTTP bridge 暴露给 pi。 */
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
  resolvePiRuntimeModelDescriptor?: AgentDeps['resolvePiRuntimeModelDescriptor'];
  resolvePiGatewayModelDescriptor?: AgentDeps['resolvePiGatewayModelDescriptor'];
}

/** Cindy wire protocol → pi models.json api 形态。 */
function wireProtocolToPiApi(wp: ProviderWireProtocol | undefined): PiNativeApi {
  switch (wp) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
    case undefined:
    default:
      // 缺省 openai-completions:BYOM 本地端点(Ollama/vLLM 的 /v1/chat/completions)最常见。
      return 'openai-completions';
  }
}

/** env 变量名(该 provider 的 api key):CINDY_PI_KEY_<ID>,ID 规整成 [A-Z0-9_]。 */
export function piNativeKeyEnvVar(providerId: string): string {
  return `CINDY_PI_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * 纯映射:自定义 provider 配置(含 pi runtime)→ pi 原生 provider spec + env。
 * key 读取经 `readKey` 注入(便于单测)。规则:
 *  - 无 pi runtime → 跳过;
 *  - oauth 形态 → 跳过(pi models.json 仅支持 radius oauth,不通用);
 *  - apiKey 形态但 key / 自定义 headers 都没有 → 跳过(避免半可用);
 *  - none(keyless,本机 Ollama 等)→ apiKeyEnvVar 留空,models.json 写 dummy key;
 *  - 自定义 header 值全部搬进子进程 env,models.json 只保留 `$ENV` 引用。
 * 直连用户端点,不过 anthropic-compat 代理(设计原则:pi 主导,禁双重转义)。
 */
export function buildPiNativeProvidersFromConfigs(
  configs: Array<{
    id: string;
    name: string;
    auth?: { method?: string };
    runtimes: {
      pi?: {
        baseUrl: string;
        wireProtocol?: ProviderWireProtocol;
        headers?: Record<string, string>;
        models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          supportsImageInput?: boolean;
          reasoning?: boolean;
          reasoningEfforts?: PiReasoningEffort[];
        }>;
      };
    };
  }>,
  readKey: (providerId: string, agent: string) => string | null,
  onSkip?: (id: string, reason: string) => void,
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const env: Record<string, string> = {};
  // 派生 env 名去重:CINDY_PI_KEY_<ID> 会把 `-`/`_` 归一,不同合法 id(my-vllm / my_vllm)
  // 可能塌缩到同名 → 后写覆盖 → 一个 provider 的 key 被发往另一个端点(凭证串号)。撞名时
  // 追加 _2/_3 保证每个 provider 拿到独立 env 名。
  const usedEnvVars = new Set<string>();
  const uniqueEnvVar = (id: string): string => {
    const base = piNativeKeyEnvVar(id);
    if (!usedEnvVars.has(base)) {
      usedEnvVars.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}`;
      if (!usedEnvVars.has(candidate)) {
        usedEnvVars.add(candidate);
        return candidate;
      }
    }
  };
  for (const cfg of configs) {
    const rt = cfg.runtimes.pi;
    if (!rt) continue;
    const authMethod = cfg.auth?.method ?? 'apiKey';
    if (authMethod === 'oauth') {
      onSkip?.(cfg.id, 'oauth not supported for pi native');
      continue;
    }
    const headers = rt.headers && Object.keys(rt.headers).length > 0
      ? Object.fromEntries(
          Object.entries(rt.headers).map(([name, value]) => {
            const envVar = uniqueEnvVar(`${cfg.id}_HEADER_${name}`);
            env[envVar] = value;
            return [name, `$${envVar}`];
          }),
        )
      : undefined;
    let apiKeyEnvVar: string | undefined;
    if (authMethod === 'apiKey') {
      const key = readKey(cfg.id, 'pi');
      if (!key && !headers) {
        onSkip?.(cfg.id, 'apiKey provider missing pi key and custom headers');
        continue;
      }
      if (key) {
        apiKeyEnvVar = uniqueEnvVar(cfg.id);
        env[apiKeyEnvVar] = key;
      }
    }
    providers.push({
      id: cfg.id,
      name: cfg.name,
      baseUrl: rt.baseUrl,
      api: wireProtocolToPiApi(rt.wireProtocol),
      apiKeyEnvVar,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      models: rt.models.map((m) => {
        const supportedEfforts = new Set(m.reasoningEfforts ?? []);
        return {
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          ...(m.supportsImageInput === true
            ? { input: ['text', 'image'] as Array<'text' | 'image'> }
            : {}),
          ...(m.reasoning === true
            ? {
                reasoning: true,
                thinkingLevelMap: Object.fromEntries(
                  PI_REASONING_EFFORTS.map((effort) => [
                    effort,
                    supportedEfforts.has(effort) ? effort : null,
                  ]),
                ),
              }
            : {}),
        };
      }),
    });
  }
  return { providers, env };
}

/** BYOM:读 DB 自定义 provider + safeStorage key → pi 原生 provider spec。IO 外壳,逻辑在上面。 */
async function resolvePiNativeProviders(): Promise<PiNativeProvidersResult> {
  let configs;
  try {
    configs = await listCustomProvidersWithSecureHeaders();
  } catch (err) {
    log.warn('resolvePiNativeProviders: listCustomProviders failed, gateway-only', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { providers: [], env: {} };
  }
  return buildPiNativeProvidersFromConfigs(configs, readCustomProviderKey, (id, reason) =>
    log.warn('resolvePiNativeProviders: skipped custom provider', { id, reason }),
  );
}

/** pi 二进制缺失时返回 null(调用方跳过注册);其余情况构造 PiAgent。 */
export function buildPiAgent(opts: BuildPiAgentOpts): PiAgent | null {
  const binaryPath = resolvePiBinaryPath();
  if (!binaryPath) {
    log.warn('pi binary unavailable after managed prepare; pi agent disabled for this launch');
    return null;
  }
  log.info('pi agent enabled', { binaryPath });
  return new PiAgent({
    auth: desktopPiAuthAdapter,
    runtimeConfig: buildDesktopPiRuntimeConfig(),
    binaryPath,
    logger: opts.logger,
    turnChangeCapture: opts.turnChangeCapture,
    capabilityAdditions: opts.capabilityAdditions,
    reviewAutoPermissionAction: opts.reviewAutoPermissionAction,
    mcpProviders: opts.mcpProviders,
    makerMemory: opts.makerMemory,
    // 与 Claude Code / Codex 同一份第一方 MCP 审批真源。Pi 之前没接,导致 orca 这类
    // 可信 server 的工具落进 Auto-review 灰区被模型静默 block(详见 pi/index.ts 权限门)。
    getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
    resolvePiAgentHome: () => path.join(app.getPath('userData'), 'pi-agent-home'),
    preparePiExtraSpawnConfig: (providers, ctx) => getPiExtraSpawnConfig(providers, opts.logger, ctx),
    registerPiProxySession,
    resolvePiNativeProviders: () => resolvePiNativeProviders(),
    resolvePiRuntimeModelDescriptor: opts.resolvePiRuntimeModelDescriptor,
    resolvePiGatewayModelDescriptor: opts.resolvePiGatewayModelDescriptor,
  });
}
