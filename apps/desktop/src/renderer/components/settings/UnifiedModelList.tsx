import { localizedModelName, localizedBrandName, matchesModelName } from '@/lib/modelDisplayNames';
import { modelManagementState } from './modelManagementState';
/**
 * UnifiedModelList —— 供应商详情面板的「以模型为主体」统一列表。
 *
 * 设计(2026-07 模型供应商重构定稿 + 2026-07-28 启用/显示双轴交互定稿):
 *   - 列表 = 该供应商**所有 agent 的模型并集**(按 model id 合并),不再按 CLI 分 Tab。
 *   - 三个概念钉死到三种互不借用的表达上(用户裁决):
 *       · **开关 = 显示轴**(仅对话模型行):是否出现在模型选择面板 —— 纯陈列,全页
 *         唯一一种开关语义。隐藏的模型被显式点名 / 自动兜底时仍可用。存储 =
 *         renderer modelVisibilityPrefs(不变)。
 *       · **高级设置 = 停用动作**(所有行):停用 = 准入关,不可被任何
 *         新路由选中。存储 = main 侧 model-disable-store,经 PROVIDER_LIST 的
 *         model.disabled 标志回读,写走 setModelDisable IPC。本机 Ollama 行额外
 *         提供「删除」:会清掉磁盘上的模型文件,并移出 Cindy 目录。
 *       · **底部「已停用」分区 = 停用状态**:停用的行离开原分组、沉到列表底部的
 *         折叠区(复用分组折叠交互,默认展开),行内「启用此模型」即飞回原分组。
 *         "下沉"是停用在整个设置页的统一隐喻(左栏停用的供应商同样沉底)。
 *   - **能力模型组**(图像/音频/视频/向量/其它端点):不能当 agent 用,永远不进对话模型
 *     选择面板(modelList.ts 硬排除),没有显示轴 ⇒ 行内**没有开关**,只有「⋯」停用;
 *     其启用状态控制媒体生成等专属链路能否使用它。
 *   - 普通列表只有一个显示开关;开启时只选一个推荐引擎，逐引擎控制进入高级详情。
 *   - 用途筛选与厂商分组独立;同一家族按型号数字倒序,不冒充上线时间。
 *
 * 同一模式下同一轴的控件形态唯一 —— 这是本组件的硬约束(v4 交互稿定稿延续)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Info, Lock, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Tip } from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import {
  litWholeMarks,
  PriceFreeBadge,
  PriceTierMarks,
  type UnifiedRowPriceDisplay,
} from '@/components/new-chat/priceTierMarks';
import { priceTierOf } from '@/components/new-chat/unifiedModelSelection';
import { useGatewayModelPricing, useReferenceModelPricing } from '@/hooks/useModelPricing';
import { modelPriceDiscountLabelValues } from '@/lib/modelPriceFormat';
import { resolveModelPricePresentation } from '@/lib/modelPricePresentation';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';
import {
  classifyModel,
  CATEGORY_LABEL_KEY,
  type ModelCategory,
} from '@/components/new-chat/sourceSwitch';
import {
  isModelEnabled,
  setModelVisibilities,
  resetModelVisibilities,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import { LocalPackagingTag } from './LocalPackagingTag';
import { ModelAdvancedDrawer } from './ModelAdvancedDrawer';
import {
  compareModelNames,
  groupModelsForManagement,
  MANAGEMENT_KIND_ORDER,
  modelBrand,
  type ManagementKind,
  type ManagementView,
} from './modelManagementPresentation';

import {
  isAgentSelectableModel,
  pickRecommendedAgent,
  resolveModelIconKind,
} from '@cindy/model-providers';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

/**
 * 分组折叠态(仅 UI 展示,按设备记忆)。非对话类型组(图像/视频/语音合成/语音转写/
 * 实时音频/向量/压缩/其它端点)默认折叠——它们是网关多出的、不能当 agent 用的模型,默认
 * 收起让列表清爽;对话厂商组(含认不出厂商的「未分组」)默认展开;底部「已停用」分区
 * (key = '__disabled')默认**展开**——区里有东西说明是用户主动停的,找回路径要一眼可见。
 * 只存用户显式改过的组(与 modelVisibilityPrefs 同哲学:未改的跟随默认),搜索时强制全展开。
 * CAPABILITY_CATEGORIES 同时就是「能力模型组」的判定(成员 = classification 的非 agent 分组)。
 */
const COLLAPSE_STORAGE_KEY = 'xdt:modelListCollapsedGroups:v3';
const LEGACY_COLLAPSE_STORAGE_KEY = 'xdt:modelListCollapsedGroups:v2';
const LEGACY_V1_COLLAPSE_STORAGE_KEY = 'xdt:modelListCollapsedGroups:v1';
const DISABLED_GROUP_KEY = '__disabled';
/** 「未启用」沉底区的折叠 key。默认折叠(见渲染处注释),与能力组同一档默认。 */
const HIDDEN_GROUP_KEY = '__hidden';
const CAPABILITY_CATEGORIES = new Set<ModelCategory>([
  'image',
  'video',
  'tts',
  'stt',
  'realtime',
  'embedding',
  'compression',
  'other',
]);
const DEFAULT_COLLAPSED_CATEGORIES = CAPABILITY_CATEGORIES;

/** 某个折叠 key 未被用户显式改过时是否默认折叠(isCollapsed 与 toggleCollapsed 共用)。 */
function defaultCollapsedFor(key: string): boolean {
  if (key === DISABLED_GROUP_KEY) return false;
  if (key === HIDDEN_GROUP_KEY) return true;
  return DEFAULT_COLLAPSED_CATEGORIES.has(key.split(':', 1)[0] as ModelCategory);
}

function readCollapsedMap(key: string): Record<string, boolean> | null {
  const raw = window.localStorage.getItem(key);
  const parsed: unknown = raw ? JSON.parse(raw) : null;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : null;
}

/** 导出仅供单测:v1/v2 → v3 的一次性搬迁只跑在升级后的首次挂载上,值得有回归锁。 */
export function loadCollapsedMap(): Record<string, boolean> {
  try {
    const current = readCollapsedMap(COLLAPSE_STORAGE_KEY);
    if (current) return current;
    // v2 → v3:旧 v2 的 'other' 是认不出厂商的聊天模型,新 v3 改名为 'ungrouped';
    // 旧 v2 的 'non-chat' 是其它端点,恢复为 wire 语义的 'other'。
    const legacyV2 = readCollapsedMap(LEGACY_COLLAPSE_STORAGE_KEY);
    if (legacyV2) {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(legacyV2)) {
        next[key === 'non-chat' ? 'other' : key === 'other' ? 'ungrouped' : key] = value;
      }
      return next;
    }
    // v1 从未改变 other 的 wire 语义,直接保留。
    return readCollapsedMap(LEGACY_V1_COLLAPSE_STORAGE_KEY) ?? {};
  } catch {
    return {};
  }
}

/** 并集行:同一模型跨 agent 合并;byAgent 保留各 agent 的目录条目(id / 元数据可能不同)。 */
export interface UnionModelRow {
  /** 规范化 id(剥掉桥接命名空间前缀后的 canonical key;仅用于合并与搜索,写开关用 byAgent 的真实 id)。 */
  id: string;
  name: string;
  byAgent: Partial<Record<AgentKind, CatalogModel>>;
  /** 该模型可用的 agent(按 provider.agents 顺序)。 */
  avail: AgentKind[];
}

/**
 * 规范化模型 id:剥掉该 agent 路由声明的桥接命名空间前缀(数据驱动,来自
 * routing[agent].modelPrefixes,如 OpenAI cc 桥 = 'chatgpt/')。同一模型经桥投影
 * 到另一 agent 时 id 带前缀(chatgpt/gpt-5.5 vs gpt-5.5),必须归一后合并,
 * 否则并集出现两行、各自被误标单端。
 */
function canonicalModelKey(provider: ProviderView, agent: AgentKind, id: string): string {
  for (const prefix of provider.routing[agent]?.modelPrefixes ?? []) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

/** 构建并集(导出供单测):行序 = 第一个 agent 的目录序,后续 agent 独占模型追加其后;
 *  专属媒体清单(imageModels/videoModels,不挂 agent)以合成能力行追加在最后。 */
export function buildUnionRows(provider: ProviderView): UnionModelRow[] {
  const rows: UnionModelRow[] = [];
  const byKey = new Map<string, UnionModelRow>();
  for (const agent of provider.agents) {
    for (const m of provider.models[agent] ?? []) {
      const key = canonicalModelKey(provider, agent, m.id);
      const existing = byKey.get(key);
      if (existing) {
        // 同 agent 内撞 canonical key(理论不该发生)不覆盖首见条目。
        if (!existing.byAgent[agent]) {
          existing.byAgent[agent] = m;
          existing.avail.push(agent);
        }
      } else {
        const row: UnionModelRow = {
          id: key,
          name: m.name,
          byAgent: { [agent]: m },
          avail: [agent],
        };
        byKey.set(key, row);
        rows.push(row);
      }
    }
  }
  // 只经专属媒体清单下发的图像/视频型号也要能被停用管理(PR #744 review):合成
  // 能力行(group 显式钉死,不吃 id 启发式;contextWindow=0 ⇒ 渲染时不显示)。与
  // models[agent] 里同 id 条目去重 —— 网关历史上两处都发,以 agent 清单条目为准。
  const realIds = new Set<string>();
  for (const row of rows) {
    for (const a of row.avail) {
      const m = row.byAgent[a];
      if (m) realIds.add(m.id);
    }
  }
  const anchorAgent = provider.agents[0] ?? 'claude-code';
  // 向量清单同理(PR #1707 review):派生侧一直按 isModelDisabled 过滤,但设置页
  // 没有对应的行 —— 停用轴有实现无入口,用户没法单独拦住某个向量型号的付费调用。
  // group 钉 'embedding'(classifyModel 的已知非聊天分类,已有 i18n 标签「向量」)。
  const media: Array<{
    id: string;
    name: string;
    disabled?: boolean;
    availability?: CatalogModel['availability'];
    group: 'image' | 'video' | 'embedding';
    modalities?: CatalogModel['modalities'];
  }> = [
    ...(provider.imageModels ?? []).map((m) => ({ ...m, group: 'image' as const })),
    ...(provider.videoModels ?? []).map((m) => ({ ...m, group: 'video' as const })),
    ...(provider.embeddingModels ?? []).map((m) => ({ ...m, group: 'embedding' as const })),
  ];
  for (const m of media) {
    if (realIds.has(m.id) || byKey.has(m.id)) continue;
    const entry: CatalogModel = {
      id: m.id,
      name: m.name,
      contextWindow: 0,
      efforts: [],
      defaultEffort: null,
      group: m.group,
      mode:
        m.group === 'image'
          ? 'image_generation'
          : m.group === 'video'
            ? 'video_generation'
            : 'embedding',
      ...(m.modalities ? { modalities: m.modalities } : {}),
      ...(m.disabled === true ? { disabled: true } : {}),
      ...(m.availability !== undefined ? { availability: m.availability } : {}),
    };
    const row: UnionModelRow = {
      id: m.id,
      name: m.name,
      byAgent: { [anchorAgent]: entry },
      avail: [anchorAgent],
    };
    byKey.set(m.id, row);
    rows.push(row);
  }
  return rows;
}

/** 该行在指定 agent 下的可见性(不可用 → null)。 */
function rowEnabled(providerId: string, row: UnionModelRow, agent: AgentKind): boolean | null {
  const m = row.byAgent[agent];
  return m ? isModelEnabled(agent, providerId, m) : null;
}

/** 该行是否被停用(准入轴;单一写入口把全部 avail 一起写,任一端带标志即视为停用)。 */
export function isRowDisabled(row: UnionModelRow): boolean {
  return row.avail.some((a) => row.byAgent[a]?.disabled === true);
}

export function isRowPaymentRequired(row: UnionModelRow): boolean {
  return row.avail.some((agent) => row.byAgent[agent]?.availability === 'requires_payment');
}

/** 付费锁定优先于本地停用偏好：命中时任何批量恢复都不得改写该行的历史 override。 */
export function hasPaymentRequiredDisabledRow(
  rows: readonly UnionModelRow[],
  isDisabled: (row: UnionModelRow) => boolean = isRowDisabled,
): boolean {
  return rows.some((row) => isDisabled(row) && isRowPaymentRequired(row));
}

/** 该行是否是「能力模型」(图像/音频/视频/向量等,没有显示轴;见头注)。
 *  `userProvider` = 行来自用户自定义供应商 —— 自定义对话模型的未知 group 不吃 id
 *  启发式(`gpt-4o-audio-preview` 是合法对话模型,见 isAgentSelectableModel 注释)。 */
export function isCapabilityRow(row: UnionModelRow, userProvider: boolean): boolean {
  const rep = row.byAgent[row.avail[0]];
  return !!rep && !isAgentSelectableModel(rep, { userProvider });
}

/** A normal list toggle enables recommended engines; compatibility engines remain opt-in. */
export function modelVisibilityTargets(
  provider: ProviderView,
  row: UnionModelRow,
  enabled: boolean,
) {
  if (!enabled)
    return row.avail.flatMap((agent) => {
      const model = row.byAgent[agent];
      return model ? [{ agent, modelId: model.id }] : [];
    });
  // Choosing a model is not consent to enable every harness. Advanced per-engine choices
  // stay where the user made them; an ordinary enable only needs one usable recommended route.
  const usable = row.avail.filter((agent) => {
    const model = row.byAgent[agent];
    return (
      model &&
      !model.disabled &&
      model.status !== 'retired' &&
      model.availability !== 'requires_payment'
    );
  });
  const defaults = usable.filter((agent) => row.byAgent[agent]?.defaultEnabled !== false);
  const agent = pickRecommendedAgent(provider, row.id, defaults.length ? defaults : usable);
  const model = agent ? row.byAgent[agent] : undefined;
  return agent && model ? [{ agent, modelId: model.id }] : [];
}

/** 普通模式的单开关显示值:任一可用 agent 开启即视为开(拨动才归一)。 */
function rowAnyEnabled(providerId: string, row: UnionModelRow): boolean {
  return row.avail.some((a) => rowEnabled(providerId, row, a) === true);
}

/** 该行全部 avail agent 的真实目录 id(桥接投影两端 id 不同,写停用要两端一起写)。 */
function rowModelIds(row: UnionModelRow): string[] {
  const ids = new Set<string>();
  for (const a of row.avail) {
    const m = row.byAgent[a];
    if (m) ids.add(m.id);
  }
  return [...ids];
}

/** 该行的厂商分组(用代表条目判;已停用分区里标注来源分组也用它)。 */
function rowCategory(row: UnionModelRow): ModelCategory {
  const rep = row.byAgent[row.avail[0]];
  return rep ? classifyModel(rep) : 'ungrouped';
}

export function UnifiedModelList({
  provider,
  onRefresh,
  refreshing,
  refreshDisabled,
  refreshIdleLabel,
  emptyMessage,
  compactWhenEmpty,
  compact,
  focusModelId,
  focusAgent,
}: {
  provider: ProviderView;
  /** 「刷新模型」；内置供应商走各自真源，自定义供应商走 additions-only 发现。 */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** 其它供应商正在刷新时禁用，避免并发刷新造成反馈归属不清。 */
  refreshDisabled?: boolean;
  /** 内置供应商可传中性文案；自定义供应商默认保留 additions-only 的承诺。 */
  refreshIdleLabel?: string;
  /** 模型真源当前为空时的说明；搜索无结果仍使用 noResults。 */
  emptyMessage?: string;
  /** 空列表不抢剩余高度(本机 Ollama:把空间留给下方推荐/下载)。 */
  compactWhenEmpty?: boolean;
  /** 有内容时也不抢剩余高度,高度跟行数走(本机 Ollama 已安装列表)。 */
  compact?: boolean;
  /** Settings deep link target: reveal, focus, and scroll this model row into view. */
  focusModelId?: string;
  focusAgent?: AgentKind;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [query, setQuery] = useState('');
  const [managementView, setManagementView] = useState<ManagementView>('brand');
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(loadCollapsedMap);
  // 停用写入的乐观覆盖:setModelDisable 走 IPC → main 落盘 → PROVIDER_CHANGED 广播 →
  // useProviders 快照刷新,期间(可能上百毫秒,含凭证库读取)用本地覆盖顶住 —— 行在
  // 分组与「已停用」分区之间的迁移一次到位,不出现回跳帧(规则 7)。新快照到达即清空。
  const [pendingDisabled, setPendingDisabled] = useState<Record<string, boolean>>({});
  /** 高级设置抽屉的目标行。切供应商时清掉 —— 抽屉里的 row 属于旧 provider。 */
  const [advancedRow, setAdvancedRow] = useState<UnionModelRow | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const openAdvanced = (row: UnionModelRow) => {
    setAdvancedRow(row);
    setAdvancedOpen(true);
  };
  /** 类型筛选(全部 / 对话 / 图像 / 视频…):只有该来源真存在多类时才渲染整条。 */
  const [kindFilter, setKindFilter] = useState<ModelCategory | 'chat' | 'all'>('all');
  useEffect(() => {
    setPendingDisabled({});
    setAdvancedRow(null);
    setAdvancedOpen(false);
    setKindFilter('all');
  }, [provider.id]);
  useEffect(() => {
    setPendingDisabled({});
  }, [provider]);

  // 报价快照:与模型选择器同两份来源(XD 实付价 / 非 XD 参考价),派生逻辑共用
  // lib/modelPricePresentation.ts —— 设置页与选择器显示的必须是同一个价。
  const gatewayPricing = useGatewayModelPricing();
  const referencePricing = useReferenceModelPricing();
  const providersForPricing = useMemo(() => [provider], [provider]);
  const pricePresentationOf = useCallback(
    (agent: AgentKind, model: CatalogModel) =>
      resolveModelPricePresentation({
        providerId: provider.id,
        modelId: model.id,
        agent,
        providers: providersForPricing,
        gatewayPricing,
        referencePricing,
      }),
    [gatewayPricing, provider.id, providersForPricing, referencePricing],
  );

  /**
   * 行内档串的展示参数。口径与 UnifiedModelPanel.priceDisplayOf 一致:
   * 格数按**标准价**分档(折扣不改档位),点亮宽度按折后比例;订阅接入且拿不到按量报价的
   * 行不画档串(那类模型走套餐额度,画钱会被读成按量计费)。
   */
  const rowPriceDisplay = useCallback(
    (row: UnionModelRow): UnifiedRowPriceDisplay | null => {
      const agent = row.avail[0];
      const model = agent ? row.byAgent[agent] : undefined;
      if (!agent || !model) return null;
      const price = pricePresentationOf(agent, model);
      // 接入方式由供应商区域说明;缺少报价时不补订阅标签。
      const subscriptionRow =
        provider.access?.kind === 'subscription' &&
        (price === null ||
          price.kind !== 'priced' ||
          price.current.source === 'subscription-reference');
      if (subscriptionRow) return null;
      if (price?.kind === 'free') return { kind: 'free' };
      if (price?.kind !== 'priced') return null;
      const basis = price.original ?? price.current;
      const discountPct = price.discount !== undefined ? Math.round(price.discount * 100) : 0;
      return {
        kind: 'tier',
        tier: priceTierOf(basis.outputPerMtok, basis.currency),
        symbol: basis.currency === 'CNY' ? '¥' : '$',
        ...(discountPct > 0 && discountPct < 100
          ? {
              discountPct,
              paidPct: 100 - discountPct,
              title: t(
                'newChat.modelSelector.pricing.discount',
                modelPriceDiscountLabelValues(price.discount ?? 0),
              ),
            }
          : {}),
      };
    },
    [pricePresentationOf, provider.access?.kind, t],
  );

  // 折叠态:分组用 ModelCategory 作 key,两个沉底区用各自的常量 key。
  //   「已停用」默认**展开** —— 区里有东西说明是用户主动停的,找回路径要一眼可见;
  //   「未启用」默认**折叠** —— 它通常比开着的模型多得多,展开会把启用清单顶出屏幕。
  const isCollapsed = useCallback(
    (key: string) => collapsedMap[key] ?? defaultCollapsedFor(key),
    [collapsedMap],
  );
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedMap((prev) => {
      const defaultCollapsed = defaultCollapsedFor(key);
      const cur = prev[key] ?? defaultCollapsed;
      const newVal = !cur;
      const next = { ...prev };
      if (newVal === defaultCollapsed) {
        delete next[key];
      } else {
        next[key] = newVal;
      }
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* localStorage 不可用(隐私模式等)时仅内存生效,不阻断 UI */
      }
      return next;
    });
  }, []);
  // 订阅可见性 version:开关变更后 counts memo 必须重算(否则「全部开启/关闭」
  // 按钮方向与计数陈旧)。行内开关读取不 memo,天然新鲜;只有 counts 依赖它。
  const visibilityVersion = useModelVisibilityVersion();

  const selectionAvailable = provider.connected && !provider.suspended;
  const multiAgent = provider.agents.length > 1;
  const unionRows = useMemo(() => buildUnionRows(provider), [provider]);
  const currentAdvancedRow = unionRows.find((row) => row.id === advancedRow?.id) ?? advancedRow;

  const rowDisabledEffective = useCallback(
    (row: UnionModelRow) => pendingDisabled[row.id] ?? isRowDisabled(row),
    [pendingDisabled],
  );
  const rowState = useCallback((row: UnionModelRow) => modelManagementState(provider, {
    ids: rowModelIds(row),
    capability: isCapabilityRow(row, provider.source === 'user'),
    savedSelected: rowAnyEnabled(provider.id, row),
    disabled: rowDisabledEffective(row),
    paymentRequired: isRowPaymentRequired(row),
  }), [provider, rowDisabledEffective, visibilityVersion]);
  const focusedRow = useMemo(() => {
    if (!focusModelId) return null;
    return (
      unionRows.find((row) => {
        if (focusAgent) return row.byAgent[focusAgent]?.id === focusModelId;
        return row.avail.some((agent) => row.byAgent[agent]?.id === focusModelId);
      }) ?? null
    );
  }, [focusAgent, focusModelId, unionRows]);
  useEffect(() => {
    if (!focusedRow) return;
    setQuery('');
    setKindFilter('all');
  }, [focusedRow]);
  const focusRowRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    node.focus({ preventScroll: true });
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center' });
    }
  }, []);
  const hasLockedDisabledRow = useMemo(
    () => hasPaymentRequiredDisabledRow(unionRows, rowDisabledEffective),
    [unionRows, rowDisabledEffective],
  );

  /** 写停用轴:乐观覆盖 + IPC;失败回滚并提示(错误 = 发生了什么 + 下一步)。 */
  const setRowDisabled = useCallback(
    (row: UnionModelRow, disabled: boolean) => {
      if (!disabled && !selectionAvailable) return;
      setPendingDisabled((prev) => ({ ...prev, [row.id]: disabled }));
      void window.electronAPI.maker
        .setModelDisable({
          kind: 'model',
          providerId: provider.id,
          modelIds: rowModelIds(row),
          disabled,
        })
        .catch(() => {
          setPendingDisabled((prev) => {
            // 只回滚仍属于本次请求的乐观态:IPC 在途期间用户可能又点了反向操作
            // (覆盖了 prev[row.id]),无条件删除会把**后一次**的乐观态一并清掉,
            // UI 回跳旧快照(PR #744 review 第五轮)。值已不同 = 已被更晚的操作
            // 接管,本次失败的回滚不再适用。
            if (prev[row.id] !== disabled) return prev;
            const next = { ...prev };
            delete next[row.id];
            return next;
          });
          toast.error(t('settings.providers.models.accessWriteFailed'));
        });
    },
    [provider.id, selectionAvailable, t],
  );

  const deleteInstalledModel = useCallback(
    async (row: UnionModelRow) => {
      const ok = await confirm({
        title: t('settings.providers.local.deleteModelConfirmTitle', { name: localizedModelName(row.name, t) }),
        description: t('settings.providers.local.deleteModelConfirmBody', { name: localizedModelName(row.name, t) }),
        confirmText: t('settings.providers.local.deleteModelConfirm'),
        cancelText: t('settings.providers.custom.deleteConfirm.cancel'),
        confirmVariant: 'destructive',
      });
      if (!ok) return;
      try {
        await window.electronAPI.maker.localModelDelete(row.id);
        toast.success(t('settings.providers.local.deleteModelDone', { name: localizedModelName(row.name, t) }));
      } catch {
        toast.error(t('settings.providers.local.deleteModelFailed'));
      }
    },
    [confirm, t],
  );

  /** 组级恢复默认(kind:'reset'):删除本供应商整组停用 override —— 供应商级标志、
   *  全部逐模型条目,以及指向已下架模型的**陈旧条目**(它们不渲染成行,逐行启用永远
   *  清不掉;若该模型日后回到目录会被静默停用)。乐观覆盖同 setRowDisabled 口径;
   *  失败整组回滚(只回滚仍属于本次的乐观值)。 */
  const resetDisableOverrides = useCallback(() => {
    // `kind:'reset'` 会删除整组 override，无法排除付费锁定行；保持 fail-closed，
    // 让其它非锁定行继续使用逐行恢复入口。
    if (!selectionAvailable || hasLockedDisabledRow) return;
    const rows = unionRows.filter((r) => pendingDisabled[r.id] ?? isRowDisabled(r));
    setPendingDisabled((prev) => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = false;
      return next;
    });
    void window.electronAPI.maker
      .setModelDisable({ kind: 'reset', providerId: provider.id })
      .catch(() => {
        setPendingDisabled((prev) => {
          const next = { ...prev };
          for (const r of rows) {
            if (next[r.id] === false) delete next[r.id];
          }
          return next;
        });
        toast.error(t('settings.providers.models.accessWriteFailed'));
      });
  }, [hasLockedDisabledRow, unionRows, pendingDisabled, provider.id, selectionAvailable, t]);

  /**
   * 该来源真实存在的**输出类型**:对话 + 各能力类型(图像 / 视频 / 语音…)。
   *
   * 注意不能直接用 `rowCategory` —— `ModelCategory` 把厂商分组(anthropic / gpt /
   * google / china / ungrouped…)和能力类型(image / video / tts…)混在同一个枚举里,
   * 直接拿它当筛选轴会渲染出十来个厂商 chip,和下方的分组标题彻底重复(而分组标题
   * 本来就已经按厂商分好了)。这里按 CAPABILITY_CATEGORIES 折叠:厂商类一律归「对话」,
   * 能力类各自成一类。
   *
   * **只有一类时整条筛选不渲染** —— 那种情况下「全部」和那一类完全等价,
   * 给一个永远不改变结果的控件只是噪音。
   */
  const kindOf = useCallback(
    (row: UnionModelRow): ManagementKind => {
      if (!isCapabilityRow(row, provider.source === 'user')) return 'chat';
      const category = rowCategory(row);
      return CAPABILITY_CATEGORIES.has(category) ? (category as ManagementKind) : 'other';
    },
    [provider.source],
  );
  const presentCategories = useMemo(() => {
    const present = new Set<ModelCategory | 'chat'>();
    for (const row of unionRows) {
      const rep = row.byAgent[row.avail[0]];
      if (rep) present.add(kindOf(row));
    }
    return MANAGEMENT_KIND_ORDER.filter((kind) => present.has(kind));
  }, [kindOf, unionRows]);
  const showKindFilter = presentCategories.length > 1;

  // 分组(仅未停用的行)+「已停用」分区(停用的行,跨分组沉底)。搜索两边都过滤。
  // 分组沿用现有口径:用每行第一个可用 agent 的目录条目作代表参与分组。
  const { groups, hiddenRows, disabledRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q
      ? unionRows.filter((r) => matchesModelName(r, q, t))
      : unionRows;
    const matched =
      showKindFilter && kindFilter !== 'all'
        ? searched.filter((r) => kindOf(r) === kindFilter)
        : searched;
    const active = matched.filter((r) => !rowDisabledEffective(r));
    const disabled = matched.filter((r) => rowDisabledEffective(r));
    /**
     * 未启用(显示轴关闭)的对话行沉到列表底部,与「已停用」并列成区。
     *
     * 为什么沉底:一个来源可能有几十个模型而用户只开了几个,关闭的行散落在各厂商分组
     * 里会把开着的那几个冲淡 —— 用户来这一页最常做的两件事是「看我开了哪些」和
     * 「再开一个」,前者需要开着的集中在上面。
     *
     * 三种行不沉:
     *   - **能力模型行**没有显示轴(全页开关语义唯一 = 显示),不参与这个判定;
     *   - **付费锁定行**的开关本就不可动,沉底只会让用户以为是自己关的;
     */
    const sinkHidden = (r: UnionModelRow) => rowState(r).hidden;
    const hidden = active.filter(sinkHidden);
    const shown = active.filter((r) => !sinkHidden(r));
    const repByRow = new Map<string, UnionModelRow>();
    const reps: CatalogModel[] = [];
    for (const r of shown) {
      const rep = r.byAgent[r.avail[0]];
      if (!rep) continue;
      repByRow.set(rep.id, r);
      reps.push(rep);
    }
    return {
      groups: groupModelsForManagement(reps, managementView, (model) =>
        kindOf(repByRow.get(model.id)!),
      ).map((g) => ({
        key: g.key,
        kind: g.kind,
        brand: g.brand,
        rows: g.models.map((m) => repByRow.get(m.id)).filter((r): r is UnionModelRow => !!r),
      })),
      hiddenRows: [...hidden].sort(compareModelNames),
      disabledRows: [...disabled].sort(compareModelNames),
    };
    // visibilityVersion:沉底判定读 modelVisibilityPrefs,开关一拨行要立刻迁移。
  }, [
    unionRows,
    managementView,
    t,
    query,
    rowDisabledEffective,
    rowState,
    showKindFilter,
    kindFilter,
    kindOf,
    provider.id,
    provider.source,
    visibilityVersion,
  ]);
  useEffect(() => {
    if (!focusedRow) return;
    const groupKey = rowDisabledEffective(focusedRow)
      ? DISABLED_GROUP_KEY
      : hiddenRows.some((row) => row.id === focusedRow.id)
        ? HIDDEN_GROUP_KEY
        : groups.find((group) => group.rows.some((row) => row.id === focusedRow.id))?.key;
    if (!groupKey) return;
    setCollapsedMap((previous) =>
      previous[groupKey] === false ? previous : { ...previous, [groupKey]: false },
    );
  }, [focusedRow, groups, hiddenRows, rowDisabledEffective]);
  const showGroupHeaders = groups.length > 1;
  const showSearch = unionRows.length > 8;

  const selectableRows = unionRows.filter(
    (row) =>
      !isCapabilityRow(row, provider.source === 'user') &&
      !isRowPaymentRequired(row) &&
      !rowDisabledEffective(row),
  );
  // Saved preferences survive disconnection; the count and switches show effective selection.
  const selectedCount = selectableRows.filter((row) => rowState(row).selected).length;
  const refreshLabel = refreshing
    ? t('settings.providers.models.refreshingAria')
    : (refreshIdleLabel ?? t('settings.providers.models.refreshAria'));
  const showVisibilityWriteFailure = useCallback(() => {
    toast.error(t('settings.providers.models.visibilityWriteFailed'));
  }, [t]);

  /** 开启只选推荐引擎；关闭清掉该行所有引擎的显示。写入始终使用各引擎真实模型 ID。 */
  const toggleRow = useCallback(
    (row: UnionModelRow) => {
      if (!selectionAvailable) return;
      const next = !rowAnyEnabled(provider.id, row);
      const targets = modelVisibilityTargets(provider, row, next);
      if (setModelVisibilities(provider.id, targets, next) === false) {
        showVisibilityWriteFailure();
      }
    },
    [provider, selectionAvailable, showVisibilityWriteFailure],
  );

  // Separate commands have stable meanings even when the selection is mixed. Adding all
  // models skips already selected rows, preserving every explicit advanced harness choice.
  const handleBulk = (action: 'show' | 'hide' | 'reset') => {
    if (!selectionAvailable) return;
    const next = action === 'show';
    const rows = next
      ? selectableRows.filter((row) => !rowAnyEnabled(provider.id, row))
      : selectableRows;
    const targets = rows.flatMap((row) => modelVisibilityTargets(provider, row, next));
    const success =
      action === 'reset'
        ? resetModelVisibilities(provider.id, targets)
        : setModelVisibilities(provider.id, targets, next);
    if (!success) showVisibilityWriteFailure();
  };

  /**
   * 行尾「高级设置」(hover 显现;抽屉打开期间保持可见)。
   *
   * 它替代了原先的「⋯」菜单:那个菜单里三项(自定义报价 / 停用此模型 / 删除本机模型)
   * 全部搬进抽屉,一项能力都没减。换掉的理由是那个菜单只有一个真入口值得点开 ——
   * 多一层点击只是把配置藏起来,而抽屉本身就是配置该去的地方。
   */
  const rowAdvancedButton = (row: UnionModelRow) => (
    <Tip text={t('settings.providers.models.advanced.open')}>
      <button
        type="button"
        aria-label={t('settings.providers.models.advanced.openAria', { name: localizedModelName(row.name, t) })}
        onClick={() => openAdvanced(row)}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity',
          'hover:bg-[var(--surface-hover)] focus-visible:opacity-100 group-hover:opacity-100',
          advancedOpen && advancedRow?.id === row.id && 'opacity-100',
        )}
        style={{ color: 'var(--text-tertiary)' }}
      >
        <SlidersHorizontal size={14} />
      </button>
    </Tip>
  );

  /**
   * 一行模型的渲染。抽成函数是因为它现在有**两个调用点**:厂商分组里,以及底部
   * 「未启用」沉底区。两边必须逐像素一致 —— 复制一份 150 行 JSX 的话,任何一次
   * 行内改动都会漏掉另一边。
   */
  const renderModelRow = (row: UnionModelRow) => {
    const rep = row.byAgent[row.avail[0]]!;
    const capability = isCapabilityRow(row, provider.source === 'user');
    const state = rowState(row);
    const anyOn = state.selected;
    const brand = modelBrand(rep);
    const explicitIcon = resolveModelIconKind(rep.icon);
    const logoKind =
      explicitIcon === 'claude'
        ? 'anthropic'
        : explicitIcon === 'codex'
          ? 'openai'
          : explicitIcon === 'cindy'
            ? 'xd'
            : brand?.logoKind;
    const paymentRequired = isRowPaymentRequired(row);
    // 能力注记:多 agent 供应商里缺少任一通道就标(单 agent 供应商头部已说明);
    // 能力模型行不标(它们本来就不参与 agent 维度)。
    const missingAgents = provider.agents.filter((agent) => !row.avail.includes(agent));
    const capNote =
      !capability && multiAgent && missingAgents.length > 0
        ? t('settings.providers.models.capabilityNote', {
            agent: missingAgents.map((agent) => AGENT_LABEL[agent]).join(' / '),
          })
        : null;
    return (
      <div
        key={row.id}
        ref={focusedRow?.id === row.id ? focusRowRef : undefined}
        tabIndex={focusedRow?.id === row.id ? -1 : undefined}
        data-deep-link-target={focusedRow?.id === row.id ? 'true' : undefined}
        className={cn(
          focusedRow?.id === row.id && 'bg-[var(--surface-hover)] ring-2 ring-[var(--focus-ring)]',
          'group flex items-center gap-3 rounded-lg px-2 py-[7px] transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
          !state.ready && 'opacity-55',
        )}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--text-secondary)]"
          aria-hidden="true"
        >
          {logoKind || !brand ? (
            <ProviderLogoMark
              providerId={provider.id}
              routing={provider.routing}
              {...(logoKind ? { logoKind } : {})}
              size={19}
            />
          ) : (
            <span className="text-13 font-semibold">{brand.label.slice(0, 1)}</span>
          )}
        </span>
        <span
          className="min-w-0 truncate text-14 font-medium"
          style={{
            color: state.ready && (capability || anyOn) ? 'var(--settings-section-title)' : 'var(--text-tertiary)',
          }}
        >
          {localizedModelName(rep.name, t)}
        </span>
        {/* 价格档与折扣紧跟模型名(不单独成列):这一列不是用来纵向比价的,
                是用来在读到某个模型名时顺手知道它贵不贵。拿不到报价就整个
                不渲染 —— 不画假的「$」也不画「—」。 */}
        {(() => {
          const display = rowPriceDisplay(row);
          if (!display) return null;
          if (display.kind === 'free') {
            return <PriceFreeBadge label={t('newChat.modelSelector.pricing.free')} />;
          }
          if (display.tier === undefined) return null;
          return (
            <PriceTierMarks
              priceDisplay={display}
              symbol={display.symbol ?? '$'}
              tier={display.tier}
              litOf={litWholeMarks}
              formatClipPct={(pct) => String(pct)}
              exposeLit={false}
            />
          );
        })()}
        {provider.id === MANAGED_OLLAMA_PROVIDER_ID && <LocalPackagingTag libraryName={row.id} />}
        {capNote && (
          <Tip text={capNote}>
            <button
              type="button"
              aria-label={capNote}
              onClick={() => openAdvanced(row)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-chip)]"
            >
              <Info size={13} />
            </button>
          </Tip>
        )}
        <span className="min-w-0 flex-1" />
        {paymentRequired && (
          <span
            data-payment-required-unlock
            className="invisible shrink-0 select-none text-11 font-medium text-[var(--text-secondary)] group-hover:visible group-focus-within:visible"
          >
            {t('settings.providers.models.paymentUnlock')}
          </span>
        )}
        {paymentRequired && (
          <span
            data-payment-required-badge
            className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium text-[var(--text-secondary)]"
          >
            <Lock size={11} />
            {t('settings.providers.models.paymentRequired')}
          </span>
        )}
        {/* 上下文窗口已移进高级设置抽屉的「规格」段:它是「查一次就够」
            的属性,常驻列表只会让每行更碎,而真正要决策的是「这个模型贵不贵、
            开没开」。抽屉里给的还是带千分位的准确 token 数 —— 列表这种紧凑
            位置的 1M / 128K 缩写在真实数据里是歧义的(1,000,000 /
            1,048,576 / 1,050,000 都印成 1M)。 */}
        {rowAdvancedButton(row)}
        {/* 能力模型行没有显示轴 ⇒ 没有开关(全页开关语义唯一 = 显示);
            占同宽空位,保证开关/上下文列跨行对齐。 */}
        {capability && <span className="w-9 shrink-0" />}
        {!capability && (
          <Switch
            disabled={!state.canSelect}
            checked={anyOn}
            onCheckedChange={() => toggleRow(row)}
            aria-label={localizedModelName(rep.name, t)}
          />
        )}
      </div>
    );
  };

  const listEmpty =
    groups.length === 0 && hiddenRows.length === 0 && disabledRows.length === 0 && !query.trim();
  const compactEmpty = Boolean(compactWhenEmpty && listEmpty);
  const compactList = Boolean(compact) || compactEmpty;

  return (
    <div className={cn('flex min-h-0 flex-col', compactList ? 'shrink-0' : 'flex-1')}>
      {/* 第一行说明模型选择与管理，第二行仅筛选当前列表。排列和批量配置在菜单里
          明确分组，任何筛选或排列操作都不写入模型开关。 */}
      {!compactEmpty && (
        <div className="flex flex-col gap-2 px-5 pb-2 pt-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-13 font-medium text-[var(--text-primary)]">
                  {t('settings.providers.models.manage.title')}
                </span>
                <span className="text-11 text-[var(--text-tertiary)]">
                  {t('settings.providers.models.manage.selected', { count: selectedCount })}
                </span>
              </div>
              <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                {t(
                  selectionAvailable
                    ? 'settings.providers.models.manage.hint'
                    : 'settings.providers.models.manage.connectionRequired',
                )}
              </p>
            </div>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing || refreshDisabled}
                aria-busy={refreshing}
                aria-label={refreshLabel}
                title={refreshLabel}
                className={cn(
                  'flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                  (refreshing || refreshDisabled) && 'cursor-not-allowed opacity-60',
                )}
                style={{ color: 'var(--text-secondary)' }}
              >
                <Spinner icon={RefreshCw} size={14} spinning={refreshing} />
              </button>
            )}
            {unionRows.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  >
                    {t('settings.providers.models.manage.menu')}
                    <ChevronDown size={12} aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    {t('settings.providers.models.manage.arrange')}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={managementView}
                    onValueChange={(value) => {
                      if (value === 'brand' || value === 'model') setManagementView(value);
                    }}
                  >
                    <DropdownMenuRadioItem value="brand">
                      {t('settings.providers.models.manage.byBrand')}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="model">
                      {t('settings.providers.models.manage.byName')}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>
                    {t('settings.providers.models.manage.selection')}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={!selectionAvailable || selectedCount === selectableRows.length}
                    onSelect={() => handleBulk('show')}
                  >
                    {t('settings.providers.models.manage.showAll')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!selectionAvailable || selectedCount === 0}
                    onSelect={() => handleBulk('hide')}
                  >
                    {t('settings.providers.models.manage.hideAll')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!selectionAvailable || selectableRows.length === 0}
                    onSelect={() => handleBulk('reset')}
                  >
                    {t('settings.providers.models.manage.reset')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {/* 第二行只在真有筛选控件时才占位:单类型 + 模型少的来源(本机 Ollama 等)
              两个都不渲染,不留一条空行。 */}
          {(showKindFilter || showSearch) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {showKindFilter && (
                <div
                  className="flex flex-wrap items-center gap-0.5 rounded-full p-0.5"
                  style={{ backgroundColor: 'var(--surface-elevated)' }}
                  role="group"
                  aria-label={t('settings.providers.models.kindFilter.aria')}
                >
                  {(['all', ...presentCategories] as Array<ModelCategory | 'chat' | 'all'>).map(
                    (kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setKindFilter(kind)}
                        aria-pressed={kindFilter === kind}
                        className={cn(
                          'h-6 rounded-full px-2.5 text-12 transition-colors',
                          kindFilter === kind
                            ? 'bg-[var(--surface-hover)] font-medium text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        {kind === 'all'
                          ? t('settings.providers.models.kindFilter.all')
                          : kind === 'chat'
                            ? t('settings.providers.models.kindFilter.chat')
                            : t(CATEGORY_LABEL_KEY[kind])}
                      </button>
                    ),
                  )}
                </div>
              )}
              <span className="min-w-0 flex-1" />
              {showSearch && (
                /* basis 200px 但允许收缩:窄窗口(右栏可被压到 ~270px)时先压缩搜索框,
             不让 chip 组被 overflow-hidden 裁掉(PR #1102 review)。 */
                <div
                  className="flex h-8 min-w-0 basis-[200px] items-center gap-2 rounded-full px-3"
                  style={{
                    backgroundColor: 'var(--surface-elevated)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <Search
                    size={14}
                    className="shrink-0"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('settings.providers.models.search')}
                    aria-label={t('settings.providers.models.search')}
                    className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-placeholder)]"
                    style={{ color: 'var(--settings-section-title)' }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 分组 + 模型行 + 底部「已停用」分区:唯一滚动区,与上方固定工具行以
          1px 细线分隔。视觉左右边距 20px = 容器 px-3 + 行 px-2(行悬停底色要包住内容)。 */}
      <div
        className={cn('min-h-0 overflow-y-auto border-t', compactList ? 'shrink-0' : 'flex-1')}
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <div className={cn('flex flex-col gap-4 px-3 pt-1.5', compactList ? 'pb-2' : 'pb-4')}>
          {groups.length === 0 && hiddenRows.length === 0 && disabledRows.length === 0 ? (
            <div
              className={cn(compactEmpty ? 'px-2 py-2 text-left' : 'py-4 text-center', 'text-13')}
              style={{ color: 'var(--text-tertiary)' }}
            >
              {query.trim()
                ? t('settings.providers.models.noResults')
                : (emptyMessage ?? t('settings.providers.models.noResults'))}
            </div>
          ) : (
            groups.map((g) => {
              // 搜索时强制展开(否则匹配项藏在折叠组里看不到);仅多组时才有折叠头。
              const collapsed = showGroupHeaders && !query.trim() && isCollapsed(g.key);
              // 能力语义按**行**判(isCapabilityRow,含自定义供应商的未知 group 豁免),
              // 不能只看分组名:自定义对话模型(如 gpt-4o-audio-preview)会被 groupOf 的
              // id 启发式落进 audio 组展示,但它有显示轴、必须有开关(PR #744 review)。
              // 组级 hint 只在整组都是能力行时显示。
              const userProvider = provider.source === 'user';
              const wholeGroupCapability =
                g.kind !== 'chat' &&
                g.rows.length > 0 &&
                g.rows.every((r) => isCapabilityRow(r, userProvider));
              return (
                <div key={g.key} className="flex flex-col">
                  {showGroupHeaders && (
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(g.key)}
                      aria-expanded={!collapsed}
                      className="flex items-center gap-1 self-start px-2 pb-0.5 text-left transition-opacity hover:opacity-80"
                    >
                      {/* chevron 用 transform 旋转(compositor-only,规则 7);折叠时 -90°。 */}
                      <span
                        className="inline-flex transition-transform duration-150"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: collapsed ? 'rotate(-90deg)' : 'none',
                        }}
                      >
                        <ChevronDown size={12} />
                      </span>
                      <span
                        className="text-11 font-medium uppercase"
                        style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                      >
                        {(g.brand ? localizedBrandName(g.brand, t) : undefined) ??
                          (g.kind === 'chat'
                            ? t('settings.providers.models.kindFilter.chat')
                            : t(CATEGORY_LABEL_KEY[g.kind]))}
                      </span>
                      <span
                        className="text-11 tabular-nums"
                        style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}
                      >
                        {g.rows.length}
                      </span>
                    </button>
                  )}
                  {/* 能力模型组的消歧说明:这组不参与对话模型选择、行内没有显示开关 ——
                    语义与上面的对话模型组不同,必须就地讲清,不能指望用户猜。 */}
                  {wholeGroupCapability && !collapsed && (
                    <span
                      className={cn('pb-1 text-11 leading-snug', showGroupHeaders && 'pl-[24px]')}
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {t('settings.providers.models.capabilityGroupHint')}
                    </span>
                  )}
                  {!collapsed && g.rows.map((row) => renderModelRow(row))}
                </div>
              );
            })
          )}

          {/* 「未启用」分区:显示轴关闭的对话行跨分组沉底。与「已停用」是两回事 ——
              这里的行只是不出现在模型选择器里,仍可被显式点名与自动兜底命中;下面那个
              区是准入关。**默认折叠**:它通常比开着的模型多得多(一个来源几十个模型、
              用户只开几个),默认展开会把刚看完的启用清单直接顶出屏幕。搜索时强制展开。 */}
          {hiddenRows.length > 0 &&
            (() => {
              const collapsed = !query.trim() && isCollapsed(HIDDEN_GROUP_KEY);
              return (
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 pb-0.5">
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(HIDDEN_GROUP_KEY)}
                      aria-expanded={!collapsed}
                      className="flex items-center gap-1 px-2 text-left transition-opacity hover:opacity-80"
                    >
                      <span
                        className="inline-flex transition-transform duration-150"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: collapsed ? 'rotate(-90deg)' : 'none',
                        }}
                      >
                        <ChevronDown size={12} />
                      </span>
                      <span
                        className="text-11 font-medium uppercase"
                        style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                      >
                        {t('settings.providers.models.hiddenGroup')}
                      </span>
                      <span
                        className="text-11 tabular-nums"
                        style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}
                      >
                        {hiddenRows.length}
                      </span>
                    </button>
                  </div>
                  {!collapsed && hiddenRows.map((row) => renderModelRow(row))}
                </div>
              );
            })()}

          {/* 「已停用」分区:停用的行跨分组沉底;默认展开(区里有东西 = 用户主动停的,
              找回路径要一眼可见),搜索时强制展开。行内「启用此模型」即飞回原分组;
              头部「全部启用」= 组级恢复默认(kind:'reset' 删整组 override,含指向已
              下架模型的陈旧条目 —— 逐行启用清不掉它们;configuration-and-overrides.md §4)。
              渲染条件独立于当前渲染行:只剩陈旧条目(disabledRows 为空)或搜索过滤后
              无匹配行时,恢复入口都不能消失(PR #744 review 第二十六轮)。 */}
          {(disabledRows.length > 0 || (provider.disableOverrideCount ?? 0) > 0) &&
            (() => {
              const collapsed = !query.trim() && isCollapsed(DISABLED_GROUP_KEY);
              return (
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 pb-0.5">
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(DISABLED_GROUP_KEY)}
                      aria-expanded={!collapsed}
                      className="flex items-center gap-1 px-2 text-left transition-opacity hover:opacity-80"
                    >
                      <span
                        className="inline-flex transition-transform duration-150"
                        style={{
                          color: 'var(--text-tertiary)',
                          transform: collapsed ? 'rotate(-90deg)' : 'none',
                        }}
                      >
                        <ChevronDown size={12} />
                      </span>
                      <span
                        className="text-11 font-medium uppercase"
                        style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                      >
                        {t('settings.providers.models.disabledGroup')}
                      </span>
                      <span
                        className="text-11 tabular-nums"
                        style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}
                      >
                        {/* 行数为 0 而 override 仍在(陈旧条目 / 搜索过滤)时显示 override 数,
                          让「还有 N 条停用配置」可感知。 */}
                        {disabledRows.length > 0
                          ? disabledRows.length
                          : (provider.disableOverrideCount ?? 0)}
                      </span>
                    </button>
                    {!hasLockedDisabledRow && (
                      <button
                        type="button"
                        disabled={!selectionAvailable}
                        onClick={resetDisableOverrides}
                        className="rounded-lg px-1.5 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {t('settings.providers.models.enableAllModels')}
                      </button>
                    )}
                  </div>
                  {!collapsed &&
                    disabledRows.map((row) => {
                      const rep = row.byAgent[row.avail[0]]!;
                      const paymentRequired = isRowPaymentRequired(row);
                      // 可折行:最小窗口(右栏 ~275px)下「启用此模型」(日文更长)放
                      // 不下时换行,恢复入口始终可达(PR #1102 review 第四轮)。
                      return (
                        <div
                          key={row.id}
                          ref={focusedRow?.id === row.id ? focusRowRef : undefined}
                          tabIndex={focusedRow?.id === row.id ? -1 : undefined}
                          data-deep-link-target={focusedRow?.id === row.id ? 'true' : undefined}
                          className={cn(
                            'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-[7px]',
                            focusedRow?.id === row.id &&
                              'bg-[var(--surface-hover)] ring-2 ring-[var(--focus-ring)]',
                          )}
                        >
                          <span
                            className="min-w-0 truncate text-14 font-medium"
                            style={{ color: 'var(--text-disabled)' }}
                          >
                            {localizedModelName(rep.name, t)}
                          </span>
                          {/* 来源分组注记:启用后会回到哪个组,别让用户猜。 */}
                          <span
                            className="shrink-0 text-12"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {modelBrand(rep) ? localizedBrandName(modelBrand(rep)!, t) : t(CATEGORY_LABEL_KEY[rowCategory(row)])}
                          </span>
                          <span className="min-w-0 flex-1" />
                          {paymentRequired && (
                            <span
                              data-payment-required-badge
                              className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium text-[var(--text-secondary)]"
                            >
                              <Lock size={11} />
                              {t('settings.providers.models.paymentRequired')}
                            </span>
                          )}
                          {!paymentRequired && (
                            <button
                              type="button"
                              disabled={!selectionAvailable}
                              onClick={() => setRowDisabled(row, false)}
                              className="ml-auto flex h-6 shrink-0 items-center rounded-full border px-2.5 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                              style={{
                                borderColor: 'var(--settings-btn-secondary-border)',
                                color: 'var(--settings-btn-secondary-text)',
                              }}
                            >
                              {t('settings.providers.models.enableModel')}
                            </button>
                          )}
                          {provider.id === MANAGED_OLLAMA_PROVIDER_ID && (
                            <button
                              type="button"
                              onClick={() => void deleteInstalledModel(row)}
                              className="flex h-6 shrink-0 items-center rounded-full px-2.5 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                              style={{ color: 'var(--error-fg)' }}
                            >
                              {t('settings.providers.local.deleteModel')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })()}
        </div>
      </div>
      <ModelAdvancedDrawer
        provider={provider}
        row={currentAdvancedRow}
        open={advancedOpen && currentAdvancedRow !== null}
        onOpenChange={(next) => {
          setAdvancedOpen(next);
        }}
        pricePresentationOf={pricePresentationOf}
        disabled={currentAdvancedRow ? rowDisabledEffective(currentAdvancedRow) : false}
        paymentRequired={currentAdvancedRow ? isRowPaymentRequired(currentAdvancedRow) : false}
        onDisable={(row) => {
          // 抽屉里的停用/启用与列表行同一条写入路径(乐观覆盖 + IPC),不另开一套。
          setRowDisabled(row, !rowDisabledEffective(row));
          setAdvancedOpen(false);
        }}
        {...(provider.id === MANAGED_OLLAMA_PROVIDER_ID
          ? {
              onDeleteLocal: (row: UnionModelRow) => {
                setAdvancedOpen(false);
                void deleteInstalledModel(row);
              },
            }
          : {})}
      />
    </div>
  );
}
