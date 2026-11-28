/**
 * 设置 → 模型组 → 总览：一张「现在怎么走」的关系图（路线 → 来源），「最近的选择」收在图下面那一行里，点开才列出。
 * 连线按节点的实际位置画在一层 SVG 上，尺寸变化时重画；悬停或聚焦一个节点时，与它相连的整条路径换成深一档的线色。
 * 来源后面的余量来自最近一次选中它时记下的额度，已过重置时刻的不显示。
 * 合并整个供应商的路由按供应商画：右边一个成员一格，不按它展开出的几十个模型逐个画(2026-11-25 用户反馈)。
 * 两种路由各占一段(「按模型」在上、「按供应商」在下，中间一条分隔线)，不穿插排列；只有一种时就只画那一段。
 * 产品规则见 docs/product-rules/model-groups.md。
 */
import { agentOptionOf } from '@/components/new-chat/agentOptions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProviderMark } from '@/components/new-chat/ModelSelector';
import { Collapse } from '@/components/ui/collapse';
import { SettingsBlock, SettingsCard, SettingsSection } from '@/components/ui/settings-rows';
import { modelGroupWhyText, useModelGroupCandidateNames } from '@/features/model-groups/modelGroupsClient';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';

import { modelGroupHarnessLabel } from '../../../shared/modelGroupRouteNoteText';
import type { ModelGroupDecision } from '../../../shared/modelGroupDecisions';
import {
  modelGroupCandidateKey,
  modelGroupSourceKey,
  type ModelGroupCandidate,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupSourceRoute,
  type ModelGroupTraceQuota,
} from '../../../shared/modelGroups';

const log = createLogger('ModelGroupsOverview');
const RECENT_ROWS = 10;
/** 余量到这一档以下按「快见底」着色（DESIGN.md §2 语义色）。 */
const LOW_LEFT_PERCENT = 15;

type CandidateRef = Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model' | 'agentDeviceId' | 'accountId'>;
type CandidateNames = ReturnType<typeof useModelGroupCandidateNames>;

/** 「最近的选择」里一条记录选中的来源；不是选中(沿用原来的)或记录不全时为 null。 */
function decisionCandidate(item: ModelGroupDecision): CandidateRef | null {
  return item.outcome === 'routed' && item.agentKind && item.providerId && item.model
    ? {
        agentKind: item.agentKind,
        providerId: item.providerId,
        model: item.model,
        ...(item.agentDeviceId ? { agentDeviceId: item.agentDeviceId } : {}),
        ...(item.accountId ? { accountId: item.accountId } : {}),
      }
    : null;
}

type NodeKind = 'route' | 'source';
interface MapNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** 打开对应的路线；来源节点没有。 */
  open?: () => void;
  /** 打开时的读屏名称，如「打开路线：主力编程」。 */
  openLabel?: string;
  candidate?: CandidateRef;
  /** 来源后面的余量（%）。 */
  left?: number | null;
  /** 名字后面的一句补充，如合并整个供应商的路由写「7 个模型」。 */
  meta?: string;
  /** 这一格是一整个供应商(合并整个供应商的路由的成员)，不是某个模型。 */
  provider?: boolean;
}
/** 合并整个供应商的路由，连同它在每个模型上展开出的那些路由。 */
interface ProviderRouteView { route: ModelGroupSourceRoute; children: ModelGroupRoute[] }

const memberKey = (item: { agentDeviceId?: string; providerId: string; accountId?: string }) => modelGroupSourceKey(item);

/**
 * 读余量时要解析哪些路由：用户按模型排的每条都读；合并整个供应商的只挑刚好覆盖全部成员的几条展开(通常一两条)，
 * 不把几十个模型逐个解析一遍。
 */
function quotaProbes(userRoutes: readonly ModelGroupRoute[], providerRoutes: readonly ProviderRouteView[]): ModelGroupRoute[] {
  const probes = [...userRoutes];
  for (const { children } of providerRoutes) {
    const covered = new Set<string>();
    for (const child of children) {
      const fresh = child.candidates.filter((candidate) => !covered.has(memberKey(candidate)));
      if (fresh.length === 0) continue;
      for (const candidate of child.candidates) covered.add(memberKey(candidate));
      probes.push(child);
    }
  }
  return probes;
}
interface MapEdge { from: string; to: string; off?: boolean }

const nodeId = (kind: NodeKind, key: string) => `${kind}:${key}`;

/** 从一个节点沿连线只向前、只向后各走到头：与它同在一条路径上的节点。 */
function relatedNodes(id: string, edges: readonly MapEdge[]): Set<string> {
  const out = new Set([id]);
  const walk = (start: string, forward: boolean) => {
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of edges) {
        const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
        if (from !== current || seen.has(to)) continue;
        seen.add(to);
        out.add(to);
        queue.push(to);
      }
    }
  };
  walk(id, true);
  walk(id, false);
  return out;
}

/** 一份额度读数还剩多少；读不到或已过重置时刻时为 null。 */
function leftOf(quota: ModelGroupTraceQuota | null | undefined, now: number): number | null {
  if (!quota || (quota.resetAtMs !== null && quota.resetAtMs <= now)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - quota.usedPercent)));
}

/**
 * 来源格子上的余量：先用此刻读到的额度(与「试一下」、新任务选路同一份)；读不到时退回最近一次选中它时记下的。
 */
function remainingFor(
  candidate: CandidateRef,
  live: ReadonlyMap<string, ModelGroupTraceQuota | null>,
  decisions: readonly ModelGroupDecision[],
  now: number,
): number | null {
  const key = modelGroupCandidateKey(candidate);
  const current = leftOf(live.get(key), now);
  if (current !== null) return current;
  const last = decisions.find((item) => {
    const picked = decisionCandidate(item);
    return !!picked && modelGroupCandidateKey(picked) === key;
  });
  return leftOf(last?.quota, now);
}

/**
 * 打开总览时读各条路线每个来源此刻的额度：与「试一下」同一个只看不选的解析(不推进轮流、不记录)。
 * 读两遍：先要手头已有的读数(立刻回来，打开就有数)，再照常读一遍(额度没读全时最多等两秒)把数换成新的。
 * 只在路线或来源变了时重读，不轮询。
 */
function useLiveSourceQuota(routes: readonly ModelGroupRoute[]): {
  quota: ReadonlyMap<string, ModelGroupTraceQuota | null>;
  names: ReadonlyMap<string, string>;
} {
  const [live, setLive] = useState<{
    quota: ReadonlyMap<string, ModelGroupTraceQuota | null>;
    names: ReadonlyMap<string, string>;
  }>(() => ({ quota: new Map(), names: new Map() }));
  const routesKey = routes
    .map((route) => `${route.id}\u0001${route.candidates.map((candidate) => modelGroupCandidateKey(candidate)).join('\u0002')}`)
    .join('\u0003');
  useEffect(() => {
    let cancelled = false;
    const ids = routesKey ? routesKey.split('\u0003').map((entry) => entry.split('\u0001')[0]) : [];
    let settled = false;
    const read = (cachedQuota: boolean) => Promise.all(ids.map((id) => window.electronAPI.modelGroups
      .resolve({ selection: { type: 'route', id }, dryRun: true, ...(cachedQuota ? { cachedQuota: true } : {}) })
      .catch((error: unknown) => { log.warn('model group source quota unavailable', error); return null; })))
      .then((results) => {
        // 手头的读数晚于新读数回来时不盖掉新的。
        if (cancelled || (cachedQuota && settled)) return;
        if (!cachedQuota) settled = true;
        const nextQuota = new Map<string, ModelGroupTraceQuota | null>();
        const nextNames = new Map<string, string>();
        for (const result of results) {
          for (const entry of result?.trace ?? []) {
            const key = modelGroupCandidateKey(entry);
            if (!nextQuota.get(key)) nextQuota.set(key, entry.quota ?? null);
            if (entry.sourceName && !nextNames.has(memberKey(entry))) {
              nextNames.set(memberKey(entry), entry.sourceName);
            }
          }
        }
        // 新读数里读不到的来源，沿用手头那份里有的：不让已经显示的数又消失。
        // 手头读数(cachedQuota)同样合并：改了来源以后，已经显示的百分比不先消失再出现(2026-11-26 排查)。
        setLive((previous) => {
          const mergedQuota = new Map(previous.quota);
          for (const [key, value] of nextQuota) if (value || !mergedQuota.get(key)) mergedQuota.set(key, value);
          const mergedNames = new Map(previous.names);
          for (const [key, value] of nextNames) mergedNames.set(key, value);
          return { quota: mergedQuota, names: mergedNames };
        });
      });
    void read(true);
    void read(false);
    return () => { cancelled = true; };
  }, [routesKey]);
  return live;
}

function leftTone(left: number): string {
  if (left === 0) return 'text-[var(--error-fg)]';
  if (left <= LOW_LEFT_PERCENT) return 'text-[var(--warning-fg)]';
  return 'text-[var(--text-tertiary)]';
}

interface Point { l: number; r: number; y: number }

function MapNodeButton({ node, active, latest, enterDelayMs, onHover, register, providers }: {
  node: MapNode;
  active: boolean;
  /** 最近一次任务实际经过这一格。 */
  latest: boolean;
  /** 入场错开的毫秒数：从左到右一列一列出现。 */
  enterDelayMs: number;
  onHover(id: string | null): void;
  register(id: string, element: HTMLButtonElement | null): void;
  providers: CandidateNames;
}) {
  const names = node.candidate ? providers(node.candidate) : null;
  const icon = node.kind === 'route' && !node.candidate
    ? <Sparkles size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
    : node.candidate
      ? <ProviderMark providerId={node.candidate.providerId} name={names?.provider?.name} routing={names?.provider?.routing}
          logoKind={names?.provider?.logoKind} customIcon={names?.provider?.customIcon}
          colorClass="text-[var(--text-primary)]" withMargin={false} dense />
      : null;
  return (
    <button
      ref={(element) => register(node.id, element)}
      type="button"
      data-model-group-node={node.id}
      data-settings-search-action="Opens the route behind a map node, or highlights the paths reaching a source; changes no setting"
      title={node.name}
      aria-label={node.openLabel ?? node.name}
      onClick={node.open}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      data-latest={latest ? '' : undefined}
      style={{ animationDelay: `${enterDelayMs}ms`, animationFillMode: 'both' }}
      className={cn(
        'animate-fade-in motion-reduce:animate-none',
        'relative z-[1] flex h-9 min-h-8 w-full min-w-0 items-center gap-2 rounded-lg border bg-[var(--settings-theme-card-bg)] px-2.5 text-left text-13 font-medium leading-[1.38] text-[var(--text-primary)] outline-none',
        'transition-[border-color,background-color] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
        'hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        active ? 'border-[var(--text-secondary)]' : latest ? 'border-[var(--text-tertiary)]' : 'border-[var(--settings-theme-card-border)]',
        !node.open && 'cursor-default',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {node.meta && <span className="shrink-0 text-12 font-normal leading-[1.33] text-[var(--text-tertiary)]">{node.meta}</span>}
      {node.left != null && (
        <span className={cn('shrink-0 text-12 font-normal tabular-nums leading-[1.33]', leftTone(node.left))}>{node.left}%</span>
      )}
      {latest && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--text-secondary)]" />}
    </button>
  );
}

function RelationMap({ userRoutes, providerRoutes, decisions, liveQuota, liveNames, onOpenRoute, onOpenSourceRoute, namesOf }: {
  userRoutes: readonly ModelGroupRoute[];
  providerRoutes: readonly ProviderRouteView[];
  decisions: readonly ModelGroupDecision[];
  liveQuota: ReadonlyMap<string, ModelGroupTraceQuota | null>;
  liveNames: ReadonlyMap<string, string>;
  onOpenRoute(id: string): void;
  onOpenSourceRoute?(id: string): void;
  namesOf: CandidateNames;
}) {
  const { t } = useTranslation();

  const { groups, edges, parents } = useMemo(() => {
    const now = Date.now();
    const sources = new Map<string, MapNode>();
    const list: MapEdge[] = [];
    const source = (candidate: CandidateRef) => {
      const key = modelGroupCandidateKey(candidate);
      const id = nodeId('source', key);
      if (!sources.has(key)) {
        const names = namesOf(candidate);
        sources.set(key, { id, kind: 'source', name: `${names.modelName} · ${names.sourceLabel}`, candidate, left: remainingFor(candidate, liveQuota, decisions, now) });
      }
      return id;
    };
    const routes: MapNode[] = userRoutes.map((route) => {
      const id = nodeId('route', route.id);
      for (const candidate of route.candidates) list.push({ from: id, to: source(candidate), off: candidate.off });
      return { id, kind: 'route', name: route.name, open: () => onOpenRoute(route.id), openLabel: t('modelGroups.overview.openRoute', { name: route.name }) };
    });
    // 合并整个供应商的路由：右边一个成员一格。同一个供应商在几条这样的路由里时共用一格。
    const members = new Map<string, MapNode>();
    const providerNodes: MapNode[] = [];
    const parents = new Map<string, string>();
    for (const { route, children } of providerRoutes) {
      const id = nodeId('route', route.id);
      for (const child of children) parents.set(child.id, id);
      const off = new Set(route.sources.filter((item) => item.off).map(memberKey));
      const seen = new Set<string>();
      for (const candidate of children.flatMap((child) => child.candidates)) {
        const key = memberKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!members.has(key)) {
          // 余量取这个成员读到的几份里最紧的一份：有的额度只管某个模型。
          const readings = providerRoutes.flatMap((item) => item.children).flatMap((child) => child.candidates)
            .filter((item) => memberKey(item) === key)
            .map((item) => remainingFor(item, liveQuota, decisions, now))
            .filter((value): value is number => value !== null);
          const fallbackSourceName = liveNames.get(key);
          members.set(key, {
            id: nodeId('source', `provider\u0000${key}`),
            kind: 'source',
            name: namesOf(candidate, fallbackSourceName ? { sourceName: fallbackSourceName } : undefined).sourceLabel,
            candidate,
            provider: true,
            left: readings.length > 0 ? Math.min(...readings) : null,
          });
        }
        list.push({ from: id, to: members.get(key)!.id, off: off.has(key) });
      }
      const first = children.flatMap((child) => child.candidates)[0];
      providerNodes.push({
        // 合并整个供应商的路由用第一个成员的品牌图标，一眼和按模型排的路由分开。
        id, kind: 'route', name: route.name, meta: t('modelGroups.sources.models', { count: children.length }), ...(first ? { candidate: first } : {}),
        ...(onOpenSourceRoute ? { open: () => onOpenSourceRoute(route.id) } : {}),
        openLabel: t('modelGroups.overview.openRoute', { name: route.name }),
      });
    }
    return {
      // 两种都有时各自写明是哪一种；只有一种时左边仍写「路由」。
      groups: [
        { key: 'model', title: providerNodes.length > 0 ? t('modelGroups.kinds.byModel') : t('modelGroups.routes'), routes, sources: withEngineWhenAmbiguous([...sources.values()]) },
        { key: 'provider', title: routes.length > 0 ? t('modelGroups.kinds.byProvider') : t('modelGroups.routes'), routes: providerNodes, sources: [...members.values()] },
      ].filter((group) => group.routes.length > 0),
      edges: list,
      parents,
    };
  }, [userRoutes, providerRoutes, decisions, liveQuota, liveNames, namesOf, onOpenRoute, onOpenSourceRoute, t]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const register = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  }, []);
  const [points, setPoints] = useState<Map<string, Point>>(() => new Map());
  const [hovered, setHovered] = useState<string | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const next = new Map<string, Point>();
    for (const [id, element] of nodeRefs.current) {
      const rect = element.getBoundingClientRect();
      next.set(id, { l: rect.left - box.left, r: rect.right - box.left, y: rect.top - box.top + rect.height / 2 });
    }
    setPoints(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure, groups]);

  const related = useMemo(() => (hovered ? relatedNodes(hovered, edges) : null), [hovered, edges]);
  // 最近一次任务实际走的路：选的路线和最后落到的来源。时段例外改走了别的路线时，选的路线连不到那个来源，不标。
  const latest = useMemo(() => {
    const last = decisions.find((item) => !!decisionCandidate(item));
    const picked = last ? decisionCandidate(last) : null;
    const out = new Set<string>();
    if (!last || !picked) return out;
    // 经合并整个供应商的路由开的任务，记录里记的是它在那个模型上展开出的那一条：标在那条路由和选中的成员上。
    const parent = parents.get(last.groupId);
    const group = parent ?? nodeId(last.groupType, last.groupId);
    const end = parent ? nodeId('source', `provider\u0000${memberKey(picked)}`) : nodeId('source', modelGroupCandidateKey(picked));
    if (edges.some((edge) => edge.from === group && edge.to === end)) {
      out.add(group);
      out.add(end);
    }
    return out;
  }, [decisions, edges, parents]);
  const paths = edges
    .map((edge) => {
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) return null;
      const dx = (b.l - a.r) / 2;
      return {
        key: `${edge.from}>${edge.to}`,
        d: `M${a.r} ${a.y} C${a.r + dx} ${a.y}, ${b.l - dx} ${b.y}, ${b.l} ${b.y}`,
        on: !!related && related.has(edge.from) && related.has(edge.to),
        latest: latest.has(edge.from) && latest.has(edge.to),
        off: edge.off,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
    // 高亮的线最后画，叠在别的线上面。
    .sort((x, y) => (Number(x.on) * 2 + Number(x.latest)) - (Number(y.on) * 2 + Number(y.latest)));

  return (
    <div ref={containerRef} className="relative flex flex-col px-4 pb-4 pt-3" data-testid="model-groups-map">
      {/* 连线跟在格子后面淡入；动的是外层 HTML 元素，不在 SVG 上做动画。 */}
      <div className="pointer-events-none absolute inset-0 animate-fade-in motion-reduce:animate-none" style={{ animationDelay: 'var(--motion-enter)', animationFillMode: 'both' }} aria-hidden>
      <svg className="absolute inset-0 size-full overflow-visible">
        {paths.map((path) => (
          <path
            key={path.key}
            d={path.d}
            fill="none"
            strokeWidth={1}
            strokeDasharray={path.off ? '3 3' : undefined}
            className={cn(
              'transition-[stroke] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
              path.on ? 'stroke-[var(--text-primary)]' : path.latest ? 'stroke-[var(--text-tertiary)]' : 'stroke-[var(--border-default)]',
            )}
          />
        ))}
      </svg>
      </div>
      {groups.map((group, groupIndex) => (
        <div
          key={group.key}
          role="group"
          aria-label={group.title}
          data-model-group-kind={group.key}
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-12',
            groupIndex > 0 && 'mt-4 border-t border-[var(--settings-theme-card-border)] pt-3',
          )}
        >
          {[
            { key: 'routes', title: group.title, nodes: group.routes },
            { key: 'sources', title: t('modelGroups.overview.columnSources'), nodes: group.sources },
          ].map((column, columnIndex) => (
            <div key={column.key} className="flex min-w-0 flex-col gap-2.5">
              <div className="truncate text-12 font-medium leading-[1.33] text-[var(--text-tertiary)]">{column.title}</div>
              <div className="flex flex-1 flex-col justify-center gap-2">
                {column.nodes.map((node, rowIndex) => (
                  <MapNodeButton
                    key={node.id}
                    node={node}
                    active={!!related?.has(node.id)}
                    latest={latest.has(node.id)}
                    enterDelayMs={columnIndex * 70 + rowIndex * 25}
                    onHover={setHovered}
                    register={register}
                    providers={namesOf}
                  />
                ))}
                {column.nodes.length === 0 && (
                  <div className="truncate text-12 leading-[1.33] text-[var(--text-tertiary)]">{t('modelGroups.overview.columnEmpty')}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function RecentDecisions({ decisions, namesOf }: { decisions: readonly ModelGroupDecision[]; namesOf: CandidateNames }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const formatTime = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    const dated = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (at: number) => (sameDay(new Date(at), new Date()) ? time : dated).format(at);
  }, [locale]);

  if (decisions.length === 0) {
    return <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.overview.recentEmpty')}</SettingsBlock>;
  }
  return (
    // 各行共用一套列：时间长短不一(今天只写时刻、更早的写日期)时，模型那一列仍在同一位置对齐。
    <div data-testid="model-groups-recent" className="grid grid-cols-[minmax(0,1fr)_minmax(0,232px)_auto] gap-x-4">
      {decisions.slice(0, RECENT_ROWS).map((item) => {
        const routed = item.outcome === 'routed';
        const picked = decisionCandidate(item);
        // 运行位置的名字按现在的写，与路线里那一行一致；读不到目录时用记录里当时的名字。
        const names = picked ? namesOf(picked, { modelName: item.modelName, sourceName: item.sourceName }) : null;
        const provider = names?.provider;
        const reason = routed
          ? item.why ? modelGroupWhyText({ why: item.why, quota: item.quota ?? null, limitedUntilMs: item.limitedUntilMs }, t, locale) : ''
          : t('modelGroups.overview.keptOriginal');
        const effort = item.effort ? t(`effortLevels.${item.effort}`, { defaultValue: item.effort }) : '';
        // 本机的照旧写记录时的来源名；别的电脑或分享来的连同位置一起写。
        const detail = [item.agentDeviceId ? names?.sourceLabel : item.sourceName, picked ? modelGroupHarnessLabel(picked.agentKind) : null, effort].filter(Boolean).join(' · ');
        return (
          <SettingsBlock
            key={`${item.at}:${item.groupType}:${item.groupId}`}
            data-model-group-decision={item.outcome}
            className="col-span-3 grid grid-cols-subgrid items-center py-3"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-13 font-medium leading-[1.5] text-[var(--settings-section-sublabel)]" title={item.groupName}>{item.groupName}</span>
              {reason && <span className="text-12 leading-[1.4] text-[var(--text-secondary)] [text-wrap:pretty]">{reason}</span>}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {routed && item.providerId ? (
                <>
                  <ProviderMark providerId={item.providerId} name={provider?.name} routing={provider?.routing} logoKind={provider?.logoKind} customIcon={provider?.customIcon}
                    colorClass="text-[var(--text-primary)]" withMargin={false} dense />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-13 leading-[1.5] text-[var(--text-primary)]" title={item.modelName}>{item.modelName ?? names?.modelName ?? item.model}</span>
                    {detail && <span className="truncate text-12 leading-[1.4] text-[var(--text-tertiary)]" title={detail}>{detail}</span>}
                  </div>
                </>
              ) : (
                <span className="truncate text-13 leading-[1.5] text-[var(--text-tertiary)]">{t('modelGroups.overview.keptOriginalShort')}</span>
              )}
            </div>
            <time dateTime={new Date(item.at).toISOString()} className="whitespace-nowrap text-right text-12 tabular-nums leading-[1.33] text-[var(--text-tertiary)]">
              {formatTime(item.at)}
            </time>
          </SettingsBlock>
        );
      })}
    </div>
  );
}

/** 同一个模型经不同引擎各算一个来源：名字相同时补上引擎名，否则两格分不清。 */
function withEngineWhenAmbiguous(nodes: MapNode[]): MapNode[] {
  const seen = new Map<string, number>();
  for (const node of nodes) seen.set(node.name, (seen.get(node.name) ?? 0) + 1);
  return nodes.map((node) => (node.candidate && !node.provider && (seen.get(node.name) ?? 0) > 1
    ? {
        ...node,
        name: `${node.name} · ${
          node.candidate.agentKind === 'acp'
            ? node.candidate.providerId
            : agentOptionOf(node.candidate.agentKind).label
        }`,
      }
    : node));
}

export function ModelGroupsOverview({ config, onOpenRoute, onOpenSourceRoute }: {
  /** 完整的一份：用户按模型排的路由、合并整个供应商的路由(sourceRoutes)和它们展开出的路由(带 parent)。 */
  config: ModelGroupsConfig;
  onOpenRoute(id: string): void;
  onOpenSourceRoute?(id: string): void;
}) {
  const { t } = useTranslation();
  const [decisions, setDecisions] = useState<ModelGroupDecision[] | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const userRoutes = useMemo(() => config.routes.filter((route) => !route.parent), [config]);
  // 隐藏了的不画；一个模型都展开不出来的(成员都没连上)也不画。
  const providerRoutes = useMemo(() => (config.sourceRoutes ?? []).filter((route) => !route.hidden)
    .map((route) => ({ route, children: config.routes.filter((child) => child.parent?.id === route.id && !child.hidden) }))
    .filter((item) => item.children.length > 0), [config]);
  // 关系图与「最近的选择」共用一份名字：本机看本机目录，别的电脑或分享来的看那里的目录并写上位置。
  const candidates = useMemo(() => [
    ...config.routes.flatMap((route) => route.candidates),
    ...(decisions ?? []).flatMap((item) => decisionCandidate(item) ?? []),
  ], [config, decisions]);
  const namesOf = useModelGroupCandidateNames(candidates);
  const probes = useMemo(() => quotaProbes(userRoutes, providerRoutes), [userRoutes, providerRoutes]);
  const live = useLiveSourceQuota(probes);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.modelGroups.decisions()
      .then((list) => { if (!cancelled) setDecisions(Array.isArray(list) ? list : []); })
      .catch((error: unknown) => {
        log.warn('recent model group choices unavailable', error);
        if (!cancelled) setDecisions([]);
      });
    return () => { cancelled = true; };
  }, []);

  if (userRoutes.length === 0 && providerRoutes.length === 0) return null;
  const routed = (decisions ?? []).some((item) => item.outcome === 'routed');
  return (
    <SettingsSection title={t('modelGroups.overview.mapTitle')} description={t('modelGroups.overview.mapDescription')}>
      <SettingsCard>
        <RelationMap userRoutes={userRoutes} providerRoutes={providerRoutes} decisions={decisions ?? []} liveQuota={live.quota} liveNames={live.names}
          onOpenRoute={onOpenRoute} onOpenSourceRoute={onOpenSourceRoute} namesOf={namesOf} />
        {decisions && (
          <>
            {/* 「最近的选择」平时收着(2026-11-25 用户反馈：平时不看，占地方)：这一行既是图上圆点的说明，也是展开它的开关。 */}
            <button
              type="button"
              data-model-groups-recent-toggle
              data-settings-search-action="Shows or hides the recent route choices; changes no setting"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((open) => !open)}
              className={cn(
                'flex min-h-9 w-full items-center gap-1.5 border-t border-[var(--settings-theme-card-border)] px-4 py-2 text-left text-12 leading-[1.33] text-[var(--text-tertiary)] outline-none',
                'transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
                'hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:bg-[var(--surface-hover)] focus-visible:text-[var(--text-secondary)]',
              )}
            >
              {routed && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--text-secondary)]" />}
              <span className="min-w-0 flex-1 truncate">{routed ? t('modelGroups.overview.latest') : ''}</span>
              <span className="shrink-0">{t('modelGroups.overview.recentTitle')}</span>
              <ChevronDown size={14} aria-hidden
                className={cn('shrink-0 transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] motion-reduce:transition-none', recentOpen && 'rotate-180')} />
            </button>
            <Collapse open={recentOpen} className="border-t border-[var(--settings-theme-card-border)]">
              <RecentDecisions decisions={decisions} namesOf={namesOf} />
            </Collapse>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
