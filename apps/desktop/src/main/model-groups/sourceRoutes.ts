/**
 * 供应商路由(shared/modelGroups.ts 的 ModelGroupSourceRoute)在这台电脑上的两件事，都是纯函数：
 *   - 自动合成：同一家的几个已连接的供应商自动合成一条(成员跟着连接增减，不存盘)；
 *   - 展开：一条供应商路由在它成员提供的每个模型上展开成一条普通路由，之后选路、说明、撞配额换来源都走普通路由那一套。
 * 「能不能为新任务选用」由调用方给，与解析路由时用的是同一个判断。
 */
import { createHash } from 'node:crypto';
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
  type ModelGroupSourceRoute,
} from '../../shared/modelGroups.js';
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

const usable = (view: ProviderView) => view.connected && !view.suspended && !view.removed;

/** 合成与展开用的目录：本机的供应商与可用引擎；其他电脑与分享来的位置各自允许远程调用的供应商(读得到的那些)。 */
export interface SourceCatalog {
  views: readonly ProviderView[];
  agents: readonly string[];
  /** 运行位置(另一台电脑的设备 id 或 `share:<id>`) → 那里的供应商。没读到的位置不在里面。 */
  remote?: ReadonlyMap<string, readonly ProviderView[]>;
  /** 这个来源现在能不能为新任务选用；views / agents 是它所在位置的目录。 */
  available(candidate: ModelGroupCandidate, views: readonly ProviderView[], agents: readonly string[]): boolean;
}

/** 别的位置上可以远程调用的引擎，与插件卡片里的远程模型同一份名单。 */
const REMOTE_AGENTS: readonly string[] = ['codex', 'claude-code', 'pi'];

const locationViews = (catalog: SourceCatalog, agentDeviceId: string | undefined) =>
  (agentDeviceId ? catalog.remote?.get(agentDeviceId) ?? [] : catalog.views);
const locationAgents = (catalog: SourceCatalog, agentDeviceId: string | undefined) => (agentDeviceId ? REMOTE_AGENTS : catalog.agents);

/**
 * 同一家有两个以上能用的供应商时自动合成一条：本机的、其他电脑上的、别人分享来的都算(两个朋友各分享一个 Claude
 * 就是两个成员)。同一个登录在几处出现只算一个，用设置页、选择器同一条合并规则。名字用这一家里排在最前的那个的名字。
 */
export function buildAutoSourceRoutes(
  catalog: Pick<SourceCatalog, 'views' | 'remote'>,
  config: Pick<ModelGroupsConfig, 'hiddenAuto' | 'autoStrategy' | 'autoSwitchOff'>,
): ModelGroupSourceRoute[] {
  const others = [...(catalog.remote ?? [])].map(([deviceId, providers]) => ({ deviceId, providers }));
  // 去重只在自己的电脑之间做(同一个登录在两台电脑上算一个)。别人分享来的各是各的账号，即使供应商同名也都算成员，
  // 与选择器一致：分享不参与这条合并规则。
  const folds = listedSourceFolds({ base: catalog.views, others: others.filter((other) => !isProviderShareAgentDeviceId(other.deviceId)) });
  const families = new Map<string, { view: ProviderView; agentDeviceId?: string }[]>();
  const add = (view: ProviderView, agentDeviceId?: string) => {
    const family = usable(view) ? providerFamily(view) : null;
    if (family) families.set(family, [...(families.get(family) ?? []), { view, ...(agentDeviceId ? { agentDeviceId } : {}) }]);
  };
  for (const view of catalog.views) if (!folds.hiddenBase.has(view.id)) add(view);
  for (const { deviceId, providers } of others) {
    for (const view of providers) if (!folds.hiddenOther.get(deviceId)?.has(view.id)) add(view, deviceId);
  }
  const hidden = new Set(config.hiddenAuto ?? []);
  const switchOff = new Set(config.autoSwitchOff ?? []);
  const routes: ModelGroupSourceRoute[] = [];
  for (const [family, members] of families) {
    if (members.length < 2) continue;
    const id = `${MODEL_GROUP_AUTO_PREFIX}${family}`.slice(0, MODEL_GROUP_LIMITS.id);
    routes.push({
      id,
      name: members[0].view.name.slice(0, MODEL_GROUP_LIMITS.name),
      strategy: config.autoStrategy?.[id] ?? 'expiring',
      sources: members.slice(0, MODEL_GROUP_LIMITS.candidates).map(({ view, agentDeviceId }) => ({
        providerId: view.id, ...(agentDeviceId ? { agentDeviceId } : {}),
      })),
      ...(switchOff.has(id) ? { autoSwitch: false as const } : {}),
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

const expandedId = (routeId: string, modelKey: string) =>
  `${MODEL_GROUP_EXPANDED_PREFIX}${createHash('sha256').update(`${routeId}\u0000${modelKey}`).digest('hex').slice(0, 40)}`;

/** 一条供应商路由展开成每个模型一条普通路由：成员里谁提供这个模型，谁就是这条的来源(顺序同成员顺序)。 */
export function expandSourceRoute(route: ModelGroupSourceRoute, catalog: SourceCatalog): ModelGroupRoute[] {
  const byModel = new Map<string, { name: string; candidates: ModelGroupCandidate[] }>();
  for (const source of route.sources) {
    const views = locationViews(catalog, source.agentDeviceId);
    const agents = locationAgents(catalog, source.agentDeviceId);
    const allowed = agents.filter((agent): agent is AgentKind => agent in GROUP_KIND);
    const view = views.find((item) => item.id === source.providerId);
    if (!view || !usable(view)) continue;
    const seen = new Set<string>();
    for (const agent of allowed) {
      for (const model of view.models?.[agent] ?? []) {
        const key = sourceModelKey(view, agent, model.id);
        if (model.disabled || seen.has(key)) continue;
        // 一个供应商在一个模型上只占一个位置：用这个模型在它上面的推荐引擎，与选择器点这一行时相同。
        const own = unifiedModelKeyId(model.id);
        const recommended = recommendedAgentForModel(views as ProviderView[], view.id, own, { agents: allowed });
        const agentKind = recommended ? GROUP_KIND[recommended] : undefined;
        const wire = recommended ? resolveWireModelId(view, own, recommended) : null;
        if (!recommended || !agentKind || !wire) continue;
        const candidate: ModelGroupCandidate = {
          agentKind, providerId: view.id, model: wire,
          ...(source.agentDeviceId ? { agentDeviceId: source.agentDeviceId } : {}),
          ...(source.off ? { off: true } : {}), ...(source.weight ? { weight: source.weight } : {}),
        };
        if (!catalog.available(candidate, views, agents)) continue;
        seen.add(key);
        const entry = byModel.get(key) ?? { name: view.models?.[recommended]?.find((item) => item.id === wire)?.name ?? model.name ?? key, candidates: [] };
        entry.candidates.push(candidate);
        byModel.set(key, entry);
      }
    }
  }
  return [...byModel].map(([key, entry]): ModelGroupRoute => ({
    id: expandedId(route.id, key),
    name: entry.name.slice(0, MODEL_GROUP_LIMITS.name),
    strategy: route.strategy,
    candidates: entry.candidates,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.autoSwitch === false ? { autoSwitch: false as const } : {}),
    parent: { id: route.id, name: route.name },
    ...(route.hidden ? { hidden: true as const } : {}),
  }));
}

/** 存盘的配置 + 此刻的目录 = 读取方看到的配置：用户排的路由、供应商路由(用户建的与自动合成的)及其展开。 */
export function effectiveModelGroupsConfig(stored: ModelGroupsConfig, catalog: SourceCatalog | null): ModelGroupsConfig {
  if (!catalog) return stored;
  const sourceRoutes = [...(stored.sourceRoutes ?? []), ...buildAutoSourceRoutes(catalog, stored)];
  const expanded = sourceRoutes.flatMap((route) => expandSourceRoute(route, catalog)).slice(0, MODEL_GROUP_EXPANDED_LIMIT);
  return {
    ...stored,
    routes: [...stored.routes, ...expanded],
    ...(sourceRoutes.length > 0 ? { sourceRoutes } : {}),
  };
}
