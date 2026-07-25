/**
 * modelList —— 「从供应商目录派生模型清单」的**唯一标准入口**(纯逻辑,跨端共享)。
 *
 * 背景(2026-07 全仓盘点): 同一个「取某 agent 的模型清单」语义在 desktop/mobile/main 里被独立
 * 实现了 8+ 份(deriveAvailableModels / deriveModelsFromProviders / selectVisibleModels /
 * visibleModelUnion / buildProviderSections / selectWorkerModels / IM slashCommands / hook
 * session-runner),连接态过滤、可见性过滤、去重三条规则排列组合出 ≥4 种口径,直接导致
 * 「设置页看到的清单 ≠ 会话选择器 ≠ IM /model 卡」一类线上事故。
 *
 * 本模块把三条规则收成**显式 options**,所有派生统一走 `deriveModelList` /
 * `deriveModelSections`;既有共享函数(visibleModelUnion / buildProviderSections)改写为本模块
 * 的薄壳,签名与输出逐字节不变(有 parity 测试锁),消费方无感收口。
 *
 * 设计约束:
 *   - 纯函数、零依赖(包不变量),mobile 与 main 均可直接消费;
 *   - 不做隐式默认的「聪明行为」: 供应商范围/可见性/去重全部由调用方显式声明,
 *     每个旧口径都能被一组 options 精确表达(映射表见各薄壳注释)。
 */

import type { AgentKind, CatalogModel, ProviderAccess } from './types.js';
import {
  connectedProvidersForAgent,
  providersForAgent,
  type ProviderView,
} from './registry.js';

/**
 * 清单条目的来源溯源 —— flat(拍平去重)清单里「订阅」「立省85%」等来源徽章的**真实依据**。
 *
 * 历史问题: 拍平清单丢掉了 provider 上下文,`provider?.access?.kind === 'subscription'` 判定
 * 恒 false,订阅标签整个消失 —— 用户误以为订阅绑定失效(2026-07 实测)。派生时每一行的来源
 * 供应商是确定已知的(first-wins 首见者 / 分段模式的段供应商),附上即是溯源不是猜测。
 * 拿不到目录、只有拍平 capabilities 的场景(device-link 旧被控端)没有这份元数据 → 渲染层
 * 不显示来源徽章,诚实降级。
 */
export interface ModelSourceMeta {
  /** 该行来源供应商 id。 */
  sourceProviderId: string;
  /** 来源供应商的 access(订阅/API/托管);custom provider 可能缺省。 */
  sourceAccess?: ProviderAccess;
  /** 派生时该来源是否已连接(providerScope 非 connected 的清单才有区分意义)。 */
  sourceConnected: boolean;
}

/** 标准清单条目 = 目录条目全字段 + 来源溯源。对按 CatalogModel 形状消费的代码是协变加宽。 */
export interface ModelListEntry extends CatalogModel, ModelSourceMeta {}

/**
 * 供应商范围 —— 三种历史口径的显式化:
 *   - 'all-for-agent'(默认): 该 agent 兼容的全部供应商,不看连接(capabilities 快照口径);
 *   - 'connected-for-agent': 已连接且兼容该 agent(选择器 / IM /model 卡口径);
 *   - 'as-given': 完全按传入数组遍历、不做任何收窄 —— buildProviderSections 的历史语义
 *     (它假设调用方已自行收窄;薄壳必须保持,否则「调用方传了未收窄列表」时行为漂移)。
 */
export type ProviderScope = 'all-for-agent' | 'connected-for-agent' | 'as-given';

export interface DeriveModelListOptions {
  providers: readonly ProviderView[];
  agent: AgentKind;
  /** 供应商范围,默认 'all-for-agent'。 */
  providerScope?: ProviderScope;
  /**
   * 可见性过滤(用户「设置 → 模型供应商」的显隐 override);决策统一走 isModelVisible,
   * 数据源由调用方按自己进程能读到的存储注入。缺省 = 不过滤。
   */
  isVisible?: (providerId: string, model: CatalogModel) => boolean;
  /**
   * 'first-wins'(默认): 同 id 跨供应商去重,按供应商序 + 目录序首见胜出 —— 拍平单列清单;
   * 'none': 不去重,同 id 在每个提供它的供应商下各出一行 —— 分段清单。
   */
  dedupe?: 'first-wins' | 'none';
  /** 整供应商排除(如 SSH 远程排除 chat-bridged Codex 源);被排除者**不占** first-wins 的 seen。 */
  excludeProvider?: (provider: ProviderView) => boolean;
  /** 单模型排除(如 SSH 远程排除订阅直连前缀);被排除者同样不占 seen。 */
  excludeModel?: (model: CatalogModel, provider: ProviderView) => boolean;
  /**
   * 选中豁免: 该 (供应商, 模型) 即便被 isVisible 隐藏也保留 —— 避免「当前选中项不在列表」
   * 的空选态(分段选择器契约)。providerId 为 null 时按 model id 匹配任意供应商行。
   */
  keepSelected?: { providerId: string | null; modelId: string };
}

function resolveRail(
  providers: readonly ProviderView[],
  agent: AgentKind,
  scope: ProviderScope,
): readonly ProviderView[] {
  switch (scope) {
    case 'connected-for-agent':
      return connectedProvidersForAgent([...providers], agent);
    case 'as-given':
      return providers;
    default:
      return providersForAgent([...providers], agent);
  }
}

function matchesSelected(
  keep: DeriveModelListOptions['keepSelected'],
  providerId: string,
  modelId: string,
): boolean {
  if (!keep) return false;
  if (keep.modelId !== modelId) return false;
  return keep.providerId === null || keep.providerId === providerId;
}

/**
 * 标准清单派生。输出顺序契约与历史一致: 供应商按 rail 序(= catalog 序),
 * 供应商内模型按目录序,**绝不二次排序**(展示层的分组排序另走 groupModelsForDisplay)。
 */
export function deriveModelList(opts: DeriveModelListOptions): ModelListEntry[] {
  const {
    providers,
    agent,
    providerScope = 'all-for-agent',
    isVisible,
    dedupe = 'first-wins',
    excludeProvider,
    excludeModel,
    keepSelected,
  } = opts;

  // first-wins 的占坑表直接记「id → 首见行在 out 里的下标」,选中行替换时 O(1) 定位
  // (findIndex 线性扫在大目录下会让派生退化 O(n²),Greptile review)。
  const seenIndex = new Map<string, number>();
  const out: ModelListEntry[] = [];
  for (const provider of resolveRail(providers, agent, providerScope)) {
    if (excludeProvider?.(provider)) continue;
    for (const m of provider.models[agent] ?? []) {
      if (excludeModel?.(m, provider)) continue;
      const selected = matchesSelected(keepSelected, provider.id, m.id);
      // entry 构造延后到确定要用时(push / 替换):被 first-wins 丢弃的重复行不做无谓 spread。
      const makeEntry = (): ModelListEntry => {
        const entry: ModelListEntry = {
          ...m,
          sourceProviderId: provider.id,
          sourceConnected: provider.connected,
        };
        if (provider.access !== undefined) entry.sourceAccess = provider.access;
        return entry;
      };
      if (dedupe === 'first-wins' && seenIndex.has(m.id)) {
        // 首见行已占坑。keepSelected 点名 provider 且选中行排在后面时,首见行必须让位——
        // 否则选中 (provider, model) 被去重丢弃,flat 列表带着错误来源/徽章(codex review):
        // 用选中行**原位替换**首见行(位置守首见槽,输出顺序契约不变;选中行豁免
        // isVisible,与 push 路径同规则)。普通重复行直接丢弃。
        if (selected) {
          const i = seenIndex.get(m.id)!;
          if (!matchesSelected(keepSelected, out[i].sourceProviderId, out[i].id)) {
            out[i] = makeEntry();
          }
        }
        continue;
      }
      if (!selected && isVisible && !isVisible(provider.id, m)) continue;
      if (dedupe === 'first-wins') seenIndex.set(m.id, out.length);
      out.push(makeEntry());
    }
  }
  return out;
}

/** 分段清单条目: 段供应商 + 该段下的标准条目(溯源即段供应商)。 */
export interface ModelListSection {
  provider: ProviderView;
  models: ModelListEntry[];
}

/**
 * 分段派生(dedupe:'none' 的分桶形状)。与 deriveModelList 同一套过滤规则,逐供应商独立出段
 * (不经「拍平再分桶」—— 保证与历史 buildProviderSections 在任意输入下同构,含病态的重复
 * provider id);`query` 命中 name / id(大小写不敏感)。只返回有 ≥1 个模型的段;段顺序 = rail 序。
 * sections.ts 的 buildProviderSections 是本函数的投影薄壳(SectionModel 字段裁剪)。
 */
export function deriveModelSections(
  opts: Omit<DeriveModelListOptions, 'dedupe'> & { query?: string },
): ModelListSection[] {
  const {
    providers,
    agent,
    providerScope = 'all-for-agent',
    isVisible,
    excludeProvider,
    excludeModel,
    keepSelected,
  } = opts;
  const q = (opts.query ?? '').trim().toLowerCase();

  const sections: ModelListSection[] = [];
  for (const provider of resolveRail(providers, agent, providerScope)) {
    if (excludeProvider?.(provider)) continue;
    const models: ModelListEntry[] = [];
    for (const m of provider.models[agent] ?? []) {
      if (excludeModel?.(m, provider)) continue;
      const selected = matchesSelected(keepSelected, provider.id, m.id);
      if (!selected && isVisible && !isVisible(provider.id, m)) continue;
      if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) continue;
      const entry: ModelListEntry = {
        ...m,
        sourceProviderId: provider.id,
        sourceConnected: provider.connected,
      };
      if (provider.access !== undefined) entry.sourceAccess = provider.access;
      models.push(entry);
    }
    if (models.length > 0) sections.push({ provider, models });
  }
  return sections;
}
