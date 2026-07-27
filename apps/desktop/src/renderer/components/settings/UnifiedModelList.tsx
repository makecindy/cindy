/**
 * UnifiedModelList —— 供应商详情面板的「以模型为主体」统一可见性列表。
 *
 * 设计(2026-07 模型供应商重构定稿):
 *   - 列表 = 该供应商**所有 agent 的模型并集**(按 model id 合并),不再按 CLI 分 Tab。
 *   - 普通模式:每行恒为**一个开关**,一次拨动同时写该模型全部可用 agent 的可见性
 *     override(底层仍是 per-agent 的 modelVisibilityPrefs,存储结构不变)。
 *   - 能力事实(模型只存在于某个 CLI):模型名旁的**无边框灰字**「不支持 Codex」——
 *     读作元数据;仅当供应商本身服务双 agent 时才逐行标注(单 agent 供应商由
 *     详情头部统一说明,行级不重复)。
 *   - 用户偏好分歧(双端可用但可见性不同):**带底色 chip**「已在 X 隐藏」,点击进入
 *     分别调整;普通模式下开关显示「任一端开启」,拨动即归一(行为可预期)。
 *   - 分别调整模式:所有行统一变为两列(列头 Claude Code / Codex),模型在某 agent
 *     不可用时该格显示「—」(不是灰开关,避免「灰=关闭?」二次歧义)。
 *
 * 同一模式下控件形态唯一 —— 这是本组件的硬约束(v4 交互稿定稿):普通=每行一个
 * 开关;分别=每行两列。开关数量不携带任何语义。
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  groupModelsForDisplay,
  CATEGORY_LABEL_KEY,
  type ModelCategory,
} from '@/components/new-chat/sourceSwitch';
import {
  isModelEnabled,
  setManyVisibility,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';

import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/**
 * 分组折叠态(仅 UI 展示,按设备记忆)。非对话类型组(图像/音频/视频/向量/其它)默认折叠——
 * 它们是网关多出的、不能当 agent 用的模型,默认收起让列表清爽;对话厂商组默认展开。
 * 只存用户显式改过的组(与 modelVisibilityPrefs 同哲学:未改的跟随默认),搜索时强制全展开。
 */
const COLLAPSE_STORAGE_KEY = 'xdt:modelListCollapsedGroups:v1';
const DEFAULT_COLLAPSED_CATEGORIES = new Set<ModelCategory>([
  'image',
  'audio',
  'video',
  'embedding',
  'other',
]);

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

/** 构建并集(导出供单测):行序 = 第一个 agent 的目录序,后续 agent 独占模型追加其后。 */
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
  return rows;
}

/** 该行在指定 agent 下的可见性(不可用 → null)。 */
function rowEnabled(providerId: string, row: UnionModelRow, agent: AgentKind): boolean | null {
  const m = row.byAgent[agent];
  return m ? isModelEnabled(agent, providerId, m) : null;
}

/** 分歧 = 双端可用且可见性不同。 */
export function isRowDiverged(providerId: string, row: UnionModelRow): boolean {
  if (row.avail.length < 2) return false;
  const values = row.avail.map((a) => rowEnabled(providerId, row, a));
  return values.some((v) => v !== values[0]);
}

/** 每个 Agent 各自的模型显示数；UI 必须保留 Agent 维度，不能汇总成模型条目总数。 */
export function countModelsByAgent(provider: ProviderView): Array<{
  agent: AgentKind;
  on: number;
  total: number;
}> {
  return provider.agents.map((agent) => {
    const models = provider.models[agent] ?? [];
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

  const isCollapsed = useCallback(
    (cat: ModelCategory) => collapsedMap[cat] ?? DEFAULT_COLLAPSED_CATEGORIES.has(cat),
    [collapsedMap],
  );
  const toggleCollapsed = useCallback((cat: ModelCategory) => {
    setCollapsedMap((prev) => {
      const cur = prev[cat] ?? DEFAULT_COLLAPSED_CATEGORIES.has(cat);
      const newVal = !cur;
      const next = { ...prev };
      if (newVal === DEFAULT_COLLAPSED_CATEGORIES.has(cat)) {
        delete next[cat];
      } else {
        next[cat] = newVal;
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

  // 分组沿用现有口径:用每行第一个可用 agent 的目录条目作代表参与分组。
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? unionRows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      : unionRows;
    const repByRow = new Map<string, UnionModelRow>();
    const reps: CatalogModel[] = [];
    for (const r of filtered) {
      const rep = r.byAgent[r.avail[0]];
      if (!rep) continue;
      repByRow.set(rep.id, r);
      reps.push(rep);
    }
    return groupModelsForDisplay(reps).map((g) => ({
      category: g.category,
      rows: g.models
        .map((m) => repByRow.get(m.id))
        .filter((r): r is UnionModelRow => !!r),
    }));
  }, [unionRows, query]);
  const showGroupHeaders = groups.length > 1;
  const showSearch = unionRows.length > 8;

  // 每个 Agent 单独计数。不能把「模型 × Agent」压成一个总数，否则 6 个双端模型
  // 会显示为 12，用户会自然地把它误读成 12 个模型。
  // visibilityVersion 是 countModelsByAgent 读取的外部 store 失效信号，必须进依赖数组。
  const agentCounts = useMemo(() => countModelsByAgent(provider), [provider, visibilityVersion]);
  const totalModelsAcrossAgents = agentCounts.reduce((sum, count) => sum + count.total, 0);
  const allOn = totalModelsAcrossAgents > 0 && agentCounts.every((count) => count.on === count.total);
  const refreshLabel = refreshing
    ? t('settings.providers.models.refreshingAria')
    : (refreshIdleLabel ?? t('settings.providers.models.refreshAria'));

  /** 单开关:一次写该行全部可用 agent(分歧行拨动即归一)。写入用各 agent 的**真实模型 id**
   *  (桥接投影行两端 id 不同:chatgpt/gpt-5.5 vs gpt-5.5),不能用规范化后的 row.id。 */
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

  /** 全部开启 / 关闭:逐 agent 批量写(单 agent 一次落盘)。 */
  const handleBulk = useCallback(() => {
    const next = !allOn;
    for (const agent of provider.agents) {
      const ids = (provider.models[agent] ?? []).map((m) => m.id);
      setManyVisibility(agent, provider.id, ids, next);
    }
  }, [allOn, provider]);

  return (
    <div className="flex flex-col">
      {/* 工具行:搜索 + 计数 + 刷新(自定义) + 分别调整(双 agent) + 全部开关 */}
      <div className="flex items-center gap-3 px-5 py-2.5">
        {showSearch ? (
          <div
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full px-3"
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
        ) : (
          <span className="flex-1 text-13 font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.models.available')}
          </span>
        )}
        <span className="shrink-0 text-12 font-medium tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
          {agentCounts
            .map(({ agent, on, total }) =>
              t('settings.providers.models.agentEnabledCount', { agent: AGENT_LABEL[agent], on, total }),
            )
            .join(' · ')}
        </span>
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
                className="w-[88px] text-center text-11 font-semibold uppercase"
                style={{ color: 'var(--text-tertiary)', letterSpacing: '0.4px' }}
              >
                {AGENT_LABEL[a]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 分组 + 模型行 */}
      <div className="flex flex-col gap-4 px-5 pb-4 pt-0.5">
        {groups.length === 0 ? (
          <div className="py-4 text-center text-13" style={{ color: 'var(--text-tertiary)' }}>
            {query.trim()
              ? t('settings.providers.models.noResults')
              : (emptyMessage ?? t('settings.providers.models.noResults'))}
          </div>
        ) : (
          groups.map((g) => {
            // 搜索时强制展开(否则匹配项藏在折叠组里看不到);仅多组时才有折叠头。
            const collapsed = showGroupHeaders && !query.trim() && isCollapsed(g.category);
            return (
            <div key={g.category} className="flex flex-col">
              {showGroupHeaders && (
                <button
                  type="button"
                  onClick={() => toggleCollapsed(g.category)}
                  aria-expanded={!collapsed}
                  className="flex items-center gap-1 self-start pb-0.5 text-left transition-opacity hover:opacity-80"
                >
                  {/* chevron 用 transform 旋转(compositor-only,规则 7);折叠时 -90°。 */}
                  <span
                    className="inline-flex transition-transform duration-150"
                    style={{ color: 'var(--text-tertiary)', transform: collapsed ? 'rotate(-90deg)' : 'none' }}
                  >
                    <ChevronDown size={12} />
                  </span>
                  <span
                    className="text-11 font-semibold uppercase"
                    style={{ color: 'var(--text-tertiary)', letterSpacing: '0.4px' }}
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
              {!collapsed &&
                g.rows.map((row) => {
                const rep = row.byAgent[row.avail[0]]!;
                const diverged = isRowDiverged(provider.id, row);
                const anyOn = rowAnyEnabled(provider.id, row);
                // 能力注记:仅双 agent 供应商 + 单端模型才标(单 agent 供应商头部已说明)。
                const capNote =
                  multiAgent && row.avail.length === 1
                    ? t('settings.providers.models.capabilityNote', {
                        agent: AGENT_LABEL[row.avail[0] === 'claude-code' ? 'codex' : 'claude-code'],
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
                  <div key={row.id} className="flex items-center gap-3 py-[7px]">
                    <span
                      className="min-w-0 truncate text-14 font-medium"
                      style={{ color: anyOn ? 'var(--settings-section-title)' : 'var(--text-tertiary)' }}
                    >
                      {rep.name}
                    </span>
                    {capNote && (
                      <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
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
                    <span
                      className="shrink-0 text-12 tabular-nums"
                      style={{ color: 'var(--text-tertiary)' }}
                      title={ctxTitle}
                    >
                      {formatContextWindow(rep.contextWindow)}
                    </span>
                    {splitMode ? (
                      <div className="flex shrink-0 items-center">
                        {provider.agents.map((a) => {
                          const m = row.byAgent[a];
                          return (
                            <span key={a} className="flex w-[88px] items-center justify-center">
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
                    )}
                  </div>
                );
              })}
            </div>
            );
          })
        )}
      </div>
    </div>
  );
}
