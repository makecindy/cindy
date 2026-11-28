/**
 * 供应商路由在选模型面板里的样子(2026-11-24 用户裁决)：合并后的路由就是一个普通供应商——占侧栏一格，模型行与普通行
 * 完全一样(思考深度、Fast、收藏照常能用)，它合并的那几个成员不再各占一格。
 *
 * 做法：按主进程已经展开好的路由(每个模型一条，带 parent)拼出一个只在面板里用的供应商条目，放在第一个成员原来的位置；
 * 选中其中一行时，草稿里记的仍是一个真实成员的模型(显示名、思考深度、Fast 都按它来)，另外记下那条展开的路由——
 * 开任务时由路由按选法决定这次到底用哪个成员。面板外的代码看不到这个拼出来的条目。
 */
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import { resolveProviderLogoKind } from '@cindy/model-providers/branding';

import { isPluginEngineSelectable, type PluginEngineChoice } from '@/lib/pluginEngineSelection';
import type { ModelGroupCandidate, ModelGroupRoute, ModelGroupsConfig, ModelGroupSelection } from '../../../shared/modelGroups';
import { PLUGIN_ENGINE_DEFAULT_MODEL, pluginEngineKeyFromProviderId, type PluginEngineModel } from '../../../shared/pluginEngines';

export const SOURCE_ROUTE_PROVIDER_PREFIX = 'sroute:';

/** 面板里这一格是不是合并了整个供应商的路由(不是一个真实的供应商)。 */
export function isSourceRouteProviderId(providerId: string | null | undefined): boolean {
  return !!providerId && providerId.startsWith(SOURCE_ROUTE_PROVIDER_PREFIX);
}

export interface SourceRouteHit {
  /** 这个模型对应的那条展开的路由：选中后记到草稿的 modelGroup。 */
  route: ModelGroupRoute;
  /** 草稿里记的那个真实成员的模型。 */
  candidate: ModelGroupCandidate;
}

export interface SourceRouteProviders {
  providers: ProviderView[];
  /** 面板里选中了拼出来的供应商的一行：对应哪条路由、记哪个真实成员。不是这种行返回 null。 */
  hit(providerId: string | null | undefined, modelId: string): SourceRouteHit | null;
  /**
   * 合并条目中某一行的可见性：按其背后真实成员在各自位置的可见性覆盖判定，任一成员可见即显示。
   * 不是合并条目或找不到对应路由时返回 null，由调用方按普通供应商规则判定。
   */
  isModelVisible(
    providerId: string,
    modelId: string,
    agent: AgentKind,
    checkMember: (member: {
      agentDeviceId: string | null;
      providerId: string;
      model: CatalogModel;
      agent: AgentKind;
    }) => boolean,
  ): boolean | null;
  /**
   * 草稿里记着的真实成员(或选着的那条展开的路由)在面板里显示成哪个条目；不在任何供应商路由里返回 null。
   * agentDeviceId = 那个成员所在的位置(另一台电脑或分享)，本机省略。
   */
  shownAs(providerId: string | null | undefined, activeRouteId?: string | null, agentDeviceId?: string | null): string | null;
  /**
   * 成员的实际 wire modelId(如 `byok-codex/gpt-6-luna`)在合并条目里对应的代表 modelId(如 `gpt-6-luna`)；
   * 不属于任何合并条目或成员未并入时返回 null。
   */
  shownModelId(providerId: string | null | undefined, modelId: string, activeRouteId?: string | null, agentDeviceId?: string | null): string | null;
  /** 别的位置上的这个供应商已经并进某个合并后的条目：面板里不再单列它那一格。 */
  hidesRemote(agentDeviceId: string, providerId: string): boolean;
  /**
   * 合并后的条目在侧栏显示谁的额度：排在最前、没停用的那个成员(按路由的先后；2026-11-26 用户反馈合并后看不到用量)。
   * 不是合并条目或成员都停用了返回 null。
   */
  usageMember(providerId: string): { provider: ProviderView; agentDeviceId: string | null } | null;
}

const agentOf = (kind: 'cc' | 'codex' | 'pi'): AgentKind => (kind === 'cc' ? 'claude-code' : kind);
const memberKey = (agentDeviceId: string | null | undefined, providerId: string) => `${agentDeviceId ?? ''}\u0000${providerId}`;
const isProviderMemberUsable = (provider: ProviderView): boolean =>
  provider.connected !== false && provider.suspended !== true && provider.removed !== true;

export function withSourceRouteProviders(
  providers: ProviderView[],
  config: ModelGroupsConfig | null | undefined,
  /**
   * 草稿/任务当前记着的模型：
   * - 直接指着某个成员、而合并后的条目里没有这个模型时，那个成员照旧单列，不让当前选择消失；
   * - `keepMember: true` 用于已解除托管 / 未绑定智能路由的进行中任务：保留当前运行的具体成员单列，不强行并回 `sroute:`。
   */
  current?: { providerId?: string | null; modelId: string; agentDeviceId?: string | null; keepMember?: boolean },
  /** 其他电脑与分享来的位置上的供应商(成员可以在那里)；没读到的位置不在里面，那里的成员这次不算。 */
  remote?: ReadonlyMap<string, readonly ProviderView[]>,
  /**
   * 合并后的条目在面板里叫什么(2026-11-25 用户反馈：与普通供应商混在一起分不出来)：调用方给出带「路由、几个来源」
   * 的写法，侧栏提示、模型行下面那一行、「全部」里的分组标题都用它。不给就用路由自己的名字。
   */
  label?: (name: string, members: number) => string,
): SourceRouteProviders {
  const routes = (config?.sourceRoutes ?? []).filter((route) => !route.hidden);
  const none: SourceRouteProviders = {
    providers,
    hit: () => null,
    isModelVisible: () => null,
    shownAs: () => null,
    shownModelId: () => null,
    hidesRemote: () => false,
    usageMember: () => null,
  };
  if (!config || routes.length === 0) return none;
  const viewsAt = (agentDeviceId: string | undefined) => (agentDeviceId ? remote?.get(agentDeviceId) ?? [] : providers);
  const hits = new Map<string, SourceRouteHit>();
  const memberOf = new Map<string, string>();
  const byRoute = new Map<string, string>();
  const routeRepModel = new Map<string, string>();
  const candidateRepModel = new Map<string, { routeProviderId: string; modelId: string }>();
  const routeMembers = new Map<string, { provider: ProviderView; agentDeviceId: string | undefined }[]>();
  const virtual: { entry: ProviderView }[] = [];
  const usageMembers = new Map<string, { provider: ProviderView; agentDeviceId: string | null }>();
  for (const route of routes) {
    // 已被用户取消参与路由的成员(source.off)不再并入合并条目，恢复在选择器里独立显示与选用。
    const members = route.sources
      .filter((source) => !source.off)
      .flatMap((source) => viewsAt(source.agentDeviceId)
        .filter((provider) => provider.id === source.providerId)
        .map((provider) => ({ provider, agentDeviceId: source.agentDeviceId })));
    const id = `${SOURCE_ROUTE_PROVIDER_PREFIX}${route.id}`;
    const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
    for (const child of config.routes) {
      if (child.parent?.id !== route.id || child.hidden) continue;
      // 草稿里记的那个真实成员：优先挑已连接、未停用且未隐藏的来源，避免首个成员停用/隐藏时把坏成员当代表。
      let picked: {
        candidate: ModelGroupCandidate;
        agent: AgentKind;
        model: CatalogModel;
        member: { provider: ProviderView; agentDeviceId: string | undefined };
      } | null = null;
      for (const candidate of child.candidates) {
        if (candidate.off || candidate.agentKind === 'acp') continue;
        const agent = agentOf(candidate.agentKind);
        const member = members.find((item) => item.provider.id === candidate.providerId && (item.agentDeviceId ?? null) === (candidate.agentDeviceId ?? null));
        const model = member?.provider.models?.[agent]?.find((item) => item.id === candidate.model);
        if (!member || !model) continue;
        const usable = isProviderMemberUsable(member.provider);
        if (usable && member.provider.hidden !== true) {
          picked = { candidate, agent, model, member };
          break;
        }
        if (!picked || (usable && !isProviderMemberUsable(picked.member.provider))) {
          picked = { candidate, agent, model, member };
        }
      }
      if (!picked) continue;
      (models[picked.agent] ??= []).push({ ...picked.model, name: child.name });
      hits.set(`${id}\u0000${picked.model.id}`, { route: child, candidate: picked.candidate });
      byRoute.set(child.id, id);
      routeRepModel.set(child.id, picked.model.id);
      for (const candidate of child.candidates) {
        if (candidate.off || candidate.agentKind === 'acp') continue;
        const key = `${memberKey(candidate.agentDeviceId, candidate.providerId)}\u0000${candidate.model}`;
        if (!candidateRepModel.has(key)) {
          candidateRepModel.set(key, { routeProviderId: id, modelId: picked.model.id });
        }
      }
    }
    const agents = Object.keys(models) as AgentKind[];
    if (members.length === 0 || agents.length === 0) continue;
    routeMembers.set(id, members);
    const usableMembers = members.filter((member) => isProviderMemberUsable(member.provider));
    // 优先以可用且未隐藏成员为底：首个成员被隐藏或停用时，不把整个合并路由标成 hidden/suspended 而连带隐藏其余成员。
    const base = (usableMembers.find((member) => member.provider.hidden !== true)
      ?? usableMembers[0]
      ?? members.find((member) => member.provider.hidden !== true)
      ?? members[0]).provider;
    const lead = usableMembers[0] ?? members[0];
    if (lead) usageMembers.set(id, { provider: lead.provider, agentDeviceId: lead.agentDeviceId ?? null });
    // 以选中的底成员沿用品牌、接入方式与图标；模型与各引擎的路由信息取全部成员的，成员私有的隐藏/停用/账号状态一律剥离。
    virtual.push({
      entry: {
        ...base,
        id,
        name: label ? label(route.name, members.length) : route.name,
        agents,
        // 合并后的条目自己的 id 认不出品牌：明确沿用底成员的品牌图标。
        logoKind: base.logoKind ?? resolveProviderLogoKind(base.id, base.routing) ?? undefined,
        models: models as ProviderView['models'],
        routing: Object.assign({}, ...members.map((member) => member.provider.routing)) as ProviderView['routing'],
        connected: usableMembers.length > 0,
        hidden: undefined,
        suspended: undefined,
        removed: undefined,
        // 这些说的是某一个成员自己的账号、状态、组与远程设置，不属于合并后的条目。
        subscriptionAccountKeys: undefined,
        subscriptionPoolAlias: undefined,
        subscriptionPoolTarget: undefined,
        subscriptionAccountPool: undefined,
        subscriptionAccount: undefined,
        openAiAccount: undefined,
        subscriptionReadUnavailable: undefined,
        subscriptionReadUnreachable: undefined,
        subscriptionModelsConfirmedAt: undefined,
        subscriptionDisplayModels: undefined,
        subscriptionFastPolicy: undefined,
        modelDiscoveryFailure: undefined,
        disableOverrideCount: undefined,
        remoteInvocationEnabled: undefined,
        remoteModelIds: undefined,
        ...({ group: undefined, runLocation: undefined } as object),
      },
    });
    for (const member of members) {
      const isCurrent = member.provider.id === current?.providerId && (member.agentDeviceId ?? null) === (current.agentDeviceId ?? null);
      if (isCurrent) {
        if (current?.keepMember) continue;
        const currentCovered = hits.has(`${id}\u0000${current!.modelId}`)
          || candidateRepModel.get(`${memberKey(member.agentDeviceId, member.provider.id)}\u0000${current!.modelId}`)?.routeProviderId === id;
        if (!currentCovered) continue;
      }
      memberOf.set(memberKey(member.agentDeviceId, member.provider.id), id);
    }
  }
  if (virtual.length === 0) return none;
  return {
    // 合并后的条目排在普通供应商前面(侧栏里紧跟「智能路由」那一格，自成一组)，成员不再单列。
    providers: [
      ...virtual.map((item) => item.entry),
      ...providers.filter((provider) => !memberOf.has(memberKey(null, provider.id))),
    ],
    hit: (providerId, modelId) => (providerId ? hits.get(`${providerId}\u0000${modelId}`) ?? null : null),
    isModelVisible: (providerId, modelId, agent, checkMember) => {
      if (!isSourceRouteProviderId(providerId)) return null;
      const hit = hits.get(`${providerId}\u0000${modelId}`);
      const members = routeMembers.get(providerId);
      if (!hit || !members) return null;
      let checked = false;
      for (const candidate of hit.route.candidates) {
        if (candidate.off || candidate.agentKind === 'acp') continue;
        const candidateAgent = agentOf(candidate.agentKind);
        if (candidateAgent !== agent) continue;
        const member = members.find((item) =>
          item.provider.id === candidate.providerId && (item.agentDeviceId ?? null) === (candidate.agentDeviceId ?? null));
        const candidateModel = member?.provider.models?.[candidateAgent]?.find((item) => item.id === candidate.model);
        if (!member || !candidateModel) continue;
        checked = true;
        if (checkMember({
          agentDeviceId: candidate.agentDeviceId ?? null,
          providerId: candidate.providerId,
          model: candidateModel,
          agent: candidateAgent,
        })) {
          return true;
        }
      }
      return checked ? false : null;
    },
    shownAs: (providerId, activeRouteId, agentDeviceId) =>
      (activeRouteId && byRoute.get(activeRouteId)) || (providerId ? memberOf.get(memberKey(agentDeviceId, providerId)) ?? null : null),
    shownModelId: (providerId, modelId, activeRouteId, agentDeviceId) => {
      if (activeRouteId && routeRepModel.has(activeRouteId)) return routeRepModel.get(activeRouteId) ?? null;
      if (!providerId) return null;
      const mapped = candidateRepModel.get(`${memberKey(agentDeviceId, providerId)}\u0000${modelId}`);
      if (!mapped) return null;
      return memberOf.get(memberKey(agentDeviceId, providerId)) === mapped.routeProviderId ? mapped.modelId : null;
    },
    hidesRemote: (agentDeviceId, providerId) => memberOf.has(memberKey(agentDeviceId, providerId)),
    usageMember: (providerId) => usageMembers.get(providerId) ?? null,
  };
}

export interface SourceRoutePluginEngines {
  engines: PluginEngineChoice[];
  hit(providerId: string | null | undefined, modelId: string): SourceRouteHit | null;
  shownAs(providerId: string | null | undefined, activeRouteId?: string | null, deviceId?: string | null): string | null;
}

/**
 * 合并了插件执行引擎(如本机 Antigravity + 分享来的 Antigravity)的供应商路由在选择器里的样子：
 * 与内置供应商路由同一条规则，拼成一个带路由角标的插件引擎格，它合并的成员不再各自单列。
 */
export function withSourceRoutePluginEngines(
  engines: readonly PluginEngineChoice[],
  config: ModelGroupsConfig | null | undefined,
  current?: { providerId: string; modelId: string; deviceId?: string | null; keepMember?: boolean } | null,
  label?: (name: string, members: number) => string,
): SourceRoutePluginEngines {
  const routes = (config?.sourceRoutes ?? []).filter((route) => !route.hidden);
  const none: SourceRoutePluginEngines = { engines: [...engines], hit: () => null, shownAs: () => null };
  if (!config || routes.length === 0 || engines.length === 0) return none;
  const hits = new Map<string, SourceRouteHit>();
  const memberOf = new Map<string, string>();
  const byRoute = new Map<string, string>();
  const virtual: PluginEngineChoice[] = [];
  for (const route of routes) {
    // 混有内置供应商与插件引擎的手动路由由 withSourceRouteProviders 承载，不重复拼第二格。
    if (route.sources.some((source) => !source.off && !pluginEngineKeyFromProviderId(source.providerId))) continue;
    // 已被用户取消参与路由的成员(source.off)不再并入合并条目，恢复独立显示与选用。
    const members = route.sources
      .filter((source) => !source.off)
      .flatMap((source) => engines.filter((engine) =>
        engine.providerId === source.providerId && (engine.deviceId ?? null) === (source.agentDeviceId ?? null)));
    if (members.length === 0) continue;
    const id = `${SOURCE_ROUTE_PROVIDER_PREFIX}${route.id}`;
    const isMemberUsable = (engine: PluginEngineChoice) => isPluginEngineSelectable(engine) && !engine.suspended;
    const models: PluginEngineModel[] = [];
    let allowDefault = false;
    let hasUsableCandidate = false;
    for (const child of config.routes) {
      if (child.parent?.id !== route.id || child.hidden) continue;
      let picked: { candidate: ModelGroupCandidate; member: PluginEngineChoice; model?: PluginEngineModel } | null = null;
      for (const candidate of child.candidates) {
        if (candidate.off || candidate.agentKind !== 'acp') continue;
        const member = members.find((engine) =>
          engine.providerId === candidate.providerId && (engine.deviceId ?? null) === (candidate.agentDeviceId ?? null));
        if (!member) continue;
        if (candidate.model === PLUGIN_ENGINE_DEFAULT_MODEL) {
          if (member.defaultModelAllowed === false) continue;
          if (isMemberUsable(member)) {
            picked = { candidate, member };
            break;
          }
          picked ??= { candidate, member };
          continue;
        }
        const model = member.models.find((item) => item.id === candidate.model);
        if (!model) continue;
        if (isMemberUsable(member)) {
          picked = { candidate, member, model };
          break;
        }
        picked ??= { candidate, member, model };
      }
      if (!picked) continue;
      if (isMemberUsable(picked.member)) hasUsableCandidate = true;
      if (picked.model) {
        models.push({ ...picked.model, displayName: child.name });
        hits.set(`${id}\u0000${picked.model.id}`, { route: child, candidate: picked.candidate });
      } else {
        allowDefault = true;
        hits.set(`${id}\u0000${PLUGIN_ENGINE_DEFAULT_MODEL}`, { route: child, candidate: picked.candidate });
      }
      byRoute.set(child.id, id);
    }
    if (models.length === 0 && !allowDefault) continue;
    // 优先以可用成员为底：首个成员暂停或不可用时，不把整个合并路由标成不可用并隐藏仍可用的其余成员。
    const base = members.find((member) => isMemberUsable(member) && member.hidden !== true)
      ?? members.find(isMemberUsable)
      ?? members[0];
    virtual.push({
      ...base,
      key: id,
      providerId: id,
      deviceId: undefined,
      deviceName: undefined,
      name: label ? label(route.name, members.length) : route.name,
      models,
      defaultModelAllowed: allowDefault,
      availability: hasUsableCandidate
        ? (isPluginEngineSelectable(base) ? base.availability : { state: 'available' })
        : (base.availability.state === 'unavailable' ? base.availability : { state: 'unavailable' }),
      reportsUsage: undefined,
      hidden: undefined,
      suspended: undefined,
    });
    for (const member of members) {
      const isCurrent = member.providerId === current?.providerId && (member.deviceId ?? null) === (current.deviceId ?? null);
      if (isCurrent && (current?.keepMember || !hits.has(`${id}\u0000${current!.modelId}`))) continue;
      memberOf.set(memberKey(member.deviceId, member.providerId), id);
    }
  }
  if (virtual.length === 0) return none;
  return {
    engines: [
      ...virtual,
      ...engines.filter((engine) => !memberOf.has(memberKey(engine.deviceId, engine.providerId))),
    ],
    hit: (providerId, modelId) => (providerId ? hits.get(`${providerId}\u0000${modelId}`) ?? null : null),
    shownAs: (providerId, activeRouteId, deviceId) =>
      (activeRouteId && byRoute.get(activeRouteId)) || (providerId ? memberOf.get(memberKey(deviceId, providerId)) ?? null : null),
  };
}

/**
 * 草稿里记的是某条供应商路由成员的模型、却没记路由(升级前留下的草稿、从「最近」或收藏里直接点到成员)：开任务时仍按
 * 那条路由选成员。成员在面板里已经不单列，面板把这个模型显示在合并后的条目下，用户选的只能是合并后的条目——
 * 不能出现「看着是合并的，实际固定用一个成员、出问题也不换」。隐藏了的供应商路由不算，那时成员照旧单列。
 */
export function implicitSourceRouteSelection(
  config: ModelGroupsConfig,
  current: { providerId?: string | null; model: string; agentDeviceId?: string | null },
): ModelGroupSelection | null {
  if (!current.providerId) return null;
  const route = config.routes.find((item) => item.parent && !item.hidden && item.candidates.some((candidate) =>
    !candidate.off
    && (candidate.agentDeviceId ?? null) === (current.agentDeviceId ?? null)
    && candidate.providerId === current.providerId && candidate.model === current.model));
  return route ? { type: 'route', id: route.id } : null;
}

/**
 * 用户按模型排的路由(不含供应商路由展开项 `route.parent` 与隐藏项 `route.hidden`)。
 * 「智能路由」格与「其他电脑」的模式格共用此口径，避免远端供应商路由展开出来的每个模型漏进模式列表。
 */
export function userDefinedModelGroupRoutes(config: ModelGroupsConfig | null | undefined): ModelGroupRoute[] {
  return (config?.routes ?? []).filter((route) => !route.parent && !route.hidden);
}

/**
 * 为本机选择器「其他电脑」那一段过滤某台远程电脑的模型组配置(model-groups.md §6.3)：
 * 1) 剥离该电脑自己的供应商路由展开项(`route.parent`)与隐藏项；
 * 2) 发送时 `draftModelGroupRouting.ts` 只在该电脑本机且开启「允许被远程调用」的来源里选路，
 *    当调用方传入该电脑允许远程调用的供应商集合时，只保留至少含一个可达本地成员(或经时段例外可达)的路由，
 *    并始终保留当前已选中的 `activeRouteId` 以免已选状态凭空消失。
 */
export function filterRemoteDeviceModelGroupsConfig(
  config: ModelGroupsConfig | null | undefined,
  options?: {
    remoteInvocableProviderIds?: ReadonlySet<string>;
    remoteInvocablePluginProviderIds?: ReadonlySet<string>;
    activeRouteId?: string | null;
  },
): ModelGroupsConfig {
  const userDefined = userDefinedModelGroupRoutes(config);
  if (!options?.remoteInvocableProviderIds) return { routes: userDefined };
  const byId = new Map(userDefined.map((route) => [route.id, route]));
  const isRouteCallable = (route: ModelGroupRoute, seen = new Set<string>()): boolean => {
    if (seen.has(route.id)) return false;
    seen.add(route.id);
    // 候选列表为空时（新建空模式或精简载荷）不误判为不可达；列有具体候选时要求至少一项为本机且允许远程调用。
    if (route.candidates.length === 0) return true;
    const hasCallableCandidate = route.candidates.some((candidate) => {
      if (candidate.off || candidate.agentDeviceId) return false;
      if (candidate.agentKind === 'acp') {
        return options.remoteInvocablePluginProviderIds
          ? options.remoteInvocablePluginProviderIds.has(candidate.providerId)
          : true;
      }
      return options.remoteInvocableProviderIds!.has(candidate.providerId);
    });
    if (hasCallableCandidate) return true;
    return (route.exceptions ?? []).some((exception) => {
      if (exception.when.type !== 'hours' || typeof exception.use !== 'object' || exception.use.type !== 'route') return false;
      const target = byId.get(exception.use.routeId);
      return !!target && isRouteCallable(target, seen);
    });
  };
  return {
    routes: userDefined.filter((route) => route.id === options.activeRouteId || isRouteCallable(route)),
  };
}
