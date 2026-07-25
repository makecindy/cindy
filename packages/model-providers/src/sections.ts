/**
 * sections —— 「按供应商分段」的模型列表派生 + 可见性决策（纯逻辑，跨端共享）。
 *
 * 这是「获取某 agent 当前模型列表」的**唯一方法**：renderer 的模型选择器与 main 侧的 IM
 * `/model` 卡片都调本模块,保证两端看到**同样的内容**(连接供应商 × 各自模型、每供应商各一行、
 * 同一套可见性过滤)。从 `apps/desktop` renderer 的 sourceSwitch.ts 下沉到本共享包,正是为了让
 * main 进程(IM 跑在这)能复用同一份逻辑——不再各写一套、未来拓展只改这里。
 *
 * 可见性的**数据源**仍由各调用方按自己进程能读到的存储注入(`isVisible` 回调);本模块只负责
 * 「连接供应商 × 模型 → 分段列表」的形状与「override ?? 默认」的决策(`isModelVisible`)。
 */

import type { AgentKind, CatalogModel, Effort } from './types.js';
import type { ProviderView } from './registry.js';
import { deriveModelList, deriveModelSections } from './modelList.js';

/**
 * 单个模型的可见性决策 —— **纯函数,唯一真相**。
 *   - 用户在「设置 → 模型供应商」里显式开关过 → 用该 override;
 *   - 没开关过 → 跟随目录的系统默认值 `defaultEnabled`(缺省 ⇒ 可见,对齐 CatalogModel 文档)。
 * renderer 的 isModelEnabled 与 main 侧的可见性判定都应走本函数,避免两处决策口径发散。
 */
export function isModelVisible(
  override: boolean | undefined,
  defaultEnabled: boolean | undefined,
): boolean {
  return override ?? defaultEnabled !== false;
}

/** 「按供应商分段」里每行模型的展示形状(从 catalog 派生,字段够渲染 + effort 配置用)。 */
export interface SectionModel {
  id: string;
  displayName: string;
  description?: string;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  effortDisplayNames?: Record<string, string>;
  supportsFastMode?: boolean;
  contextWindow: number;
  /** 展示图标 id(AI Gateway / 目录设定,见 CatalogModel.icon);缺省回落来源供应商标。 */
  icon?: string;
}

export interface ProviderSection {
  provider: ProviderView;
  models: SectionModel[];
}

/** 客户端有资产可渲染的模型厂牌图标种类(桌面 AnthropicMark / OpenAIMark / XDIncMark,手机同源厂牌 path)。 */
export type ModelIconKind = 'claude' | 'codex' | 'cindy';

/**
 * 解析目录 / 网关下发的模型图标 id —— **跨端唯一口径**(桌面 + 手机同一套规则,
 * 「显示什么图标以 AI Gateway 设定为准」)。已知取值(大小写不敏感,含常用别名):
 *   claude / anthropic → 'claude';codex / openai / gpt → 'codex';cindy / xd → 'cindy'。
 * 缺省 / 未知值返回 null:渲染层回落该行来源供应商标(ProviderMark),
 * 网关先于客户端登记新图标时优雅降级、不会渲染错图。
 */
export function resolveModelIconKind(icon: string | undefined): ModelIconKind | null {
  if (!icon) return null;
  switch (icon.trim().toLowerCase()) {
    case 'claude':
    case 'anthropic':
      return 'claude';
    case 'codex':
    case 'openai':
    case 'gpt':
      return 'codex';
    case 'cindy':
    case 'xd':
      return 'cindy';
    default:
      return null;
  }
}

/**
 * 单栏模型选择器的「按供应商分段」纯逻辑:
 *   - 按传入 `providers`(已连接、已排序)顺序,逐个供应商取它 `models[agent]`(= catalog 顺序,
 *     即既有展示顺序,**不再二次排序**),保留该供应商 offer 的全部模型;
 *   - 同一模型被多个供应商 offer 时,会在各自供应商段里各出现一次(选行 = 选「供应商, 模型」);
 *   - `isVisible(providerId, modelId)` 过滤用户在设置里隐藏的模型,但**当前选中**的(供应商, 模型)
 *     即便被隐藏也保留(避免选中项不在列表的空选态);
 *   - `query` 命中 displayName / id(大小写不敏感)。
 * 只返回有 ≥1 个模型的供应商段。纯函数,不依赖 React,可单测。
 */
/**
 * 「已连接供应商 × 可见模型」的**拍平并集** —— 给需要单列清单(不分供应商段)的消费方:
 * Slack hook 的 /model 卡与 Tina 设置页的目录偏好下拉。
 *
 * 规则与 `buildProviderSections`(应用内模型选择器)**同口径**,只是形状不同:
 *   - 只取已连接且支持该 agent 的供应商(`connectedProvidersForAgent`,同选择器);
 *   - `isVisible(providerId, model)` 过滤用户在设置里隐藏的模型(调用方注入各自进程
 *     能读到的 override 源,决策统一走 `isModelVisible`);
 *   - 按供应商序 + 目录序,同 id **首见胜出**去重(与 renderer providerModels /
 *     main deriveAvailableModels 的顺序契约一致):某供应商下被隐藏、另一供应商下
 *     可见的模型仍会出现(取可见那家的元数据)。
 * 返回 CatalogModel 形状的**拷贝**(含 group / efforts / defaultEffort 等全部元数据;
 * 不是 catalog 对象引用 —— 按引用 memo/相等比较会失配,详见函数体内的物理差异警告),
 * 纯函数可单测。
 */
export function visibleModelUnion(
  providers: readonly ProviderView[],
  agent: AgentKind,
  isVisible: (providerId: string, model: CatalogModel) => boolean,
): CatalogModel[] {
  // 薄壳: 标准派生的「已连接 + 可见性 + first-wins 去重」口径(modelList.ts)。
  // 返回类型保持 CatalogModel[](ModelListEntry 是其超集,协变加宽,消费方无感);
  // 输出顺序与历史实现逐字节一致,由 sections.test.ts(零修改)与 parity 测试锁定。
  //
  // ⚠ 两个与历史实现的物理差异(语义等价,但消费方不得依赖):
  //   1. 条目是**拷贝**而非 catalog 对象引用 —— 按引用做 memo/相等比较会失配;
  //   2. 条目带 3 个额外可枚举字段(sourceProviderId / sourceConnected / 可选 sourceAccess),
  //      类型层不可见 —— **禁止把条目整对象 JSON.stringify / spread 进 IPC・协议・持久化**,
  //      过 wire 前必须显式投影字段(现存 5 个消费方已核查合规;键集有测试锁)。
  return deriveModelList({
    providers,
    agent,
    providerScope: 'connected-for-agent',
    isVisible,
    dedupe: 'first-wins',
  });
}

export function buildProviderSections(args: {
  providers: readonly ProviderView[];
  agent: AgentKind;
  selectedModelId?: string;
  selectedProviderId?: string | null;
  isVisible: (providerId: string, modelId: string) => boolean;
  query?: string;
}): ProviderSection[] {
  // 薄壳: 标准分段派生(modelList.ts)+ SectionModel 字段投影。历史语义逐项保持:
  //   - providerScope 'as-given': 本函数从不收窄供应商(调用方已自行收窄),薄壳不得
  //     擅自加 connectedProvidersForAgent —— 否则调用方传未收窄列表时行为漂移;
  //   - 选中豁免仅在 selectedProviderId **非空**时生效(旧实现 provider.id === null
  //     恒 false,即 flat 语义的「null = 匹配任意行」在这里不适用);
  //   - 字段拷贝保持条件性(undefined 字段不写 key),对象形状逐字节一致。
  const sections = deriveModelSections({
    providers: args.providers,
    agent: args.agent,
    providerScope: 'as-given',
    isVisible: (providerId, model) => args.isVisible(providerId, model.id),
    ...(args.selectedModelId !== undefined &&
    args.selectedProviderId !== undefined &&
    args.selectedProviderId !== null
      ? { keepSelected: { providerId: args.selectedProviderId, modelId: args.selectedModelId } }
      : {}),
    ...(args.query !== undefined ? { query: args.query } : {}),
  });
  return sections.map(({ provider, models }) => ({
    provider,
    models: models.map((m) => {
      const sm: SectionModel = {
        id: m.id,
        displayName: m.name,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
        contextWindow: m.contextWindow,
      };
      if (m.description !== undefined) sm.description = m.description;
      if (m.effortDisplayNames !== undefined) sm.effortDisplayNames = m.effortDisplayNames;
      if (m.supportsFastMode !== undefined) sm.supportsFastMode = m.supportsFastMode;
      if (m.icon !== undefined) sm.icon = m.icon;
      return sm;
    }),
  }));
}
