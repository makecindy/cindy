import { createTerminalPiProviders } from './pi-providers.js';
import { deriveAvailableModels, resolvePiRuntimeModelDescriptor } from '@cindy/app-runtime/catalogToDescriptors';
import { createPiGatewayModelResolver } from '@cindy/app-runtime/piGatewayModelResolver';
import { prepareCodexCustomContextCatalog } from '@cindy/app-runtime/codexCustomContextCatalog';
import { readCodexContextWindowInfo } from '@cindy/app-runtime/codexContextWindow';
import { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';
import type { createSessionRuntimeAxes } from '@cindy/app-runtime/sessionRuntimeAxes';
import { stableCodexProviderRouteId, type AppliedCodexProviderRoute } from '@cindy/app-runtime/codexProviderIdentity';
import { createChatgptProxy, createGrokProxy } from './subscription-proxy.js';
import { forwardSshPiMcp } from '@cindy/app-runtime/sshPiMcp';
import type { TerminalSshService } from '../ssh.js';
import type { TerminalSshRuntime } from '../tasks/ssh-runtime.js';
import { createRemoteClaudeRoute } from '@cindy/app-runtime/remoteClaudeRoute';
import { buildRouteDecision } from '@cindy/app-runtime/providerRouteDecision';
import { getHostClaudeReadOnlyAllowedTools, getHostMcpToolApprovalPolicy } from '@cindy/mcps/host/mcpToolApprovalPolicy';
import type { BridgeSessionPrefs } from '@cindy/anthropic-responses-bridge';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { privateDirectory } from '../platform.js';
import { ClaudeCodeAgent, CodexAgent, PiAgent, type AgentKind, type AgentSessionHandle, type AuthAdapter, type AuthState, type BaseAgent, type Logger, type CodexExtraSpawnConfig, type MakerMemoryManager } from '@cindy/maker-core';
import { BUNDLED_CATALOG, findModelRegistryRoute, type ResolvedRoute } from '@cindy/model-providers';
import type { createTaskTools } from '../tasks/mcp.js';
import type { TerminalModelConfig, ModelSelection } from './config.js';

import { createProviderProxy } from './proxy.js';

import type { TerminalCapabilities } from '../tasks/capabilities.js';

import { nativeLoginStatus } from '../engines/native.js';
import {spawnTerminalPiSubagent, type TerminalPiRuntimeOwner} from '../pi-runtime.js';
const names = { 'claude-code': 'claude', codex: 'codex', pi: 'pi' } as const;

/** Claude and Pi fork offline. An expired/removed model connection must not
 * prevent copying their native history or start a model/proxy just to do so. */
export function createOfflineHistoryAgent(input: {
  kind: 'claude-code' | 'pi'; binaryPath: string; logger: Logger;
  profileDir: string; sourceSessionId: string;
}): BaseAgent {
  const auth: AuthAdapter = {
    getState: async () => ({authenticated: false}), getAuthEnv: async () => ({}),
    triggerLogin: async () => {throw new Error('USE_NATIVE_CLI_LOGIN');},
    logout: async () => {throw new Error('USE_NATIVE_CLI_LOGOUT');},
  };
  const deps = {auth, binaryPath: input.binaryPath, logger: input.logger,
    runtimeConfig: {userDataPath: input.profileDir}};
  return input.kind === 'claude-code' ? new ClaudeCodeAgent(deps) : new PiAgent({
    ...deps, resolvePiAgentHome: () => path.join(input.profileDir, 'engines', 'pi', input.sourceSessionId),
  });
}

/** Locate installed native CLIs without a shell and without changing global HOME. */
export async function findAgentBinary(kind: AgentKind, explicit?: string): Promise<string | null> {
  const paths = explicit ? [explicit] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(dir => {
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    return extensions.map(ext => path.join(dir, names[kind] + ext));
  });
  for (const file of paths) {
    try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path.resolve(file); }
    catch { /* A missing PATH entry is not an installed engine. */ }
  }
  return null;
}

/** Query login via vendor commands only. Native credentials never enter Node. */
export async function nativeAuthState(kind: AgentKind, binary: string | null): Promise<AuthState> {
  if (!binary) return { authenticated: false, errorReason: 'engine_not_installed' };
  if (kind === 'pi') return { authenticated: false, errorReason: 'configure_a_provider_for_pi' };
  const state = await nativeLoginStatus(kind, binary);
  return { authenticated: state === 'authenticated', ...(state === 'authenticated' ? { authSource: 'oauth' as const } : { errorReason: 'native_subscription_login_required' }) };
}

export interface RuntimeInput {
  piRuntimeOwner?: TerminalPiRuntimeOwner;
  codexHistory?: Pick<ConstructorParameters<typeof CodexAgent>[0], 'prepareCodexResumeSession' | 'resolveCodexThreadStorage' | 'recordCodexThreadLocation'>;
  proxyObservation?:import('./proxy.js').ProviderProxyObservation;
  profileDir: string;
  taskId: string;
  runtimeAxes?: ReturnType<typeof createSessionRuntimeAxes>;
  registerCodexProviderRoutes?(routes: readonly AppliedCodexProviderRoute[]): () => void;
  selection: ModelSelection;
  route: ResolvedRoute;
  binaryPath: string;
  models: TerminalModelConfig;
  logger: Logger;
  remote?: boolean;
  remoteHostId?: string | null;
  ssh?: TerminalSshService;
  sshRuntime?: TerminalSshRuntime;
  taskShellEnv?: () => Record<string,string>;
  guestHome?: string;
  authorizeRequest?: (model: string) => Promise<boolean>;
  tools?: Awaited<ReturnType<typeof createTaskTools>>;
  memory?: MakerMemoryManager;
  capabilities?: Awaited<ReturnType<TerminalCapabilities['runtime']>>;
  contactsEnabled?: boolean;
  getGhostRosterPrompt?: () => string;
  getContactsPromptState?: () => 'enabled' | 'disabled';
  turnChangeCapture?: ConstructorParameters<typeof ClaudeCodeAgent>[0]['turnChangeCapture'];
  reviewAutoPermissionAction?: ConstructorParameters<typeof ClaudeCodeAgent>[0]['reviewAutoPermissionAction'];
}

/** Construct the real maker-core adapters. A task owns a route snapshot so
 * changing another task's provider cannot redirect an in-flight request. */
export async function createTerminalAgent(input: RuntimeInput): Promise<BaseAgent> {
  const { selection, route, binaryPath, models, profileDir, taskId, logger } = input;
  const sshCodex = Boolean(input.remoteHostId && selection.agentKind === 'codex');
  const sshClaude = Boolean(input.remoteHostId && selection.agentKind === 'claude-code');
  if ((sshCodex || sshClaude) && (!input.ssh || !input.sshRuntime)) throw new Error('SSH_RUNTIME_UNAVAILABLE');
  if (!input.remote && !sshCodex) await models.prepareLocalModel(selection.providerId);
  let currentModel = selection.model;
  let currentEffort = selection.effort ?? route.model.defaultEffort ?? undefined;
  input.runtimeAxes?.setSessionEffort(taskId, currentEffort);
  let currentFast: boolean | 'ultrafast' = false;
  let activeHandle: AgentSessionHandle | undefined;
  const preferences = (model: string): BridgeSessionPrefs => {
    // Match a request to this physical runtime, including the vendor wire alias.
    const normalize = (id: string) => id.replace(/^(?:chatgpt|xai)\//, '').replace(/\[1m\]$/, '');
    if (normalize(model) !== normalize(activeHandle?.model ?? currentModel)) return {};
    const entry = route.provider.models[selection.agentKind]?.find(entry => normalize(entry.id) === normalize(model));
    // A proxy-backed subscription is a custom provider to the native engine,
    // whose private catalog may not advertise the account's paid speed tiers.
    const effectiveFast = input.runtimeAxes?.getSessionFastMode(taskId) ?? currentFast;
    return { reasoningEffort: (input.runtimeAxes?.getSessionEffort(taskId) ?? activeHandle?.getEffort?.() ?? currentEffort) as BridgeSessionPrefs["reasoningEffort"], fast: entry?.supportsFastMode && (effectiveFast !== 'ultrafast' || entry.supportsUltrafastMode) ? effectiveFast : false };
  };
  const openaiAccount = models.openAiAccount(route.provider.id);
  const grokAccount = models.grokAccount(route.provider.id);
  const chatgpt = Boolean(openaiAccount);
  const grok = Boolean(grokAccount);
  const custom = !sshCodex && (grok || chatgpt || route.provider.source === 'user' || route.provider.id === 'xd' || Boolean(route.provider.auth.oauth));
  const key = custom && !input.remote ? await models.credential(selection.providerId, selection.agentKind) : null;
  const codexHome = custom && !input.remote && selection.agentKind === 'codex' ? (input.guestHome ? path.join(input.guestHome,'codex') : path.join(profileDir, 'engines', 'codex', taskId)) : undefined;
  const claudeHome = input.guestHome && selection.agentKind==='claude-code' ? path.join(input.guestHome,'claude') : undefined;
  for(const directory of [codexHome,claudeHome])if(directory)await privateDirectory(directory);
  const localProxy = !input.remote && !sshCodex && !sshClaude;
  const proxy = grok && localProxy ? await createGrokProxy({ route, kind: selection.agentKind, taskId, accounts: grokAccount!, authorize: input.authorizeRequest, preferences }) : chatgpt && localProxy ? await createChatgptProxy({ route, kind: selection.agentKind, taskId, accounts: openaiAccount!, authorize: input.authorizeRequest, preferences }) : custom && localProxy ? await createProviderProxy(route, selection.agentKind, key, await models.headers(selection.providerId, selection.agentKind), input.authorizeRequest, route.provider.id === 'xd' ? key => models.reportGatewayRejection(key) : undefined, route.provider.auth.oauth ? () => models.credential(selection.providerId, selection.agentKind) : undefined, preferences, input.proxyObservation) : null;
  const runtimeKey = proxy?.token ?? key;
  let endpoint = proxy?.url ?? route.routing.upstream;
  let remoteEndpoint:Awaited<ReturnType<TerminalSshService['forwardRuntimeEndpoint']>>|undefined;
  if(input.remoteHostId&&proxy){
    try {
      if(!input.ssh)throw new Error('SSH_RUNTIME_UNAVAILABLE');
      remoteEndpoint=await input.ssh.forwardRuntimeEndpoint(input.remoteHostId,proxy.url);
      endpoint=remoteEndpoint.url;
    }catch(error){await proxy.close();throw error;}
  }
  let releaseProviderRoutes: (() => void) | undefined;
  const own = (agent: BaseAgent) => {
    if (agent.kind !== 'pi') {
      const start = agent.startSession.bind(agent);
      agent.startSession = async options => {
        const handle = await start(options);
        const requiresRebuild = handle.requiresModelSwitchRebuild?.bind(handle);
        // This process owns an immutable credential/proxy snapshot. Tell the
        // original runtime switch service when it must resume on a new process.
        handle.requiresModelSwitchRebuild = (model, opts) =>
          opts?.providerId !== undefined && opts.providerId !== selection.providerId
            ? true : requiresRebuild?.(model, opts) ?? false;
        return handle;
      };
    }
    const disposeIdentity = agent.dispose.bind(agent);
    agent.dispose = async () => { try { await disposeIdentity(); } finally { releaseProviderRoutes?.(); } };
    if (proxy) {
      const start = agent.startSession.bind(agent);
      agent.startSession = async options => {
        currentModel = options.model ?? selection.model;
        currentEffort = options.effort ?? selection.effort ?? route.model.defaultEffort ?? undefined;
        currentFast = options.fastMode ?? false;
        input.runtimeAxes?.setSessionEffort(taskId, currentEffort); input.runtimeAxes?.setSessionFastMode(taskId, currentFast);
        const handle = await start(options);
        activeHandle = handle;
        // Only successful native changes update subsequent bridge requests.
        if (handle.setEffort) { const set = handle.setEffort.bind(handle); handle.setEffort = async effort => { await set(effort); currentEffort = effort; input.runtimeAxes?.setSessionEffort(taskId, effort); }; }
        if (handle.setFastMode) { const set = handle.setFastMode.bind(handle); handle.setFastMode = async fast => { await set(fast); currentFast = fast; input.runtimeAxes?.setSessionFastMode(taskId, fast); }; }
        if (handle.setModel) { const set = handle.setModel.bind(handle); handle.setModel = async (model, opts) => { await set(model, opts); currentModel = model; currentEffort = opts?.effort ?? currentEffort; }; }
        return handle;
      };
      const dispose = agent.dispose.bind(agent);
      agent.dispose = async () => { try { await dispose(); } finally { try {await remoteEndpoint?.close();}finally{await proxy.close();} } };
    }
    return agent;
  };
  const keyless = route.provider.auth.method === 'none';
  const auth: AuthAdapter = {
    async getState() {
      return custom ? { authenticated: grok ? grokAccount!.connected() : chatgpt ? openaiAccount!.connected() : keyless || Boolean(key), authSource: key ? 'api-key' : undefined } : selection.agentKind === 'claude-code' && models.nativeClaude ? models.nativeClaude.state() : nativeAuthState(selection.agentKind, binaryPath);
    },
    async getAuthEnv() {
      if (!custom) return {};
      const env: Record<string, string> = {};
      if (selection.agentKind === 'claude-code') {env.ANTHROPIC_API_KEY = runtimeKey ?? 'terminal-keyless';if(claudeHome)env.CLAUDE_CONFIG_DIR=claudeHome;}
      if (selection.agentKind === 'codex') {
        env.CINDY_TERMINAL_PROVIDER_KEY = runtimeKey ?? 'terminal-keyless';
        if (codexHome) env.CODEX_HOME = codexHome;
      }
      if (selection.agentKind === 'pi' && runtimeKey) env.CINDY_TERMINAL_PROVIDER_KEY = runtimeKey;
      return env;
    },
    async triggerLogin() { throw new Error('USE_NATIVE_CLI_LOGIN'); },
    async logout() { throw new Error('USE_NATIVE_CLI_LOGOUT'); },
  };
  const catalogModels = route.provider.models[selection.agentKind] ?? [];
  // Trust belongs to the host registration, not a server name supplied by a
  // custom endpoint or discovered in the native CLI's settings.
  const hostServers = new Set((input.tools?.providers ?? []).map(provider => provider.name)
    .filter(name => !Object.hasOwn(input.capabilities?.factories ?? {}, name)));
  const deps = {
    auth: sshCodex ? input.ssh!.codexAuth(input.remoteHostId!) : auth, binaryPath, logger,
    getMcpToolApprovalPolicy: (context: import('@cindy/maker-core').McpToolApprovalContext) =>
      hostServers.has(context.serverName) ? getHostMcpToolApprovalPolicy(context) : 'prompt' as const,
    claudeAllowedTools: getHostClaudeReadOnlyAllowedTools().filter(tool =>
      [...hostServers].some(name => tool.startsWith(`mcp__${name}__`))),
    turnChangeCapture: input.turnChangeCapture,
    reviewAutoPermissionAction: input.reviewAutoPermissionAction,
    makerMemory: input.memory,
    getGhostRosterPrompt: input.getGhostRosterPrompt,
    getManagedSkills: input.capabilities?.getManagedSkills,
    getDisabledSkillPaths: input.capabilities?.getDisabledSkillPaths,
    prepareCodexSkills: input.capabilities?.prepareCodexSkills,
    getContactsPromptState: input.getContactsPromptState ?? (() => input.contactsEnabled ? 'enabled' : 'disabled'),
    mcpProviders: input.tools?.providers,
    registerCodexMcpThreadContext: sshCodex ? input.sshRuntime!.registerCodexMcpThreadContext : input.tools?.registerCodexMcpThreadContext,
    unregisterCodexMcpThreadContext: sshCodex ? input.sshRuntime!.unregisterCodexMcpThreadContext : input.tools?.unregisterCodexMcpThreadContext,
    withCodexMcpDiscoveryContext: sshCodex ? input.sshRuntime!.withCodexMcpDiscoveryContext : input.tools?.withCodexMcpDiscoveryContext,
    runtimeConfig: { taskShellEnv: input.taskShellEnv, userDataPath: input.guestHome ?? profileDir, ...(input.memory ? { makerMemoryEnabled: input.memory.isEnabled() } : {}), ...(custom && selection.agentKind === 'claude-code' ? { endpoint } : {}), ...(sshClaude?{remoteEndpoint:endpoint}:{}) },
    capabilityAdditions: { availableModels: catalogModels.map(model => ({
      id: model.id, displayName: model.name, contextWindow: model.contextWindow,
      efforts: model.efforts ?? [], defaultEffort: model.defaultEffort ?? null,
    })) },
    resolveModelContextLimit: (provider: string | null | undefined, id: string) => models.nativeContextLimit(selection.agentKind, provider ?? selection.providerId, id),
  };
  if (selection.agentKind === 'claude-code') return own(new ClaudeCodeAgent({...deps,...(sshClaude?{
    ...input.sshRuntime!.claude,
    getRemoteAgentFileOps:input.ssh!.pi.getRemoteAgentFileOps,
    resolveRemoteClaudeRoute:async(opts:{providerId?:string|null;model:string})=>createRemoteClaudeRoute({
      isClaudeSubscriptionProviderId:id=>id==='anthropic',readClaudeApiKey:()=>key,isProviderRouteMutationInProgress:()=>models.isMutating(),
      resolveProviderRouteDecision:async(providerId,kind,gatewayKey)=>{
        const resolved=await models.select({providerId,agentKind:kind,model:opts.model});
        const credential=await models.credential(providerId,kind),headers=await models.headers(providerId,kind);
        const routing={...resolved.route.routing,headerOverride:{...resolved.route.routing.headerOverride,...headers}};
        return {providerId,routing,decision:buildRouteDecision(routing,gatewayKey,kind,credential,resolved.route.provider.auth.oauth?credential:undefined)};
      },
    }).resolveRemoteClaudeRoute(opts),
  }: {})}));
  if (selection.agentKind === 'codex') {
    if (sshCodex && (!input.ssh || !input.sshRuntime)) throw new Error('SSH_RUNTIME_UNAVAILABLE');
    const agent = new CodexAgent({
    ...deps,
    // Match Desktop: Cindy supplies its own plugins through the host MCP bridge.
    disableCodexPluginRuntime: true,
    ...input.codexHistory,
    resolveCodexThreadContextWindow: (provider, model) => models.nativeContextLimit('codex', provider ?? selection.providerId, model, true),
    resolveVerifiedContextWindow: (provider, model) => resolveVerifiedContextWindow(models.activeCatalog(), 'codex', models.contextProvider('codex', provider ?? selection.providerId, model), model),
    resolveCodexContextWindowInfo: (modelId, config, reportedUsableWindow, nativeHome) => readCodexContextWindowInfo({codexHome: nativeHome ?? codexHome ?? path.join(profileDir, 'engines', 'codex', taskId), binaryPath, modelId, config, reportedUsableWindow}),
    ...(sshCodex ? { ...input.ssh!.codex, getRemoteAgentFileOps: input.ssh!.pi.getRemoteAgentFileOps } : {}),
    prepareCodexExtraSpawnConfig: async (_providers, ctx): Promise<CodexExtraSpawnConfig> => {
      if (sshCodex) return input.sshRuntime!.codexSpawn(input.remoteHostId!);
      let contextArgs: string[] = [];
      if (ctx.hostPurpose === 'custom-context') {
        const modelId = ctx.customContextModel?.trim(), contextWindow = ctx.customContextWindow;
        if (!modelId || typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0)
          throw new Error('custom-context Codex host is missing its model or context window');
        const source = ctx.customContextProviderId ?? selection.providerId;
        const customCatalog = await prepareCodexCustomContextCatalog({binaryPath,
          codexHome: ctx.codexHome ?? codexHome ?? path.join(profileDir, 'engines', 'codex', taskId),
          modelId, contextWindow, modelIds: models.activeCatalog().providers.find(provider => provider.id === source)?.models.codex?.map(model => model.id),
          resolveContextWindow: model => models.nativeContextLimit('codex', source, model, true)});
        contextArgs = customCatalog.extraArgs;
      }
      if (!custom) return { extraArgs: [...(input.tools?.codexArgs ?? []), ...contextArgs], extraEnv: input.tools?.env ?? {}, buildSessionMcpConfig:input.tools?.buildSessionMcpConfig };
      const provider = `cindy_custom_${stableCodexProviderRouteId(selection.providerId)}`;
      const providerRoutes = [{ providerId: selection.providerId, modelProviderId: provider, capabilities: {}, responseModels: catalogModels.map(model => model.id) }];
      releaseProviderRoutes?.();
      releaseProviderRoutes = input.registerCodexProviderRoutes?.(providerRoutes);
      return {
        extraArgs: [
          ...(input.tools?.codexArgs ?? []), ...contextArgs,
          '-c', `model_provider=${JSON.stringify(provider)}`,
          '-c', `model_providers.${provider}.name=${JSON.stringify(route.provider.name)}`,
          '-c', `model_providers.${provider}.base_url=${JSON.stringify(endpoint)}`,
          '-c', `model_providers.${provider}.wire_api="responses"`,
          '-c', `model_providers.${provider}.env_key="CINDY_TERMINAL_PROVIDER_KEY"`,
          '-c', `model_providers.${provider}.supports_websockets=false`,
        ],
        extraEnv: { ...input.tools?.env, CINDY_TERMINAL_PROVIDER_KEY: runtimeKey ?? 'terminal-keyless' },
        buildSessionMcpConfig:input.tools?.buildSessionMcpConfig,
        codexCustomProviderRoutes: providerRoutes,
      };
    },
    });
    return own(sshCodex ? input.sshRuntime!.trackCodex(agent) : agent);
  }
  const piProviders = createTerminalPiProviders(input, preferences);
  const gatewayModels = createPiGatewayModelResolver(models.catalogRuntime);
  const piLifetime = input.piRuntimeOwner?.scope();
  const pi = new PiAgent({
    ...deps,
    ...input.ssh?.pi,
    spawnPiSubagentRunner: piLifetime?.spawn ?? spawnTerminalPiSubagent,
    capabilityAdditions: {availableModels: deriveAvailableModels(models.activeCatalog(), 'pi')},
    resolvePiRuntimeModels: () => deriveAvailableModels(models.activeCatalog(), 'pi'),
    resolvePiRuntimeModelDescriptor: (provider, model) => resolvePiRuntimeModelDescriptor(models.activeCatalog(), provider, model),
    resolvePiGatewayModelDescriptor: (_provider, model) => resolvePiRuntimeModelDescriptor(models.activeCatalog(), 'xd', model),
    resolvePiGatewayModelApi: gatewayModels.resolvePiCindyGatewayModelApi,
    resolvePiGatewayModelSpec: gatewayModels.resolvePiCindyGatewayModelSpec,
    preparePiExtraSpawnConfig: async (_providers, context) => forwardSshPiMcp(input.tools?.pi(context) ?? null,context?.remoteHostId,input.ssh?.pi.rewriteRemotePiMcpBridgeUrl),
    resolvePiAgentHome: remoteHostId => remoteHostId ? '' : input.guestHome ? path.join(input.guestHome,'pi') : path.join(profileDir, 'engines', 'pi', taskId),
    resolvePiNativeProviders: piProviders.resolve,
  });
  const disposePi = pi.dispose.bind(pi);
  pi.dispose = async () => {try {await disposePi();} finally {await piProviders.close();}};
  const ownedPi = own(pi);
  return piLifetime ? piLifetime.attach(ownedPi) : ownedPi;
}

/** Native account discovery asks the actual adapter; no cached credential files are read. */
export async function discoverNativeModels(kind: AgentKind, binaryPath: string, profileDir: string, logger: Logger) {
  if (kind === 'pi') return [];
  const auth: AuthAdapter = {
    getState: () => nativeAuthState(kind, binaryPath), getAuthEnv: async () => ({}),
    triggerLogin: async () => { throw new Error('USE_NATIVE_CLI_LOGIN'); }, logout: async () => { throw new Error('USE_NATIVE_CLI_LOGOUT'); },
  };
  const result: import('@cindy/model-providers').CatalogModel[] = [];
  const deps = { auth, binaryPath, logger, runtimeConfig: { userDataPath: profileDir } };
  const agent = kind === 'codex' ? new CodexAgent({ ...deps, disableCodexPluginRuntime: true, onCodexLocalModelsListed: models => {
    for (const [index, model] of models.entries()) {
      if (model.hidden || !model.model) continue;
      const efforts = (model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? []).filter((effort): effort is import('@cindy/model-providers').Effort => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort));
      result.push({ id: model.model, name: model.displayName || model.model, description: model.description,
        sortOrder: index, defaultEnabled: true, contextWindow: findModelRegistryRoute(BUNDLED_CATALOG.modelRegistry, 'openai', model.model, 'codex')?.entry.contextWindow ?? 272_000, efforts, defaultEffort: efforts.includes(model.defaultReasoningEffort as import('@cindy/model-providers').Effort) ? model.defaultReasoningEffort as import('@cindy/model-providers').Effort : null });
    }
  } }) : new ClaudeCodeAgent(deps);
  try {
    await agent.refreshLocalModels({ credentialMode: 'oauth-bearer', ...(kind === 'claude-code' ? { onSupportedModels: (models: unknown[]) => {
      for (const raw of models) {
        if (!raw || typeof raw !== 'object') continue;
        const model = raw as { value?: string; displayName?: string; description?: string };
        if (model.value) result.push({ id: model.value, name: model.displayName ?? model.value, description: model.description, defaultEnabled: true, contextWindow: findModelRegistryRoute(BUNDLED_CATALOG.modelRegistry, 'anthropic', model.value, 'claude-code')?.entry.contextWindow ?? 200_000, efforts: [], defaultEffort: null });
      }
    } } : {}) });
    return result;
  } finally { await agent.dispose(); }
}
