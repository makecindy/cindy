/**
 * 供应商路由(shared/modelGroups.ts 的 ModelGroupSourceRoute)在这台电脑上的两件事，都是纯函数：
 *   - 自动合成：同一家的几个已连接的供应商自动合成一条(成员跟着连接增减，不存盘)；
 *   - 展开：一条供应商路由在它成员提供的每个模型上展开成一条普通路由，之后选路、说明、撞配额换来源都走普通路由那一套。
 * 「能不能为新任务选用」由调用方给，与解析路由时用的是同一个判断。
 */
import { createHash } from 'node:crypto';
import { isAntigravityEngine } from '@cindy/maker-shared/branding';
import {
  listedSourceFolds,
  recommendedAgentForModel,
  resolveWireModelId,
  unifiedModelKeyId,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import { resolveProviderLogoKind } from '@cindy/model-providers/branding';
import {
  MODEL_GROUP_AUTO_PREFIX,
  MODEL_GROUP_EXPANDED_LIMIT,
  MODEL_GROUP_EXPANDED_PREFIX,
  MODEL_GROUP_LIMITS,
  type ModelGroupAgentKind,
  type ModelGroupCandidate,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupSource,
  type ModelGroupSourceRoute,
  modelGroupSourceKey,
} from '../../shared/modelGroups.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineModelDisabled,
  isPluginEngineOfferedRemotely,
  pluginEngineKeyFromProviderId,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';
import { isOrganizationPluginNamespace, parsePluginStoragePart } from '../../shared/pluginIdentity.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';

const GROUP_KIND: Partial<Record<AgentKind, ModelGroupAgentKind>> = { 'claude-code': 'cc', codex: 'codex', pi: 'pi' };

/** 这些不是「一家」：Cindy AI 是转接多家模型的按量付费入口，不和任何一家自动合在一起(用户可以自己建路由把它加进去)。 */
const NOT_A_FAMILY = new Set(['xd', 'cindy']);
/** 同一家的不同图标。 */
const FAMILY_OF: Record<string, string> = { 'openai-spectrum': 'openai' };

/** 一个供应商属于哪一家：按它的品牌图标认(设置页和选择器显示的那个)。认不出品牌的自建连接不自动合。 */
export function providerFamily(view: ProviderView): string | null {
  const kind = view.logoKind ?? resolveProviderLogoKind(view.id, view.routing);
  if (!kind || NOT_A_FAMILY.has(kind)) return null;
  return FAMILY_OF[kind] ?? kind;
}

const usable = (view: ProviderView) => view.connected && !view.suspended && !view.removed && !view.subscriptionPoolAlias;

const usableLocalPluginEngine = (engine: PluginEngineView) => !engine.suspended && engine.availability.state !== 'unavailable';
const usableRemotePluginEngine = (engine: PluginEngineView) => isPluginEngineOfferedRemotely(engine);

/** 一个插件执行引擎属于哪一家：Antigravity 跨安装来源归同一家，其余按同一插件+引擎标识归一家(去掉独立账号后缀)。 */
export function pluginEngineFamily(engine: Pick<PluginEngineView, 'providerId' | 'ghostId' | 'name'>): string | null {
  if (isAntigravityEngine(engine)) return 'antigravity';
  const rawKey = pluginEngineKeyFromProviderId(engine.providerId);
  if (!rawKey) return null;
  const baseKey = rawKey.replace(/~[a-z0-9]{8}$/, '');
  const sep = baseKey.lastIndexOf(':');
  if (sep <= 0 || sep >= baseKey.length - 1) return null;
  const storagePart = baseKey.slice(0, sep);
  const harnessId = baseKey.slice(sep + 1);
  const parsed = parsePluginStoragePart(storagePart);
  if (!parsed) return `acp:${baseKey}`;
  return isOrganizationPluginNamespace(parsed.namespace)
    ? `acp:${storagePart}:${harnessId}`
    : `acp:${parsed.ghostId}:${harnessId}`;
}

export function isPluginEngineModelSelectable(engine: PluginEngineView, modelId: string): boolean {
  const disabledIds = engine.disabledModels?.map((item) => item.id);
  if (isPluginEngineModelDisabled(modelId, disabledIds)) return false;
  if (modelId === PLUGIN_ENGINE_DEFAULT_MODEL) return engine.defaultModelAllowed !== false;
  return engine.models.length === 0 || engine.models.some((item) => item.id === modelId);
}

/** 本机多账号订阅池里的单个账号视图，用于把多账号池拆平为路由的独立成员，避免两层自动选路。 */
export interface SourceCatalogAccount {
  id: string;
  label: string;
  accountKey?: string;
  paused?: boolean;
  usable?: boolean;
  /** 若该账号只提供供应商目录里的子集模型（如 Codex 按账号发现），列出归一化后的模型 id。 */
  supportedModelIds?: ReadonlySet<string>;
  apiConnectionId?: string;
}

/** 合成与展开用的目录：本机的供应商、多账号池账号、插件引擎与可用引擎；其他电脑与分享来的位置各自允许远程调用的供应商与插件引擎(读得到的那些)。 */
export interface SourceCatalog {
  views: readonly ProviderView[];
  agents: readonly string[];
  /** 本机多账号订阅池的账号列表（键 = providerId）；未传时沿用整供应商粒度。 */
  localAccounts?: ReadonlyMap<string, readonly SourceCatalogAccount[]>;
  /** 本机已安装的插件执行引擎(如 Antigravity)。 */
  pluginEngines?: readonly PluginEngineView[];
  /** 运行位置(另一台电脑的设备 id 或 `share:<id>`) → 那里的供应商。没读到的位置不在里面。 */
  remote?: ReadonlyMap<string, readonly ProviderView[]>;
  /** 运行位置(另一台电脑的设备 id 或 `share:<id>`) → 那里开放的插件执行引擎。 */
  remotePluginEngines?: ReadonlyMap<string, readonly PluginEngineView[]>;
  /** 这个来源现在能不能为新任务选用；views / agents 是它所在位置的目录。 */
  available(candidate: ModelGroupCandidate, views: readonly ProviderView[], agents: readonly string[]): boolean;
  /** 插件执行引擎的可用性检查；不传时按本机未停用且可用 / 远程已开放远程调用 + 模型允许判断。 */
  pluginEngineAvailable?(candidate: ModelGroupCandidate, engine: PluginEngineView): boolean;
}

/** 别的位置上可以远程调用的引擎，与插件卡片里的远程模型同一份名单。 */
const REMOTE_AGENTS: readonly string[] = ['codex', 'claude-code', 'pi'];

const locationViews = (catalog: SourceCatalog, agentDeviceId: string | undefined) =>
  (agentDeviceId ? catalog.remote?.get(agentDeviceId) ?? [] : catalog.views);
const locationPluginEngines = (catalog: SourceCatalog, agentDeviceId: string | undefined) =>
  (agentDeviceId ? catalog.remotePluginEngines?.get(agentDeviceId) ?? [] : catalog.pluginEngines ?? []);
const locationAgents = (catalog: SourceCatalog, agentDeviceId: string | undefined) => (agentDeviceId ? REMOTE_AGENTS : catalog.agents);

type FamilyMember = {
  id: string;
  name: string;
  view?: ProviderView;
  agentDeviceId?: string;
  accountId?: string;
  account?: SourceCatalogAccount;
};

const memberSourceKey = (member: Pick<FamilyMember, 'id' | 'agentDeviceId' | 'accountId'>) =>
  modelGroupSourceKey({
    providerId: member.id,
    ...(member.agentDeviceId ? { agentDeviceId: member.agentDeviceId } : {}),
    ...(member.accountId ? { accountId: member.accountId } : {}),
  });

const isOwnProviderView = (view: ProviderView | undefined, agentDeviceId: string | undefined): view is ProviderView =>
  Boolean(view) && (!agentDeviceId || !isProviderShareAgentDeviceId(agentDeviceId));

/**
 * 本机供应商有 2 个及以上账号时，拆平为各自独立的路由成员(只列未暂停的)，不再嵌套内层自动选路。
 * 是否拆开按账号数而不是未暂停的账号数：暂停其中一个后，剩下那个仍是带账号的来源，用户在它上面的开关、权重与顺序照样生效。
 */
function flattenableAccounts(
  catalog: Pick<SourceCatalog, 'localAccounts'>,
  providerId: string,
): readonly SourceCatalogAccount[] | null {
  const all = catalog.localAccounts?.get(providerId);
  const active = all?.filter((account) => account.paused !== true);
  return all && all.length >= 2 && active && active.length > 0 ? active : null;
}

function accountKeysFor(
  view: ProviderView | undefined,
  accountId: string | undefined,
  account: SourceCatalogAccount | undefined,
): readonly string[] {
  if (accountId) return account?.accountKey ? [account.accountKey] : [];
  return view?.subscriptionAccountKeys ?? [];
}

interface RunnableProviderModel {
  key: string;
  name: string;
  candidate: ModelGroupCandidate;
}

/**
 * 一个普通供应商成员此刻能展开出的全部聊天模型（复用 locationViews / locationAgents / recommendedAgentForModel /
 * resolveWireModelId / catalog.available）。既给 expandSourceRoute 展开候选，也给 withoutRepeatedAccounts
 * 判断模型覆盖，保证两处口径完全一致，不再误用浏览列表的 subscriptionModelsCoveredBy（它会因 Fast 开关、
 * effortsUnknown 或媒体模型差异把同账号远端错误留下）。
 */
function runnableProviderModels(
  catalog: Pick<SourceCatalog, 'views' | 'agents' | 'available' | 'remote' | 'localAccounts'>,
  view: ProviderView,
  source: Pick<ModelGroupSource, 'agentDeviceId' | 'accountId' | 'off' | 'weight'>,
  account?: SourceCatalogAccount,
): RunnableProviderModel[] {
  if (!usable(view)) return [];
  const views = locationViews(catalog as SourceCatalog, source.agentDeviceId);
  const agents = locationAgents(catalog as SourceCatalog, source.agentDeviceId);
  const allowed = agents.filter((agent): agent is AgentKind => agent in GROUP_KIND);
  const seen = new Set<string>();
  const out: RunnableProviderModel[] = [];
  for (const agent of allowed) {
    for (const model of view.models?.[agent] ?? []) {
      const key = sourceModelKey(view, agent, model.id);
      if (model.disabled || seen.has(key)) continue;
      if (account?.supportedModelIds && !account.supportedModelIds.has(model.id.replace(/^chatgpt\//, ''))) continue;
      // 一个供应商在一个模型上只占一个位置：用这个模型在它上面的推荐引擎，与选择器点这一行时相同。
      const own = unifiedModelKeyId(model.id);
      const recommended = recommendedAgentForModel(views as ProviderView[], view.id, own, { agents: allowed });
      const agentKind = recommended ? GROUP_KIND[recommended] : undefined;
      const wire = recommended ? resolveWireModelId(view, own, recommended) : null;
      if (!recommended || !agentKind || !wire) continue;
      const candidate: ModelGroupCandidate = {
        agentKind, providerId: view.id, model: wire,
        ...(source.agentDeviceId ? { agentDeviceId: source.agentDeviceId } : {}),
        ...(source.accountId ? { accountId: source.accountId } : {}),
        ...(source.off ? { off: true } : {}), ...(source.weight ? { weight: source.weight } : {}),
      };
      if (!catalog.available(candidate, views, agents)) continue;
      seen.add(key);
      out.push({
        key,
        name: view.models?.[recommended]?.find((item) => item.id === wire)?.name ?? model.name ?? key,
        candidate,
      });
    }
  }
  return out;
}

/**
 * 同一份配额只算一个成员(2026-11-27 用户反馈)：自己电脑上的一个成员，账号全都已经在其他未停用同账号成员里
 * （如本机拆平后的账号 A、B 共同覆盖另一台电脑上的 A 或 [A, B]），且它实际可运行的聊天模型覆盖方也都能运行时，
 * 不再列它——经它跑用的还是那份配额，只会让按额度挑重复计算、出问题时换到同一份已满的配额上。
 * 规则：绝不因远端电脑而剔除本机来源；已停用成员不作为覆盖方；分享来的读不到账号身份、插件引擎无订阅账号池，均不参与。
 */
function withoutRepeatedAccounts(
  members: readonly FamilyMember[],
  catalog: Pick<SourceCatalog, 'views' | 'agents' | 'available' | 'remote' | 'localAccounts'>,
  offKeys: ReadonlySet<string>,
): FamilyMember[] {
  const runnableKeys = members.map((member) => (
    isOwnProviderView(member.view, member.agentDeviceId)
      ? new Set(runnableProviderModels(
          catalog,
          member.view,
          {
            ...(member.agentDeviceId ? { agentDeviceId: member.agentDeviceId } : {}),
            ...(member.accountId ? { accountId: member.accountId } : {}),
          },
          member.account,
        ).map((item) => item.key))
      : null
  ));
  const keysOf = members.map((member) => accountKeysFor(member.view, member.accountId, member.account));
  const modelsCoveredBy = (innerModels: ReadonlySet<string>, outerModels: ReadonlySet<string> | null) => {
    if (!outerModels) return false;
    for (const key of innerModels) if (!outerModels.has(key)) return false;
    return true;
  };
  const singleCovers = (outerIndex: number, innerIndex: number) => {
    const outer = members[outerIndex];
    const inner = members[innerIndex];
    if (!isOwnProviderView(outer.view, outer.agentDeviceId) || !isOwnProviderView(inner.view, inner.agentDeviceId)) return false;
    // 绝不因远端电脑而剔除本机来源。
    if (!inner.agentDeviceId && outer.agentDeviceId) return false;
    if (offKeys.has(memberSourceKey(outer))) return false;
    const innerKeys = keysOf[innerIndex];
    const outerKeys = keysOf[outerIndex];
    if (innerKeys.length === 0 || outerKeys.length === 0) return false;
    if (!innerKeys.every((key) => outerKeys.includes(key))) return false;
    const innerModels = runnableKeys[innerIndex];
    if (!innerModels) return false;
    return modelsCoveredBy(innerModels, runnableKeys[outerIndex]);
  };
  const coveredByActiveLocals = (innerIndex: number) => {
    const inner = members[innerIndex];
    if (!inner.agentDeviceId || !isOwnProviderView(inner.view, inner.agentDeviceId)) return false;
    const innerKeys = keysOf[innerIndex];
    const innerModels = runnableKeys[innerIndex];
    if (innerKeys.length === 0 || !innerModels) return false;
    return innerKeys.every((key) => members.some((outer, outerIndex) =>
      outerIndex !== innerIndex
      && !outer.agentDeviceId
      && isOwnProviderView(outer.view, outer.agentDeviceId)
      && !offKeys.has(memberSourceKey(outer))
      && keysOf[outerIndex].includes(key)
      && modelsCoveredBy(innerModels, runnableKeys[outerIndex])));
  };
  return members.filter((_, index) => {
    if (coveredByActiveLocals(index)) return false;
    return !members.some((_, at) => at !== index && singleCovers(at, index) && (at < index || !singleCovers(index, at)));
  });
}

/**
 * 同一家有两个以上能用的独立来源时自动合成一条：本机多账号池先拆平为各自独立的账号来源（不再两层自动），
 * 再与本机其他同品牌供应商、其他电脑上的、别人分享来的一并汇总。同一个登录在几处出现只算一个；
 * 名字用这一家里排在最前的那个的名字。
 */
export function buildAutoSourceRoutes(
  catalog: Pick<SourceCatalog, 'views' | 'agents' | 'available' | 'remote' | 'localAccounts' | 'pluginEngines' | 'remotePluginEngines'>,
  config: Pick<ModelGroupsConfig, 'hiddenAuto' | 'autoStrategy' | 'autoSwitchOff' | 'autoSources' | 'autoExceptions'>,
  /** 只要只剩一个能用成员的那几家(见 effectiveModelGroupsConfig 的 forSelected)。 */
  single = false,
): ModelGroupSourceRoute[] {
  const views = catalog.views.filter(view => !view.subscriptionPoolAlias);
  const others = [...(catalog.remote ?? [])].map(([deviceId, providers]) => ({ deviceId, providers: providers.filter(view => !view.subscriptionPoolAlias) }));
  // 去重只在自己的电脑之间做(同一个登录在两台电脑上算一个)。别人分享来的各是各的账号，即使供应商同名也都算成员，
  // 与选择器一致：分享不参与这条合并规则。
  const folds = listedSourceFolds({ base: views, others: others.filter((other) => !isProviderShareAgentDeviceId(other.deviceId)) });
  const families = new Map<string, FamilyMember[]>();
  const add = (view: ProviderView, agentDeviceId?: string) => {
    const family = usable(view) ? providerFamily(view) : null;
    if (!family) return;
    if (!agentDeviceId) {
      const accounts = flattenableAccounts(catalog, view.id);
      if (accounts) {
        const expanded = accounts.map((account): FamilyMember => ({
          id: view.id,
          name: view.name,
          view,
          accountId: account.id,
          account,
        }));
        families.set(family, [...(families.get(family) ?? []), ...expanded]);
        return;
      }
    }
    families.set(family, [...(families.get(family) ?? []), { id: view.id, name: view.name, view, ...(agentDeviceId ? { agentDeviceId } : {}) }]);
  };
  const addPluginEngine = (engine: PluginEngineView, agentDeviceId?: string) => {
    const ok = agentDeviceId ? usableRemotePluginEngine(engine) : usableLocalPluginEngine(engine);
    const hasModels = engine.models.length > 0 || engine.defaultModelAllowed !== false;
    const family = ok && hasModels ? pluginEngineFamily(engine) : null;
    if (family) families.set(family, [...(families.get(family) ?? []), { id: engine.providerId, name: engine.name, ...(agentDeviceId ? { agentDeviceId } : {}) }]);
  };
  for (const view of views) if (!folds.hiddenBase.has(view.id)) add(view);
  for (const { deviceId, providers } of others) {
    for (const view of providers) if (!folds.hiddenOther.get(deviceId)?.has(view.id)) add(view, deviceId);
  }
  for (const engine of catalog.pluginEngines ?? []) addPluginEngine(engine);
  for (const [deviceId, engines] of catalog.remotePluginEngines ?? []) {
    for (const engine of engines) addPluginEngine(engine, deviceId);
  }
  const hidden = new Set(config.hiddenAuto ?? []);
  const switchOff = new Set(config.autoSwitchOff ?? []);
  const routes: ModelGroupSourceRoute[] = [];
  for (const [family, found] of families) {
    const id = `${MODEL_GROUP_AUTO_PREFIX}${family}`.slice(0, MODEL_GROUP_LIMITS.id);
    // 成员是谁仍按连接自动定；用户排过先后、填过权重、暂停过的，按他存的来(没排到的新成员排在后面)。
    // 升级兼容：旧版整供应商停用/排序记录自动继承给刚拆平的本机账号成员，直到用户单独调整。
    const saved = config.autoSources?.[id] ?? [];
    const rank = new Map(saved.map((source, index) => [modelGroupSourceKey(source), { index, source }]));
    const savedFor = (source: Pick<ModelGroupSource, 'providerId' | 'agentDeviceId' | 'accountId'>) =>
      rank.get(modelGroupSourceKey(source))
      ?? (source.accountId ? rank.get(modelGroupSourceKey({ providerId: source.providerId })) : undefined);
    const offKeys = new Set<string>();
    for (const member of found) {
      const source = {
        providerId: member.id,
        ...(member.agentDeviceId ? { agentDeviceId: member.agentDeviceId } : {}),
        ...(member.accountId ? { accountId: member.accountId } : {}),
      };
      if (savedFor(source)?.source.off) offKeys.add(memberSourceKey(member));
    }
    const members = withoutRepeatedAccounts(found, catalog, offKeys);
    if (single ? members.length !== 1 : members.length < 2) continue;
    const detected = members.map(({ id: providerId, agentDeviceId, accountId }): ModelGroupSource => ({
      providerId,
      ...(agentDeviceId ? { agentDeviceId } : {}),
      ...(accountId ? { accountId } : {}),
    }));
    const ordered = detected
      .map((source, index) => ({ source, index, saved: savedFor(source) }))
      .sort((a, b) => (a.saved ? a.saved.index : saved.length + a.index) - (b.saved ? b.saved.index : saved.length + b.index) || a.index - b.index)
      .map(({ source, saved: kept }): ModelGroupSource => ({
        ...source, ...(kept?.source.off ? { off: true } : {}), ...(kept?.source.weight ? { weight: kept.source.weight } : {}),
      }));
    routes.push({
      id,
      name: members[0].name.slice(0, MODEL_GROUP_LIMITS.name),
      strategy: config.autoStrategy?.[id] ?? 'expiring',
      sources: ordered.slice(0, MODEL_GROUP_LIMITS.candidates),
      ...(switchOff.has(id) ? { autoSwitch: false as const } : {}),
      ...(config.autoExceptions?.[id]?.length ? { exceptions: config.autoExceptions[id] } : {}),
      auto: true,
      ...(hidden.has(id) ? { hidden: true as const } : {}),
    });
  }
  return routes;
}

/**
 * 模型的身份：认不出是同一个的不合并，不靠显示名猜。这几种写法算同一个模型(model-groups.md §3.4：带不带厂商前缀
 * 视为同一个)：桥接前缀(chatgpt/ 等)；连接自己声明的发送前要去掉的前缀(routing.modelIdRewrite.stripPrefix)；
 * 转接入口与组织连接在模型前加的那一段「厂商/」「连接名/」(openai/gpt-x、byok-连接名/gpt-x)。只去掉恰好一段前缀：
 * 多级路径(accounts/x/models/y)是那个入口自己的编号方式，原样保留。不分大小写。
 */
export function sourceModelKey(view: ProviderView, agent: AgentKind, modelId: string): string {
  const declared = view.routing?.[agent]?.modelIdRewrite?.stripPrefix;
  const id = (declared && modelId.startsWith(declared) ? modelId.slice(declared.length) : modelId).toLowerCase();
  return unifiedModelKeyId(id.replace(/^[a-z0-9][a-z0-9._-]*\/([^/]+)$/, '$1'));
}

/** 展开出来的路由 id 与模型一一对应、稳定不变；每次选路都要重新展开，算过的直接用(有上限)。 */
const expandedIds = new Map<string, string>();
const expandedId = (routeId: string, modelKey: string) => {
  const key = `${routeId}\u0000${modelKey}`;
  let id = expandedIds.get(key);
  if (!id) {
    id = `${MODEL_GROUP_EXPANDED_PREFIX}${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    if (expandedIds.size >= 4096) expandedIds.clear();
    expandedIds.set(key, id);
  }
  return id;
};

export function pluginEngineSourceModelKey(modelId: string): string {
  return unifiedModelKeyId(modelId.toLowerCase().replace(/^[a-z0-9][a-z0-9._-]*\/([^/]+)$/, '$1'));
}

/** 把手动建的供应商路由里仍指向整池的本机多账号成员拆平为单账号来源，避免嵌套两层自动。 */
function flattenManualSourceRoute(route: ModelGroupSourceRoute, catalog: SourceCatalog): ModelGroupSourceRoute {
  let changed = false;
  const seen = new Set<string>();
  const flattened: ModelGroupSource[] = [];
  for (const source of route.sources) {
    if (!source.agentDeviceId && !source.accountId) {
      const accounts = flattenableAccounts(catalog, source.providerId);
      if (accounts) {
        changed = true;
        for (const account of accounts) {
          const item: ModelGroupSource = { ...source, accountId: account.id };
          const key = modelGroupSourceKey(item);
          if (seen.has(key)) continue;
          seen.add(key);
          flattened.push(item);
        }
        continue;
      }
    }
    const key = modelGroupSourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    flattened.push(source);
  }
  return changed ? { ...route, sources: flattened.slice(0, MODEL_GROUP_LIMITS.candidates) } : route;
}

/** 一条供应商路由展开成每个模型一条普通路由：成员里谁提供这个模型，谁就是这条的来源(顺序同成员顺序)。 */
export function expandSourceRoute(route: ModelGroupSourceRoute, catalog: SourceCatalog): ModelGroupRoute[] {
  type ExpandedItem = { candidate: ModelGroupCandidate; view?: ProviderView; account?: SourceCatalogAccount; off?: boolean };
  const byModel = new Map<string, { name: string; items: ExpandedItem[] }>();
  for (const source of route.sources) {
    if (pluginEngineKeyFromProviderId(source.providerId)) {
      const engine = locationPluginEngines(catalog, source.agentDeviceId).find((item) => item.providerId === source.providerId);
      const ok = engine && (source.agentDeviceId ? usableRemotePluginEngine(engine) : usableLocalPluginEngine(engine));
      if (!engine || !ok) continue;
      const models = engine.models.length > 0
        ? engine.models
        : (engine.defaultModelAllowed !== false ? [{ id: PLUGIN_ENGINE_DEFAULT_MODEL, displayName: PLUGIN_ENGINE_DEFAULT_MODEL }] : []);
      const seen = new Set<string>();
      for (const model of models) {
        if (!isPluginEngineModelSelectable(engine, model.id)) continue;
        const key = pluginEngineSourceModelKey(model.id);
        if (seen.has(key)) continue;
        const candidate: ModelGroupCandidate = {
          agentKind: 'acp', providerId: engine.providerId, model: model.id,
          ...(source.agentDeviceId ? { agentDeviceId: source.agentDeviceId } : {}),
          ...(source.off ? { off: true } : {}), ...(source.weight ? { weight: source.weight } : {}),
        };
        if (catalog.pluginEngineAvailable && !catalog.pluginEngineAvailable(candidate, engine)) continue;
        seen.add(key);
        const entry = byModel.get(key) ?? { name: model.displayName || model.id, items: [] };
        entry.items.push({ candidate, off: source.off });
        byModel.set(key, entry);
      }
      continue;
    }
    const views = locationViews(catalog, source.agentDeviceId);
    const view = views.find((item) => item.id === source.providerId);
    if (!view || !usable(view)) continue;
    const account = !source.agentDeviceId && source.accountId
      ? catalog.localAccounts?.get(source.providerId)?.find((item) => item.id === source.accountId)
      : undefined;
    for (const { key, name, candidate } of runnableProviderModels(catalog, view, source, account)) {
      const entry = byModel.get(key) ?? { name, items: [] };
      entry.items.push({ candidate, view, account, off: source.off });
      byModel.set(key, entry);
    }
  }
  const deduplicateCandidates = (items: readonly ExpandedItem[]): ModelGroupCandidate[] => {
    if (!route.auto || items.length < 2) return items.map((item) => item.candidate);
    const keysOf = items.map((item) => accountKeysFor(item.view, item.candidate.accountId, item.account));
    // 自动路由按模型展开时同样做账号去重：远端成员若其账号全部已被未停用的本机成员（含拆平后的多个本机账号）覆盖，
    // 展开到本机已能跑的共同模型时不再把同一份配额重复放进候选列表。
    const singleCovers = (outerIndex: number, innerIndex: number) => {
      const outer = items[outerIndex];
      const inner = items[innerIndex];
      if (outer.off) return false;
      if (!isOwnProviderView(outer.view, outer.candidate.agentDeviceId) || !isOwnProviderView(inner.view, inner.candidate.agentDeviceId)) return false;
      if (!inner.candidate.agentDeviceId && outer.candidate.agentDeviceId) return false;
      const innerKeys = keysOf[innerIndex];
      const outerKeys = keysOf[outerIndex];
      return innerKeys.length > 0 && outerKeys.length > 0 && innerKeys.every((key) => outerKeys.includes(key));
    };
    const coveredByActiveLocals = (innerIndex: number) => {
      const inner = items[innerIndex];
      if (!inner.candidate.agentDeviceId || !isOwnProviderView(inner.view, inner.candidate.agentDeviceId)) return false;
      const innerKeys = keysOf[innerIndex];
      if (innerKeys.length === 0) return false;
      return innerKeys.every((key) => items.some((outer, outerIndex) =>
        outerIndex !== innerIndex
        && !outer.off
        && !outer.candidate.agentDeviceId
        && isOwnProviderView(outer.view, outer.candidate.agentDeviceId)
        && keysOf[outerIndex].includes(key)));
    };
    return items
      .filter((_, index) => !coveredByActiveLocals(index)
        && !items.some((_, at) => at !== index && singleCovers(at, index) && (at < index || !singleCovers(index, at))))
      .map((item) => item.candidate);
  };
  return [...byModel].map(([key, entry]): ModelGroupRoute => ({
    id: expandedId(route.id, key),
    name: entry.name.slice(0, MODEL_GROUP_LIMITS.name),
    strategy: route.strategy,
    candidates: deduplicateCandidates(entry.items),
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.autoSwitch === false ? { autoSwitch: false as const } : {}),
    ...(route.exceptions?.length ? { exceptions: route.exceptions } : {}),
    parent: { id: route.id, name: route.name },
    ...(route.hidden ? { hidden: true as const } : {}),
  }));
}

/**
 * 存盘的配置 + 此刻的目录 = 读取方看到的配置：用户排的路由、供应商路由(用户建的与自动合成的)及其展开。
 *
 * `forSelected`：给「按已选的路由解析」的读取方(新任务与伙伴的选路、任务里撞配额或出问题时换来源)。自动合成的路由在
 * 一家只剩一个能用的连接时不再列出，但已经选了它的任务与设置要照样解析到剩下的那个来源、由它接替(2026-11-26 review)：
 * 这几家的展开也带上，标为隐藏、不进 sourceRoutes，任何列表都不显示，只能按已存的 id 找到；展开 id 与两个连接时相同，
 * 用户在它上面关掉的「出问题时自动换来源」照样生效。
 */
export function effectiveModelGroupsConfig(stored: ModelGroupsConfig, catalog: SourceCatalog | null, options?: { forSelected?: boolean }): ModelGroupsConfig {
  if (!catalog) return stored;
  const manualSourceRoutes = (stored.sourceRoutes ?? []).map((route) => flattenManualSourceRoute(route, catalog));
  const sourceRoutes = [...manualSourceRoutes, ...buildAutoSourceRoutes(catalog, stored)];
  const expanded = sourceRoutes.flatMap((route) => expandSourceRoute(route, catalog)).slice(0, MODEL_GROUP_EXPANDED_LIMIT);
  const kept = options?.forSelected
    ? buildAutoSourceRoutes(catalog, stored, true).flatMap((route) => expandSourceRoute(route, catalog))
      .slice(0, MODEL_GROUP_EXPANDED_LIMIT).map((route): ModelGroupRoute => ({ ...route, hidden: true }))
    : [];
  return {
    ...stored,
    routes: [...stored.routes, ...expanded, ...kept],
    ...(sourceRoutes.length > 0 ? { sourceRoutes } : {}),
  };
}
