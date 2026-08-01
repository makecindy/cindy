/**
 * UnifiedModelList —— 供应商详情面板的「以模型为主体」统一列表。
 *
 * 设计(2026-07 模型供应商重构定稿 + 2026-07-28 启用/显示双轴交互定稿):
 *   - 列表 = 该供应商**所有 agent 的模型并集**(按 model id 合并),不再按 CLI 分 Tab。
 *   - 三个概念钉死到三种互不借用的表达上(用户裁决):
 *       · **开关 = 显示轴**(仅对话模型行):是否出现在模型选择面板 —— 纯陈列,全页
 *         唯一一种开关语义。隐藏的模型被显式点名 / 自动兜底时仍可用。存储 =
 *         renderer modelVisibilityPrefs(不变)。
 *       · **「⋯」菜单 = 停用动作**(所有行,hover 显现):停用 = 准入关,不可被任何
 *         新路由选中。存储 = main 侧 model-disable-store,经 PROVIDER_LIST 的
 *         model.disabled 标志回读,写走 setModelDisable IPC。
 *       · **底部「已停用」分区 = 停用状态**:停用的行离开原分组、沉到列表底部的
 *         折叠区(复用分组折叠交互,默认展开),行内「启用此模型」即飞回原分组。
 *         "下沉"是停用在整个设置页的统一隐喻(左栏停用的供应商同样沉底)。
 *   - **能力模型组**(图像/音频/视频/向量/其它):不能当 agent 用,永远不进对话模型
 *     选择面板(modelList.ts 硬排除),没有显示轴 ⇒ 行内**没有开关**,只有「⋯」停用;
 *     其启用状态控制媒体生成等专属链路能否使用它。
 *   - 普通模式:对话模型行恒为一个开关,一次拨动同时写该模型全部可用 agent 的可见性
 *     override;分歧(双端可用但可见性不同)以「已在 X 隐藏」chip 提示,点击进入分别调整。
 *   - 分别调整模式:对话模型行统一变为两列(列头 Claude Code / Codex),模型在某 agent
 *     不可用时该格显示「—」。停用行不在分组里,不参与分别模式(停用不分 agent,一停全停)。
 *
 * 同一模式下同一轴的控件形态唯一 —— 这是本组件的硬约束(v4 交互稿定稿延续)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, MoreHorizontal, RefreshCw, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  groupModelsForDisplay,
  groupOf,
  CATEGORY_LABEL_KEY,
  type ModelCategory,
} from '@/components/new-chat/sourceSwitch';
import {
  isModelEnabled,
  setManyVisibility,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import { ModelPriceOverrideDialog } from './ModelPriceOverrideDialog';

import { isAgentSelectableModel } from '@cindy/model-providers';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

/**
 * 分组折叠态(仅 UI 展示,按设备记忆)。非对话类型组(图像/视频/语音合成/语音转写/
 * 实时音频/向量/压缩/其它)默认折叠——它们是网关多出的、不能当 agent 用的模型,默认
 * 收起让列表清爽;对话厂商组默认展开;底部「已停用」分区(key = '__disabled')默认
 * **展开**——区里有东西说明是用户主动停的,找回路径要一眼可见。只存用户显式改过的组
 * (与 modelVisibilityPrefs 同哲学:未改的跟随默认),搜索时强制全展开。
 * CAPABILITY_CATEGORIES 同时就是「能力模型组」的判定(成员 = classification 的非 agent 分组)。
 */
const COLLAPSE_STORAGE_KEY = 'xdt:modelListCollapsedGroups:v1';
const DISABLED_GROUP_KEY = '__disabled';
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

function loadCollapsedMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
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
        const row: UnionModelRow = { id: key, name: m.name, byAgent: { [agent]: m }, avail: [agent] };
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
  const media: Array<{ id: string; name: string; disabled?: boolean; group: 'image' | 'video' }> = [
    ...(provider.imageModels ?? []).map((m) => ({ ...m, group: 'image' as const })),
    ...(provider.videoModels ?? []).map((m) => ({ ...m, group: 'video' as const })),
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
      ...(m.disabled === true ? { disabled: true } : {}),
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

/** 该行是否是「能力模型」(图像/音频/视频/向量等,没有显示轴;见头注)。
 *  `userProvider` = 行来自用户自定义供应商 —— 自定义对话模型的未知 group 不吃 id
 *  启发式(`gpt-4o-audio-preview` 是合法对话模型,见 isAgentSelectableModel 注释)。 */
export function isCapabilityRow(row: UnionModelRow, userProvider: boolean): boolean {
  const rep = row.byAgent[row.avail[0]];
  return !!rep && !isAgentSelectableModel(rep, { userProvider });
}

/** 分歧 = 双端可用且可见性不同(仅对话模型行有意义)。 */
export function isRowDiverged(providerId: string, row: UnionModelRow): boolean {
  if (row.avail.length < 2) return false;
  const values = row.avail.map((a) => rowEnabled(providerId, row, a));
  return values.some((v) => v !== values[0]);
}

/**
 * 每个 Agent 各自的模型显示数;UI 必须保留 Agent 维度,不能汇总成模型条目总数。
 * 口径 = 对话模型(能力模型没有显示轴)且未停用(停用行不可显示,不计入分母)。
 * `isDisabled` 允许调用方注入停用判定(组件里 = 快照标志叠加 pendingDisabled 乐观
 * 覆盖,否则乐观窗口内「全部显示/隐藏」的方向与分母陈旧,PR #744 review);缺省读
 * 快照的 model.disabled。
 */
export function countModelsByAgent(
  provider: ProviderView,
  isDisabled: (agent: AgentKind, model: CatalogModel) => boolean = (_agent, model) =>
    model.disabled === true,
): Array<{
  agent: AgentKind;
  on: number;
  total: number;
}> {
  return provider.agents.map((agent) => {
    const models = (provider.models[agent] ?? []).filter(
      (model) =>
        isAgentSelectableModel(model, { userProvider: provider.source === 'user' }) &&
        !isDisabled(agent, model),
    );
    return {
      agent,
      on: models.filter((model) => isModelEnabled(agent, provider.id, model)).length,
      total: models.length,
    };
  });
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
  return rep ? groupOf(rep) : 'other';
}

export function UnifiedModelList({
  provider,
  onRefresh,
  refreshing,
  refreshDisabled,
  refreshIdleLabel,
  emptyMessage,
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
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [splitMode, setSplitMode] = useState(false);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(loadCollapsedMap);
  // 停用写入的乐观覆盖:setModelDisable 走 IPC → main 落盘 → PROVIDER_CHANGED 广播 →
  // useProviders 快照刷新,期间(可能上百毫秒,含凭证库读取)用本地覆盖顶住 —— 行在
  // 分组与「已停用」分区之间的迁移一次到位,不出现回跳帧(规则 7)。新快照到达即清空。
  const [pendingDisabled, setPendingDisabled] = useState<Record<string, boolean>>({});
  const [priceRow, setPriceRow] = useState<UnionModelRow | null>(null);
  useEffect(() => {
    setPendingDisabled({});
    setPriceRow(null);
  }, [provider]);

  // 折叠态:分组用 ModelCategory 作 key,「已停用」分区用 DISABLED_GROUP_KEY(默认展开)。
  const isCollapsed = useCallback(
    (key: string) =>
      collapsedMap[key] ??
      (key !== DISABLED_GROUP_KEY && DEFAULT_COLLAPSED_CATEGORIES.has(key as ModelCategory)),
    [collapsedMap],
  );
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedMap((prev) => {
      const defaultCollapsed =
        key !== DISABLED_GROUP_KEY && DEFAULT_COLLAPSED_CATEGORIES.has(key as ModelCategory);
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

  const multiAgent = provider.agents.length > 1;
  const unionRows = useMemo(() => buildUnionRows(provider), [provider]);

  const rowDisabledEffective = useCallback(
    (row: UnionModelRow) => pendingDisabled[row.id] ?? isRowDisabled(row),
    [pendingDisabled],
  );

  /** 写停用轴:乐观覆盖 + IPC;失败回滚并提示(错误 = 发生了什么 + 下一步)。 */
  const setRowDisabled = useCallback(
    (row: UnionModelRow, disabled: boolean) => {
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
    [provider.id, t],
  );

  /** 组级恢复默认(kind:'reset'):删除本供应商整组停用 override —— 供应商级标志、
   *  全部逐模型条目,以及指向已下架模型的**陈旧条目**(它们不渲染成行,逐行启用永远
   *  清不掉;若该模型日后回到目录会被静默停用)。乐观覆盖同 setRowDisabled 口径;
   *  失败整组回滚(只回滚仍属于本次的乐观值)。 */
  const resetDisableOverrides = useCallback(() => {
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
  }, [unionRows, pendingDisabled, provider.id, t]);

  // 分组(仅未停用的行)+「已停用」分区(停用的行,跨分组沉底)。搜索两边都过滤。
  // 分组沿用现有口径:用每行第一个可用 agent 的目录条目作代表参与分组。
  const { groups, disabledRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? unionRows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      : unionRows;
    const active = matched.filter((r) => !rowDisabledEffective(r));
    const disabled = matched.filter((r) => rowDisabledEffective(r));
    const repByRow = new Map<string, UnionModelRow>();
    const reps: CatalogModel[] = [];
    for (const r of active) {
      const rep = r.byAgent[r.avail[0]];
      if (!rep) continue;
      repByRow.set(rep.id, r);
      reps.push(rep);
    }
    return {
      groups: groupModelsForDisplay(reps).map((g) => ({
        category: g.category,
        rows: g.models
          .map((m) => repByRow.get(m.id))
          .filter((r): r is UnionModelRow => !!r),
      })),
      disabledRows: disabled,
    };
  }, [unionRows, query, rowDisabledEffective]);
  const showGroupHeaders = groups.length > 1;
  const showSearch = unionRows.length > 8;

  // 每个 Agent 单独计数。不能把「模型 × Agent」压成一个总数，否则 6 个双端模型
  // 会显示为 12，用户会自然地把它误读成 12 个模型。
  // visibilityVersion 是 countModelsByAgent 读取的外部 store 失效信号，必须进依赖数组。
  // 停用判定叠加 pendingDisabled(按规范化行 key):乐观窗口内计数/allOn 与行迁移同步。
  const agentCounts = useMemo(
    () =>
      countModelsByAgent(
        provider,
        (agent, m) =>
          pendingDisabled[canonicalModelKey(provider, agent, m.id)] ?? m.disabled === true,
      ),
    [provider, visibilityVersion, pendingDisabled],
  );
  const totalModelsAcrossAgents = agentCounts.reduce((sum, count) => sum + count.total, 0);
  const allOn = totalModelsAcrossAgents > 0 && agentCounts.every((count) => count.on === count.total);
  const refreshLabel = refreshing
    ? t('settings.providers.models.refreshingAria')
    : (refreshIdleLabel ?? t('settings.providers.models.refreshAria'));

  /** 单开关(显示轴):一次写该行全部可用 agent(分歧行拨动即归一)。写入用各 agent 的
   *  **真实模型 id**(桥接投影行两端 id 不同:chatgpt/gpt-5.5 vs gpt-5.5),不能用规范化后的 row.id。 */
  const toggleRow = useCallback(
    (row: UnionModelRow) => {
      const next = !rowAnyEnabled(provider.id, row);
      for (const a of row.avail) {
        const m = row.byAgent[a];
        if (m) setModelVisibility(a, provider.id, m.id, next);
      }
    },
    [provider.id],
  );

  /** 全部显示 / 隐藏:逐 agent 批量写(单 agent 一次落盘)。只作用于**对话模型的显示轴**
   *  —— 能力模型没有显示轴,停用行没有可显示态,都不写(写了 = 无效 override 污染存储,
   *  且历史上会把图像模型漏进选择器)。停用判定含乐观覆盖(pendingDisabled,按规范化
   *  行 key):刚停用、快照未回来的行同样不写(PR #744 review)。 */
  const handleBulk = useCallback(() => {
    const next = !allOn;
    for (const agent of provider.agents) {
      const ids = (provider.models[agent] ?? [])
        .filter(
          (m) =>
            isAgentSelectableModel(m, { userProvider: provider.source === 'user' }) &&
            (pendingDisabled[canonicalModelKey(provider, agent, m.id)] ?? m.disabled === true) !==
              true,
        )
        .map((m) => m.id);
      setManyVisibility(agent, provider.id, ids, next);
    }
  }, [allOn, provider, pendingDisabled]);

  /** 行级「⋯」菜单(hover 显现;菜单打开期间保持可见):停用动作的唯一入口。 */
  const rowMenu = (row: UnionModelRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.providers.detail.moreActionsAria')}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity',
            'hover:bg-[var(--surface-hover)] focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100',
          )}
          style={{ color: 'var(--text-tertiary)' }}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {provider.id !== 'xd' &&
          !isCapabilityRow(row, provider.source === 'user') && (
            <DropdownMenuItem onClick={() => setPriceRow(row)}>
              {t('settings.providers.models.priceOverride.menu')}
            </DropdownMenuItem>
          )}
        <DropdownMenuItem onClick={() => setRowDisabled(row, true)}>
          {t('settings.providers.models.disableModel')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行:标题(开关语义的唯一说明,**常驻**,不被搜索框挤掉 —— 2026-07-28 用户
          反馈)+ 搜索 + 刷新(自定义) + 分别调整(双 agent) + 全部开关 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
        <span className="shrink-0 text-13 font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.providers.models.available')}
        </span>
        <span className="min-w-0 flex-1" />
        {showSearch && (
          /* basis 200px 但允许收缩:窄窗口(右栏可被压到 ~270px)时先压缩搜索框,
             不让右侧操作被 overflow-hidden 裁掉(PR #1102 review)。 */
          <div
            className="flex h-8 min-w-0 basis-[200px] items-center gap-2 rounded-full px-3"
            style={{ backgroundColor: 'var(--surface-elevated)', border: '1px solid var(--border-default)' }}
          >
            <Search size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
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
        {unionRows.length > 0 && multiAgent && (
          <button
            type="button"
            onClick={() => setSplitMode((v) => !v)}
            className="shrink-0 text-12 font-medium transition-opacity hover:opacity-80"
            style={{ color: splitMode ? 'var(--settings-section-title)' : 'var(--text-secondary)' }}
          >
            {t(splitMode ? 'settings.providers.models.splitDone' : 'settings.providers.models.splitAdjust')}
          </button>
        )}
        {unionRows.length > 0 && (
          <button
            type="button"
            onClick={handleBulk}
            className="shrink-0 text-12 font-medium transition-opacity hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t(allOn ? 'settings.providers.models.disableAll' : 'settings.providers.models.enableAll')}
          </button>
        )}
      </div>

      {/* 分别模式列头(与行内双列同宽对齐)。 */}
      {splitMode && (
        <div className="flex items-center justify-end px-5 pb-1">
          <div className="flex">
            {provider.agents.map((a) => (
              <span
                key={a}
                className="w-20 text-center text-11 font-medium uppercase"
                style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
              >
                {AGENT_LABEL[a]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 分组 + 模型行 + 底部「已停用」分区:唯一滚动区,与上方固定工具行以
          1px 细线分隔。视觉左右边距 20px = 容器 px-3 + 行 px-2(行悬停底色要包住内容)。 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto border-t"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <div className="flex flex-col gap-4 px-3 pb-4 pt-1.5">
          {groups.length === 0 && disabledRows.length === 0 ? (
            <div className="py-4 text-center text-13" style={{ color: 'var(--text-tertiary)' }}>
              {query.trim()
                ? t('settings.providers.models.noResults')
                : (emptyMessage ?? t('settings.providers.models.noResults'))}
            </div>
          ) : (
            groups.map((g) => {
              // 搜索时强制展开(否则匹配项藏在折叠组里看不到);仅多组时才有折叠头。
              const collapsed = showGroupHeaders && !query.trim() && isCollapsed(g.category);
              // 能力语义按**行**判(isCapabilityRow,含自定义供应商的未知 group 豁免),
              // 不能只看分组名:自定义对话模型(如 gpt-4o-audio-preview)会被 groupOf 的
              // id 启发式落进 audio 组展示,但它有显示轴、必须有开关(PR #744 review)。
              // 组级 hint 只在整组都是能力行时显示。
              const userProvider = provider.source === 'user';
              const wholeGroupCapability =
                CAPABILITY_CATEGORIES.has(g.category) &&
                g.rows.length > 0 &&
                g.rows.every((r) => isCapabilityRow(r, userProvider));
              return (
              <div key={g.category} className="flex flex-col">
                {showGroupHeaders && (
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(g.category)}
                    aria-expanded={!collapsed}
                    className="flex items-center gap-1 self-start px-2 pb-0.5 text-left transition-opacity hover:opacity-80"
                  >
                    {/* chevron 用 transform 旋转(compositor-only,规则 7);折叠时 -90°。 */}
                    <span
                      className="inline-flex transition-transform duration-150"
                      style={{ color: 'var(--text-tertiary)', transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                    >
                      <ChevronDown size={12} />
                    </span>
                    <span
                      className="text-11 font-medium uppercase"
                      style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                    >
                      {t(CATEGORY_LABEL_KEY[g.category])}
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
                {!collapsed &&
                  g.rows.map((row) => {
                  const rep = row.byAgent[row.avail[0]]!;
                  const capability = isCapabilityRow(row, userProvider);
                  const diverged = !capability && isRowDiverged(provider.id, row);
                  const anyOn = rowAnyEnabled(provider.id, row);
                  // 能力注记:多 agent 供应商里缺少任一通道就标(单 agent 供应商头部已说明);
                  // 能力模型行不标(它们本来就不参与 agent 维度)。
                  const missingAgents = provider.agents.filter(
                    (agent) => !row.avail.includes(agent),
                  );
                  const capNote =
                    !capability && multiAgent && missingAgents.length > 0
                      ? t('settings.providers.models.capabilityNote', {
                          agent: missingAgents.map((agent) => AGENT_LABEL[agent]).join(' / '),
                        })
                      : null;
                  // 上下文窗口取代表值;双端不同用原生 title 提示。
                  const ctxValues = row.avail
                    .map((a) => row.byAgent[a]?.contextWindow)
                    .filter((v): v is number => typeof v === 'number');
                  const ctxDiffers = new Set(ctxValues).size > 1;
                  const ctxTitle = ctxDiffers
                    ? row.avail
                        .map((a) => `${AGENT_LABEL[a]} ${formatContextWindow(row.byAgent[a]!.contextWindow)}`)
                        .join(' · ')
                    : undefined;
                  const hiddenAgent = diverged
                    ? row.avail.find((a) => rowEnabled(provider.id, row, a) === false)
                    : undefined;
                  return (
                    <div
                      key={row.id}
                      className="group flex items-center gap-3 rounded-lg px-2 py-[7px] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span
                        className="min-w-0 truncate text-14 font-medium"
                        style={{
                          color:
                            capability || anyOn
                              ? 'var(--settings-section-title)'
                              : 'var(--text-tertiary)',
                        }}
                      >
                        {rep.name}
                      </span>
                      {capNote && (
                        /* 注记可收缩截断:窄栏(最小窗口右栏 ~275px)下先压缩次要
                            元数据,保住右侧上下文/菜单/开关列(PR #1102 review 第五轮);
                            截断时悬停可见全文。 */
                        <span
                          className="min-w-0 truncate text-12"
                          style={{ color: 'var(--text-tertiary)' }}
                          title={capNote}
                        >
                          {capNote}
                        </span>
                      )}
                      <span className="min-w-0 flex-1" />
                      {!splitMode && diverged && hiddenAgent && (
                        <button
                          type="button"
                          onClick={() => setSplitMode(true)}
                          className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium transition-opacity hover:opacity-80"
                          style={{
                            backgroundColor: 'var(--surface-chip)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {t('settings.providers.models.divergedChip', { agent: AGENT_LABEL[hiddenAgent] })}
                        </button>
                      )}
                      {/* 固定 44px 右对齐列:上下扫读时数字齐成一条线;合成媒体行
                          (专属清单下发)没有上下文窗口元数据(=0),留空占位保持列对齐。 */}
                      {/* 分别调整模式隐藏上下文列:两列开关 + 菜单在最小窗口
                          (右栏 ~275px)下必须完整可见,上下文是次要元数据,
                          普通模式仍展示(PR #1102 review 第二轮)。 */}
                      {!splitMode && (
                        <span
                          className="w-11 shrink-0 text-right text-12 tabular-nums"
                          style={{ color: 'var(--text-tertiary)' }}
                          title={ctxTitle}
                        >
                          {rep.contextWindow > 0 ? formatContextWindow(rep.contextWindow) : ''}
                        </span>
                      )}
                      {rowMenu(row)}
                      {/* 能力模型行没有显示轴 ⇒ 没有开关(全页开关语义唯一 = 显示);
                          占同宽空位,保证开关/上下文列跨行对齐。 */}
                      {capability && (
                        <span
                          className="shrink-0"
                          style={{ width: splitMode ? provider.agents.length * 80 : 36 }}
                        />
                      )}
                      {!capability &&
                        (splitMode ? (
                          <div className="flex shrink-0 items-center">
                            {provider.agents.map((a) => {
                              const m = row.byAgent[a];
                              return (
                                <span key={a} className="flex w-20 items-center justify-center">
                                  {m ? (
                                    <Switch
                                      checked={isModelEnabled(a, provider.id, m)}
                                      onCheckedChange={(v) => setModelVisibility(a, provider.id, m.id, v)}
                                      aria-label={`${rep.name} · ${AGENT_LABEL[a]}`}
                                    />
                                  ) : (
                                    <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                                      —
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <Switch checked={anyOn} onCheckedChange={() => toggleRow(row)} aria-label={rep.name} />
                        ))}
                    </div>
                  );
                })}
              </div>
              );
            })
          )}

          {/* 「已停用」分区:停用的行跨分组沉底;默认展开(区里有东西 = 用户主动停的,
              找回路径要一眼可见),搜索时强制展开。行内「启用此模型」即飞回原分组;
              头部「全部启用」= 组级恢复默认(kind:'reset' 删整组 override,含指向已
              下架模型的陈旧条目 —— 逐行启用清不掉它们;configuration-and-overrides.md §4)。
              渲染条件独立于当前渲染行:只剩陈旧条目(disabledRows 为空)或搜索过滤后
              无匹配行时,恢复入口都不能消失(PR #744 review 第二十六轮)。 */}
          {(disabledRows.length > 0 || (provider.disableOverrideCount ?? 0) > 0) && (() => {
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
                      style={{ color: 'var(--text-tertiary)', transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                    >
                      <ChevronDown size={12} />
                    </span>
                    <span
                      className="text-11 font-medium uppercase"
                      style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                    >
                      {t('settings.providers.models.disabledGroup')}
                    </span>
                    <span className="text-11 tabular-nums" style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}>
                      {/* 行数为 0 而 override 仍在(陈旧条目 / 搜索过滤)时显示 override 数,
                          让「还有 N 条停用配置」可感知。 */}
                      {disabledRows.length > 0 ? disabledRows.length : provider.disableOverrideCount ?? 0}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={resetDisableOverrides}
                    className="rounded-lg px-1.5 py-0.5 text-11 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {t('settings.providers.models.enableAllModels')}
                  </button>
                </div>
                {!collapsed &&
                  disabledRows.map((row) => {
                    const rep = row.byAgent[row.avail[0]]!;
                    // 可折行:最小窗口(右栏 ~275px)下「启用此模型」(日文更长)放
                    // 不下时换行,恢复入口始终可达(PR #1102 review 第四轮)。
                    return (
                      <div
                        key={row.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-[7px]"
                      >
                        <span
                          className="min-w-0 truncate text-14 font-medium"
                          style={{ color: 'var(--text-disabled)' }}
                        >
                          {rep.name}
                        </span>
                        {/* 来源分组注记:启用后会回到哪个组,别让用户猜。 */}
                        <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
                          {t(CATEGORY_LABEL_KEY[rowCategory(row)])}
                        </span>
                        <span className="min-w-0 flex-1" />
                        {rep.contextWindow > 0 && (
                          <span
                            className="w-11 shrink-0 text-right text-12 tabular-nums"
                            style={{ color: 'var(--text-disabled)' }}
                          >
                            {formatContextWindow(rep.contextWindow)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setRowDisabled(row, false)}
                          className="ml-auto flex h-6 shrink-0 items-center rounded-full border px-2.5 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                          style={{
                            borderColor: 'var(--settings-btn-secondary-border)',
                            color: 'var(--settings-btn-secondary-text)',
                          }}
                        >
                          {t('settings.providers.models.enableModel')}
                        </button>
                      </div>
                    );
                  })}
              </div>
            );
          })()}
        </div>
      </div>
      {priceRow && (
        <ModelPriceOverrideDialog
          provider={provider}
          row={priceRow}
          open
          onOpenChange={(next) => {
            if (!next) setPriceRow(null);
          }}
        />
      )}
    </div>
  );
}
