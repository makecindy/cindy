import { promises as fs } from 'node:fs';
import type { AgentDeps } from '@cindy/maker-core';
import type { ProviderView, Catalog } from '@cindy/model-providers';
import type { createCodexProxyHost } from './codex-proxy-host.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { buildCodexProxySpawnArgs, CODEX_CINDY_COMPACT_PROVIDER_ID, CODEX_GATEWAY_PROVIDER_ID, CODEX_SUMMARY_COMPACT_PROVIDER_ID, CODEX_OPENAI_COMPACT_PROVIDER_ID } from './codex-gateway-config.js';
import { buildCodexCustomProviderArgs, deriveCodexCustomProviderRoutes, registerCodexScopedCustomProviderRoutes, toCodexCustomProviderHostRoutes } from './codex-custom-provider-route.js';
import { buildCodexSubagentSpawnArgs, codexHostUsesSmartSubagentRouting, resolveCodexSubagentRoutingProfile, type CodexSmartSubagentConfig } from './codex-subagent-config.js';
import { restrictCodexRoutesToGuestProvider } from './guest-provider-route-store.js';
import { prepareCodexSmartSubagentConfig, codexSmartSubagentRoutingSignature, selectCodexSmartSubagentCandidates } from './codex-smart-subagent-routing.js';
import { readSubagentModelSettings } from './subagent-model-settings-store.js';
import { prepareCodexBrowserCompanion, resolveCodexBrowserCompanionSpawnConfig } from './codex-browser-companion.js';
import { getActiveCatalog, getActiveCatalogRevision } from './active-catalog.js';
import { prepareCodexCustomContextCatalog, prepareCodexGuestModelCatalog } from './codex-custom-context-catalog.js';
import { readModelContextLimit, resolveModelCompactionPct } from './model-context-limit-store.js';
import { resolveModelDefaultContextWindow } from './catalog-to-descriptors.js';

type Prepare = NonNullable<AgentDeps['prepareCodexExtraSpawnConfig']>;
type Proxy = ReturnType<typeof createCodexProxyHost>;

/** One spawn policy for both launchers. Platform IO remains at the boundary;
 * routing, guest isolation, compaction and native subagents have one implementation. */
export function createCodexSpawnConfig(ports: {
  binaryPath: string;
  getCodexHome(): string;
  getCodexExtraSpawnConfig: typeof import('../mcp-integrations/codexEnvironment.desktop.js').getCodexExtraSpawnConfig;
  broadcastCodexRuntimeRoute(): Promise<void>;
  readClaudeApiKey(): string | null;
  isReplacedCindyGatewayKey(value: string): boolean;
  hasCodexOAuthLogin(): Promise<boolean>;
  listProviders(): Promise<ProviderView[]>;
  getDesktopSelectableCatalog(): Catalog;
  resolveDesktopModelContextProviderId: typeof import('./model-context-settings.js').resolveDesktopModelContextProviderId;
  prepareRemote: Prepare;
  readSubagentOAuth: Parameters<Proxy['setCodexSubagentOAuthReader']>[0];
  proxy: Pick<Proxy, 'setCodexProxyAuthInjection' | 'setCodexProxyGatewayKeyReader' | 'setCodexSubagentOAuthReader' | 'ensureCodexCustomContextProxyReady' | 'isCodexCustomContextProxyHandleReady' | 'releaseCodexCustomContextProxy' | 'ensureCodexControlPlaneProxyReady' | 'ensureCodexProxyReady' | 'isCodexControlPlaneProxyHandleReady' | 'isCodexProxyHandleReady' | 'getCodexCustomContextProxyEndpoint' | 'getCodexControlPlaneProxyEndpoint' | 'getCodexProxyEndpoint' | 'setCodexAppliedCustomProviderRoutes'>;
}): Prepare {
  const { getCodexHome, getCodexExtraSpawnConfig, broadcastCodexRuntimeRoute, readClaudeApiKey, isReplacedCindyGatewayKey, getDesktopSelectableCatalog, resolveDesktopModelContextProviderId } = ports;
  const { setCodexProxyAuthInjection, setCodexProxyGatewayKeyReader, setCodexSubagentOAuthReader, ensureCodexCustomContextProxyReady, isCodexCustomContextProxyHandleReady, releaseCodexCustomContextProxy, ensureCodexControlPlaneProxyReady, ensureCodexProxyReady, isCodexControlPlaneProxyHandleReady, isCodexProxyHandleReady, getCodexCustomContextProxyEndpoint, getCodexControlPlaneProxyEndpoint, getCodexProxyEndpoint, setCodexAppliedCustomProviderRoutes } = ports.proxy;
  return async (providers, ctx) => {
        if (ctx.remoteHostId) return ports.prepareRemote(providers, ctx);
        const isControlPlane = ctx.hostPurpose === 'control-plane';
        const isReview = ctx.hostPurpose === 'review';
        const isCustomContext = ctx.hostPurpose === 'custom-context';
        const needsContextScope = isCustomContext || ctx.localAuthPolicy === 'isolated';
        const customContextHostKey = needsContextScope
          ? (ctx.hostScopeKey ?? ctx.customContextHostKey)?.trim() ?? ''
          : '';
        if (needsContextScope && !customContextHostKey) {
          const error = new Error('custom-context Codex host is missing its runtime scope key');
          (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
          throw error;
        }
        const accountProxyKey = ctx.accountHostKey;
        const usesScopedProxy = needsContextScope || !!accountProxyKey;
        const scopedProxyKey = accountProxyKey || customContextHostKey;
        const usesIsolatedProxy = isControlPlane || isReview || usesScopedProxy;
        // 供应商分享受邀者的任务：独占的 proxy 只登记分享的那个供应商的路由并过受邀者守门，
        // 不开智能子代理调配。没有独占 proxy 就不能安全地收窄，直接失败。
        const guestProviderId = ctx.deviceHostedGuestProviderId?.trim() || undefined;
        const guestSessionId = ctx.deviceHostedGuestSessionId?.trim() || undefined;
        if (ctx.deviceHostedGuestProviderId !== undefined && (!guestProviderId || !guestSessionId || !usesScopedProxy)) {
          const error = new Error('shared-provider Codex host requires its own session-bound scoped proxy');
          (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
          throw error;
        }
        const effectiveCodexHome = ctx.codexHome ?? getCodexHome();
        let mcpExtraArgs: string[] = [];
        let mcpExtraEnv: Record<string, string> = {};
        let buildSessionMcpConfig:
          | ((sessionInstanceId: string) => Record<string, unknown>)
          | undefined;
        // Review hosts and native-storage-only (archive) hosts never expose Cindy MCP tools.
        if (!isReview && !ctx.nativeStorageOnly) {
          try {
            const cfg = await getCodexExtraSpawnConfig({
              mcpProviders: providers,
              logger: desktopMakerLogger,
            });
            // getCodexExtraSpawnConfig may return a cached array; per-host
            // Browser overrides must never mutate that shared snapshot.
            mcpExtraArgs = [...cfg.extraArgs];
            mcpExtraEnv = cfg.extraEnv;
            buildSessionMcpConfig = cfg.buildSessionMcpConfig;
          } catch (err) {
            desktopMakerLogger.error('codex MCP bridge prep failed, continuing without lizi MCP', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const browserCompanion = isControlPlane || isReview
          ? null
          : await prepareCodexBrowserCompanion({ codexHome: ctx.runtimeCodexHome ?? effectiveCodexHome });
        const browserCompanionSpawnConfig =
          resolveCodexBrowserCompanionSpawnConfig(browserCompanion);
        mcpExtraArgs.push(...browserCompanionSpawnConfig.extraArgs);
        if (
          browserCompanion?.status === 'unavailable' &&
          browserCompanion.reason !== 'platform_unsupported'
        ) {
          desktopMakerLogger.warn('Codex Browser companion unavailable', {
            reason: browserCompanion.reason,
            detail: browserCompanion.detail,
          });
        }
        // API 模式: 追加 model_provider override, 让 codex app-server 走 AI Gateway
        // 而非 OAuth 订阅后端。每次 createHost 都现读 mode, 切模式后重建即生效。
        // 关掉 API 模式则不带这些 flag —— 天然可逆 (见 codex-gateway-config.ts)。
        //
        // proxy 路线: codex 始终经本地 loopback proxy 出口(不分 oauth/api 全局开关),
        // proxy 按 model + 模式分流。spawn 鉴权优先服从本次 session 的显式来源:
        //   gateway-key  → env_key(codex 带 gateway key,不触碰 OAuth cloud config)
        //   oauth-bearer → requires_openai_auth(codex 带 OAuth token,普通模型走 ChatGPT)
        //   provider-oauth → env_key 占位,proxy 用供应商 OAuth 覆盖 Authorization(如 xAI)
        // 未显式选择来源时才保留旧 fallback:有 OAuth 用 OAuth,否则用 gateway key。
        const credentialMode =
          ctx.credentialMode ??
          ((await ports.hasCodexOAuthLogin()) ? 'oauth-bearer' : 'gateway-key');
        const authInjection =
          credentialMode === 'oauth-bearer'
            ? 'oauth-bearer'
            : credentialMode === 'provider-oauth'
              ? 'provider-oauth'
              : 'env-key';
        const useOAuthBearer = authInjection === 'oauth-bearer';
        if (!usesIsolatedProxy) {
          setCodexProxyAuthInjection(authInjection);
          await broadcastCodexRuntimeRoute();
        }
        setCodexProxyGatewayKeyReader(readClaudeApiKey, isReplacedCindyGatewayKey);
        setCodexSubagentOAuthReader(ports.readSubagentOAuth);

        const customContextProviderRoutes = usesScopedProxy
          ? restrictCodexRoutesToGuestProvider(deriveCodexCustomProviderRoutes(getActiveCatalog()), guestProviderId)
          : [];

        // 这个点在 CodexAgent.createHost() 内。返回的 codexProxyActive 会被冻到 AppServerHost 实例上,
        // 后续 startSession 只读 host 自己的事实,不再 live 读全局 flag。
        if (usesScopedProxy) {
          await ensureCodexCustomContextProxyReady(
            scopedProxyKey,
            authInjection,
            customContextProviderRoutes,
            guestProviderId,
            guestSessionId,
          );
          // 受邀者不走「proxy 不可用时直连网关」的退路：那条路不经受邀者守门。
          if (guestProviderId && !isCodexCustomContextProxyHandleReady(scopedProxyKey)) {
            await releaseCodexCustomContextProxy(scopedProxyKey);
            const error = new Error('shared-provider Codex host requires the local proxy, but the proxy is not ready');
            (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
            throw error;
          }
        } else if (usesIsolatedProxy) {
          await ensureCodexControlPlaneProxyReady(authInjection);
        } else {
          await ensureCodexProxyReady();
        }
        const ready = usesScopedProxy
          ? isCodexCustomContextProxyHandleReady(scopedProxyKey)
          : usesIsolatedProxy
            ? isCodexControlPlaneProxyHandleReady(authInjection)
            : isCodexProxyHandleReady();
        if ((useOAuthBearer || authInjection === 'provider-oauth') && !ready) {
          const error = new Error(
            authInjection === 'provider-oauth'
              ? 'Codex provider OAuth mode requires the local proxy, but the proxy is not ready'
              : 'Codex OAuth mode requires the local proxy, but the proxy is not ready',
          );
          // fallback OAuth 也是凭据隔离要求,不能被 maker-core 当成普通 MCP 降级吞掉。
          (error as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
          if (usesScopedProxy) {
            await releaseCodexCustomContextProxy(scopedProxyKey);
          }
          throw error;
        }
        // gateway-key 模式下 proxy 挂了仍可 fallback 到 gateway base_url(codex 直连 gateway, 不裸奔)。
        const endpoint = usesScopedProxy
          ? getCodexCustomContextProxyEndpoint(scopedProxyKey)
          : usesIsolatedProxy
            ? getCodexControlPlaneProxyEndpoint(authInjection)
            : getCodexProxyEndpoint();
        const codexCustomProviderRoutes =
          usesScopedProxy && ready
            ? customContextProviderRoutes
            : !usesIsolatedProxy && ready
              ? deriveCodexCustomProviderRoutes(getActiveCatalog())
              : [];
        if (!usesIsolatedProxy) {
          // The proxy must follow the exact capability/routing snapshot frozen into
          // this task Host, not the catalog that may already be ahead during a busy restart.
          setCodexAppliedCustomProviderRoutes(codexCustomProviderRoutes);
        }
        const codexCustomProviderSpawn = buildCodexCustomProviderArgs(
          endpoint,
          authInjection,
          codexCustomProviderRoutes,
        );
        const storedSubagentModelSettings = readSubagentModelSettings();
        let smartSubagentConfig: CodexSmartSubagentConfig | undefined;
        if (ready && codexHostUsesSmartSubagentRouting(storedSubagentModelSettings, ctx)) {
          try {
            const providerViews: ProviderView[] =
              await ports.listProviders();
            smartSubagentConfig = prepareCodexSmartSubagentConfig({
              codexHome: effectiveCodexHome,
              providerViews,
              allowChatGptOAuth: true,
              oauthProviderId: ctx.providerId,
              catalogRevision: getActiveCatalogRevision(),
            }) ?? undefined;
          } catch (err) {
            desktopMakerLogger.warn(
              'Codex smart Subagent catalog unavailable; preserving native routing',
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
        }
        let customContextCatalogArgs: string[] = [];
        let customContextCatalogPath: string | undefined;
        if (isCustomContext) {
          const modelId = ctx.customContextModel?.trim();
          const contextWindow = ctx.customContextWindow;
          try {
            if (
              !modelId ||
              typeof contextWindow !== 'number' ||
              !Number.isFinite(contextWindow) ||
              contextWindow <= 0
            ) {
              throw new Error('custom-context Codex host is missing its model or context window');
            }
            const catalog = getDesktopSelectableCatalog();
            const source = resolveDesktopModelContextProviderId(catalog, 'codex', ctx.customContextProviderId, modelId);
            const customCatalog = await prepareCodexCustomContextCatalog({
              binaryPath: ports.binaryPath,
              codexHome: effectiveCodexHome,
              modelId,
              contextWindow,
              modelIds: catalog.providers.find(provider => provider.id === source)?.models.codex?.map(model => model.id),
              resolveCompactionPct: (id) => resolveModelCompactionPct(getDesktopSelectableCatalog(), 'codex', source, id),
              resolveContextWindow: (nativeModelId) => {
                return (source ? readModelContextLimit('codex', source, nativeModelId) : null)
                  ?? resolveModelDefaultContextWindow(catalog, 'codex', source, nativeModelId);
              },
              ...(smartSubagentConfig
                ? { baseCatalog: smartSubagentConfig.modelCatalog }
                : {}),
            });
            customContextCatalogPath = customCatalog.catalogPath;
            if (smartSubagentConfig) {
              smartSubagentConfig = {
                ...smartSubagentConfig,
                catalogPath: customCatalog.catalogPath,
              };
            } else {
              customContextCatalogArgs = customCatalog.extraArgs;
            }
          } catch (error) {
            await releaseCodexCustomContextProxy(scopedProxyKey);
            const fatal = error instanceof Error ? error : new Error(String(error));
            (fatal as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
            throw fatal;
          }
        }
        if (guestProviderId) {
          try {
            const guestCatalog = await prepareCodexGuestModelCatalog({
              binaryPath: ports.binaryPath, codexHome: effectiveCodexHome,
              modelIds: ctx.deviceHostedGuestModelIds ?? [],
              ...(customContextCatalogPath ? { baseCatalog: JSON.parse(await fs.readFile(customContextCatalogPath, 'utf8')) } : {}),
            });
            customContextCatalogArgs = guestCatalog.extraArgs;
          } catch (error) {
            await releaseCodexCustomContextProxy(scopedProxyKey);
            const fatal = error instanceof Error ? error : new Error(String(error));
            (fatal as { codexSpawnConfigFatal?: boolean }).codexSpawnConfigFatal = true;
            throw fatal;
          }
        }
        const codexSubagentRoutingProfile = resolveCodexSubagentRoutingProfile(
          storedSubagentModelSettings,
          smartSubagentConfig,
        );
        const releaseScopedCapabilities = usesScopedProxy
          ? registerCodexScopedCustomProviderRoutes(scopedProxyKey, codexCustomProviderRoutes)
          : undefined;
        return {
          // 默认不碰 Codex 原生 Sol/Terra 调配。用户开启智能调配后才为这个本地
          // app-server 冻结扩展目录与逐模型 Provider 路由。
          extraArgs: [
            ...mcpExtraArgs,
            ...(!isReview && !ctx.remoteHostId
              ? buildCodexSubagentSpawnArgs(storedSubagentModelSettings, smartSubagentConfig)
              : []),
            ...customContextCatalogArgs,
            ...buildCodexProxySpawnArgs(endpoint, authInjection),
            ...codexCustomProviderSpawn.extraArgs,
          ],
          extraEnv: { ...mcpExtraEnv, ...codexCustomProviderSpawn.extraEnv },
          ...(smartSubagentConfig
            ? { smartSubagentRoutes: smartSubagentConfig.routes }
            : {}),
          ...(buildSessionMcpConfig ? { buildSessionMcpConfig } : {}),
          codexProxyActive: ready,
          codexDefaultModelProviderId: CODEX_GATEWAY_PROVIDER_ID,
          codexOpenAiWebSocketsEnabled: useOAuthBearer && ready,
          codexSubagentRoutingProfile,
          ...(smartSubagentConfig
            ? { codexSubagentRoutingSignature: smartSubagentConfig.routingSignature }
            : {}),
          ...(codexCustomProviderRoutes.length > 0
            ? { codexCustomProviderRoutes: toCodexCustomProviderHostRoutes(codexCustomProviderRoutes) }
            : {}),
          codexBrowserUseAvailable: browserCompanionSpawnConfig.codexBrowserUseAvailable,
          ...(browserCompanion?.status === 'ready'
            ? {
                codexBrowserUseVersion: browserCompanion.version,
                codexBrowserUseStartupTimeoutMs: browserCompanion.startupTimeoutMs,
              }
            : {}),
          ...(ready
            ? { codexCindyRemoteCompactionProviderId: CODEX_CINDY_COMPACT_PROVIDER_ID,
                codexLocalCompactionProviderId: CODEX_SUMMARY_COMPACT_PROVIDER_ID }
            : {}),
          // oauth spawn 额外定义订阅直连 identity；Cindy codex/* 使用上面的 HTTP identity。
          ...(useOAuthBearer && ready
            ? { codexRemoteCompactionProviderId: CODEX_OPENAI_COMPACT_PROVIDER_ID }
            : {}),
          ...(usesScopedProxy
            ? {
                onHostRetired: async () => {
                  releaseScopedCapabilities?.();
                  await releaseCodexCustomContextProxy(scopedProxyKey);
                },
              }
            : {}),
        };
      };
}

/** Host reuse follows the same frozen smart-subagent catalog as startup. */
export function createCodexRoutingSignature(listProviders: () => Promise<ProviderView[]>): NonNullable<AgentDeps['resolveCodexSubagentRoutingSignature']> {
  return async (_providers, ctx) => {
    const settings = readSubagentModelSettings();
    if (!codexHostUsesSmartSubagentRouting(settings, ctx)) return 'default';
    const candidates = selectCodexSmartSubagentCandidates(await listProviders(), {
      allowChatGptOAuth: ctx.credentialMode !== undefined, oauthProviderId: ctx.providerId,
    });
    return codexSmartSubagentRoutingSignature(candidates, getActiveCatalogRevision()) ?? 'default';
  };
}
