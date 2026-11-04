import {
  isCindyAutoModelId,
  connectedProvidersForAgent,
  isCindyDistributedProvider,
  isModelSelectableForNewRoute,
  providerCatalogId,
  defaultEffortForCapabilities,
  clampEffortToSupported,
  type AgentKind,
  type CatalogModel,
  type Effort,
  type ProviderView,
} from '@cindy/model-providers';

type MakerVendor = 'cc' | 'codex' | 'pi' | 'zcode' | 'orca';

export interface NewMakerDefaultTuple {
  vendor: Extract<MakerVendor, 'cc' | 'codex' | 'pi' | 'zcode'>;
  providerId: string;
  model: string;
  effort: Effort | null;
}

interface ProviderDefaultPolicy {
  providerId: 'openai' | 'anthropic' | 'xai' | 'xd';
  accessKind: 'subscription' | 'managed';
  agents: readonly AgentKind[];
  modelIds: readonly string[];
  allowOtherModels?: boolean;
  /**
   * Also search Cindy-distributed pool connections, and try the Auto the server marked as this
   * agent's new-task default before `modelIds`.
   */
  serverMarkedAuto?: boolean;
}

/**
 * 新用户的产品默认顺序。
 *
 * Codex / Claude 订阅优先，再采用服务端指定的 Cindy Auto，最后保留 xAI 回退。
 * 出厂推荐按完整路由选择：Sol 使用 Codex，Opus 使用 Claude Code，Cindy Auto 使用 Pi。
 * 不为了提供默认值把订阅模型静默放到另一个 Harness。
 *
 * Cindy Auto 由服务端决定：模型组 Auto（`auto/<组ID>`）可能挂在 Cindy AI 或企业号池供应商下，
 * 这里在两类来源中跟随服务端的 Pi 新任务默认标记；没有标记时（旧服务端）回退预设 `auto`。
 * 只认 Auto 系列的标记：个人目录仍把旧 GLM 标为 Pi 默认，不能让它取代 Auto。
 * 这条规则同时负责把没有订阅的用户默认切到 Pi，不能删除。
 */
const DEFAULT_POLICIES: readonly ProviderDefaultPolicy[] = [
  {
    providerId: 'openai',
    accessKind: 'subscription',
    agents: ['codex'],
    modelIds: ['gpt-6.1-sol', 'chatgpt/gpt-6.1-sol'],
  },
  {
    providerId: 'anthropic',
    accessKind: 'subscription',
    agents: ['claude-code'],
    modelIds: ['claude-opus-5-5', 'anthropic/claude-opus-5-5'],
  },
  {
    providerId: 'xd',
    accessKind: 'managed',
    agents: ['pi'],
    modelIds: ['auto'],
    allowOtherModels: false,
    serverMarkedAuto: true,
  },
  {
    providerId: 'xai',
    accessKind: 'subscription',
    agents: ['pi', 'codex', 'claude-code'],
    modelIds: ['grok-4.6', 'xai/grok-4.6'],
  },
];

function vendorForAgent(agent: AgentKind): NewMakerDefaultTuple['vendor'] {
  return agent === 'claude-code' ? 'cc' : agent;
}

/**
 * 仅供旧草稿迁移辨认“产品曾自动写入的 tuple 身份”。这里不判断账号实时可用性，
 * 也不产生默认值；真正下放仍只能走 resolveNewMakerDefaultTuple 的实时能力门控。
 */
export function isKnownProductDefaultTupleIdentity(args: {
  vendor: MakerVendor;
  providerId: string;
  model: string;
}): boolean {
  // Old automatic selections remain recognizable after the factory policy changes.
  const legacyPolicies: readonly ProviderDefaultPolicy[] = [
    { providerId: 'openai', accessKind: 'subscription', agents: ['codex'], modelIds: ['gpt-6-sol', 'chatgpt/gpt-6-sol'] },
    { providerId: 'openai', accessKind: 'subscription', agents: ['codex'], modelIds: ['gpt-6-astra', 'chatgpt/gpt-6-astra'] },
    { providerId: 'xd', accessKind: 'managed', agents: ['pi'], modelIds: ['z-ai/glm-5.3-flash', 'glm-5.3-flash'] },
    { providerId: 'openai', accessKind: 'subscription', agents: ['codex', 'claude-code', 'pi'], modelIds: ['chatgpt/gpt-5.6-sol', 'gpt-5.6-sol'] },
    { providerId: 'anthropic', accessKind: 'subscription', agents: ['claude-code', 'codex', 'pi'], modelIds: ['claude-opus-5', 'anthropic/claude-opus-5'] },
  ];
  return [...DEFAULT_POLICIES, ...legacyPolicies].some(
    (policy) =>
      policy.providerId === args.providerId &&
      policy.modelIds.includes(args.model) &&
      policy.agents.some((agent) => vendorForAgent(agent) === args.vendor),
  );
}

/** Search passes in priority order: server-marked Auto, the policy's own ids, other models. */
type ModelSearchPass = 'serverMarkedAuto' | 'serverMarkedGroupAuto' | 'preferred' | 'other';

function bySortOrder(a: CatalogModel, b: CatalogModel): number {
  return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
}

/** Only an Auto marker counts; other server markers (e.g. legacy GLM) are ignored. */
function isServerMarkedAuto(model: CatalogModel, agent: AgentKind): boolean {
  return isCindyAutoModelId(model.id) && (model.newSessionDefault?.includes(agent) ?? false);
}

function matchingModel(
  provider: ProviderView,
  agent: AgentKind,
  modelIds: readonly string[],
  pass: ModelSearchPass,
  enabled?: (
    agent: AgentKind,
    providerId: string,
    model: { id: string; defaultEnabled?: boolean },
  ) => boolean,
) {
  const models = provider.models[agent] ?? [];
  // Both renderer and unattended callers keep the same-provider fallback.
  // Without local visibility overrides, use the catalog's default visibility.
  // Cindy Auto is an upstream route identity; do not substitute a fixed model.
  const candidates =
    pass === 'serverMarkedAuto' || pass === 'serverMarkedGroupAuto'
      ? models
          .filter(
            (model) =>
              isServerMarkedAuto(model, agent) &&
              (pass !== 'serverMarkedGroupAuto' || model.id !== 'auto'),
          )
          .sort(bySortOrder)
      : pass === 'preferred'
        ? modelIds.map((id) => models.find((model) => model.id === id))
        : models.slice().sort(bySortOrder);
  return candidates.find(
    (model) =>
      model !== undefined &&
      (enabled ? enabled(agent, provider.id, model) : model.defaultEnabled !== false) &&
      isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
  );
}

function isAvailableDefaultProvider(provider: ProviderView): boolean {
  return provider.connected && !provider.suspended && !provider.modelDiscoveryFailure;
}

/** 普通草稿跨 Cindy 来源校准的前提：当前引擎已有可用的服务端组默认。 */
export function hasAvailableServerMarkedGroupAuto(
  providers: readonly ProviderView[],
  agent: AgentKind,
  isModelEnabled?: Parameters<typeof matchingModel>[4],
): boolean {
  return connectedProvidersForAgent([...providers], agent).some(
    (provider) =>
      isCindyDistributedProvider(provider) &&
      isAvailableDefaultProvider(provider) &&
      matchingModel(provider, agent, [], 'serverMarkedGroupAuto', isModelEnabled) !== undefined,
  );
}

/**
 * 为“尚未自定义”的本地新任务与伙伴按产品顺序挑选可用默认组合。
 *
 * 返回空数组表示没有足够证据给默认值：供应商仍在加载、没有可用来源，或推荐与允许的回退
 * 都不在当前账号的可用目录里。调用方此时保留连接引导/既有空态，绝不编造一个看似可发送的组合。
 */
export function resolveNewMakerDefaultTuples(args: {
  providers: readonly ProviderView[];
  providersLoading: boolean;
  availableAgents: ReadonlySet<MakerVendor>;
  availableAgentsLoaded: boolean;
  isModelEnabled?: (agent: AgentKind, providerId: string, model: { id: string; defaultEnabled?: boolean }) => boolean;
}): NewMakerDefaultTuple[] {
  const { providers, providersLoading, availableAgents, availableAgentsLoaded } = args;
  if (providersLoading || !availableAgentsLoaded) return [];
  const tuples: NewMakerDefaultTuple[] = [];

  for (const policy of DEFAULT_POLICIES) {
    const isPolicyProvider = (candidate: ProviderView) =>
      providerCatalogId(candidate) === policy.providerId;
    const matchingProviders = providers
      .filter(
        (candidate) =>
          ((isPolicyProvider(candidate) && candidate.access?.kind === policy.accessKind) ||
            (policy.serverMarkedAuto === true && isCindyDistributedProvider(candidate))) &&
          isAvailableDefaultProvider(candidate),
      )
      // 服务端每个引擎只标一个默认；管理员恰在两次拉取之间改配置时，Cindy AI 与号池可能
      // 短暂各标一个，此时以 Cindy AI 为准，不取决于来源列表的顺序。
      .sort((a, b) => Number(isPolicyProvider(b)) - Number(isPolicyProvider(a)));
    const passes: ModelSearchPass[] = [
      ...(policy.serverMarkedAuto ? ['serverMarkedAuto' as const] : []),
      'preferred',
      ...(policy.allowOtherModels === false ? [] : ['other' as const]),
    ];
    // Search every account for the recommendation before falling back to other
    // enabled models. An earlier account's fallback must not hide a later Sol.
    policySearch: for (const pass of passes) {
      for (const provider of matchingProviders) {
        for (const agent of policy.agents) {
          const vendor = vendorForAgent(agent);
          if (!availableAgents.has(vendor)) continue;
          const model = matchingModel(provider, agent, policy.modelIds, pass, args.isModelEnabled);
          if (!model) continue;
          tuples.push({
            vendor,
            providerId: provider.id,
            model: model.id,
            // Missing or stale optional metadata does not disqualify a usable route.
            effort: model.efforts.length === 0 ? null
              : model.defaultEffort === null ? null
                : (clampEffortToSupported(model.defaultEffort, model.efforts)
                  ?? defaultEffortForCapabilities(model.efforts)) as Effort | null,
          });
          break policySearch;
        }
      }
    }
  }
  return tuples;
}

/** The first candidate remains the ordinary new-task default. */
export function resolveNewMakerDefaultTuple(
  args: Parameters<typeof resolveNewMakerDefaultTuples>[0],
): NewMakerDefaultTuple | null {
  return resolveNewMakerDefaultTuples(args)[0] ?? null;
}
