/**
 * SessionInfoMeta — 任务行右侧信息槽的内容(sidebar-redesign C / C' 期)。
 * ---------------------------------------------------------------------------
 * 按「任务信息」复选(useTaskInfoFields)拼装,**渲染顺序 = 用户勾选顺序**
 * (2026-08-12 用户裁决,此前是固定的 pr → tokens → cost → time):勾选状态本身
 * 就按先后追加(nextTaskInfoAfterToggle),这里遍历该数组即可。以「·」分隔;
 * 全不选渲染 null(行右侧留空)。
 *
 * 数据口径:
 *   - worktree:Cindy 官方仍登记且目录还在,或本机任务遥测里仍活着的 linked
 *     worktree(可回溯,不只最近 cwd)。Folders + 短名;官方可点开目录,外部只展示。
 *   - pr:session_pr_refs 的最新一条(lastSeenAt 降序首位),显示「状态 icon +
 *     等宽 `#号`」,与会话顶栏 GitContextBadge 的 PrChip 同款(2026-08-12 用户
 *     裁决:仿顶栏,状态颜色只上在 icon 上,`#号` 文字用信息槽常规灰):形状表
 *     PR_STATUS_ICON + 侧栏 open 绿按表面取(prStatusIconColor;浅 `#2EA043` /
 *     深 `#3FB950`);其它三态仍走 PR_STATUS_COLOR。open/draft 且有未解决
 *     review thread 时 icon 右上角打 `--status-bar-accent` 静点。状态未加载 /
 *     no-token / 查询失败时 icon 降级 GitPullRequest + tertiary 灰(号码本地
 *     就有)。文字状态与未解决条数放 hover。
 *   - tokens:session.totalTokenUsage,formatCompactTokens 缩写(1.4M / 320k),
 *     无单位后缀(与费用的货币前缀天然区分);0 视为无数据不显示。
 *   - cost:优先 totalMoney(区域币种 $/¥),回退 legacy totalCostUsd;
 *     两者都为 0 / 缺失(如订阅模式)不显示。
 *   - time:与现状时间槽同一时间轴(activityIso 由调用方传入,SessionItem 用
 *     session.updatedAt,SessionCard 同)。
 *
 * 远程会话:token / 费用字段在远端 DB,device-link 投影可能缺失或为 0——按
 * 「无数据不显示」自然降级,不误显示 0(设计文档 §9.6:第一期仅本机会话有值)。
 *
 * 性能边界(PrRefsContext 显式约束):statuses context 只能由「正在显示 PR 的
 * 小组件」订阅——PrNumberPiece 单独订阅,状态更新只重渲染这些小徽标,不触达
 * 行本体;未勾选 pr / 无 PR 引用的行完全不订阅。状态获取走 fetchStatusesForSession
 * (renderer in-flight 去重 + main 60s TTL),仅在徽标实际挂载时发起——天然
 * 等价于"只查可见行"(列表有 collapse 上限,数量有界)。
 */

import { useEffect, useState } from 'react';
import { Folders, GitPullRequest } from 'lucide-react';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import { useTranslation } from 'react-i18next';

import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { Tip } from '@/components/ui/tooltip';
import { usePrActions, usePrStatus } from '@/contexts/PrRefsContext';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import type { SessionPrRef } from '@/lib/gitContext.types';
import { createLogger } from '@/lib/logger';
import { formatMoney, formatUsd } from '@/lib/usageFormat';
import { prStatusKey } from '@/lib/prStatus';
import {
  PR_STATUS_ICON,
  hslTripletLightness,
  prIconSurface,
  prStatusIconColor,
  shouldShowPrUnresolvedDot,
} from '../gitContextPrVisuals';
import { formatSidebarTime, formatSidebarTimeAbsolute } from '../lib/formatSidebarTime';
import type { TaskInfoField } from '../hooks/useTaskInfoFields';
import type { SessionWorktreeInfo } from './sessionWorktreeInfo';
import type { SdkCostPresentation } from '../../../../shared/regionalMoney';
import { useSidebarSessionUsageMoney } from './sidebarSessionUsageStore';

const log = createLogger('SessionInfoMeta');

type TFunc = (key: string, options?: Record<string, unknown>) => string;

export interface SessionInfoPiece {
  key: TaskInfoField;
  text: string;
  /** hover 提示(绝对时间 / 字段说明)。 */
  title?: string;
  /** time 片段:渲染成语义化 <time dateTime>(与旧时间槽一致)。 */
  dateTime?: string;
}

/**
 * 按复选拼装该会话应显示的信息片段(pr 由 SessionInfoMeta 单独渲染,不在此列)。
 * **顺序 = 用户勾选顺序**(2026-08-12 用户裁决):fields 数组本身就按勾选先后
 * 追加(见 nextTaskInfoAfterToggle),这里遍历它而不是走固定的 if 序列 ——
 * 先勾时间再勾费用就显示「时间 · 费用」,反过来勾就是「费用 · 时间」。
 * 无数据的项(token 为 0 / 无费用 / 无活动时间)照旧跳过,不占位。
 */
export function buildSessionInfoPieces(
  session: Session,
  fields: readonly TaskInfoField[],
  activityIso: string | undefined,
  t: TFunc,
  /** 该会话是否有 PR 引用;有才为 'pr' 排一个占位(无 PR 的行不占位)。 */
  hasPrRef = false,
  /** 该会话是否有可显示的 worktree;有才为 'worktree' 排一个占位。 */
  hasWorktree = false,
): SessionInfoPiece[] {
  const pieces: SessionInfoPiece[] = [];
  for (const field of fields) {
    if (field === 'tokens') {
      if (session.totalTokenUsage > 0) {
        pieces.push({
          key: 'tokens',
          text: formatCompactTokens(session.totalTokenUsage),
          title: t('ccAgent.sidebar.taskInfoTip.tokens'),
        });
      }
      continue;
    }
    if (field === 'cost') {
      const money = session.totalMoney;
      if (money && money.amount > 0) {
        const reasons = money.estimateReasons ?? [];
        const isSdkEstimate =
          money.kind === 'value-estimate' &&
          reasons.includes('sdk-estimate') &&
          !reasons.includes('reference-price') &&
          !reasons.includes('subscription-value');
        pieces.push({
          key: 'cost',
          text: formatMoney(money),
          title: t(
            isSdkEstimate
              ? 'ccAgent.sidebar.taskInfoTip.sdkEstimate'
              : 'ccAgent.sidebar.taskInfoTip.cost',
          ),
        });
      } else if (session.totalCostUsd > 0) {
        pieces.push({
          key: 'cost',
          text: formatUsd(session.totalCostUsd),
          title: t('ccAgent.sidebar.taskInfoTip.cost'),
        });
      }
      continue;
    }
    if (field === 'time' && activityIso) {
      pieces.push({
        key: 'time',
        text: formatSidebarTime(activityIso, t),
        title: formatSidebarTimeAbsolute(activityIso),
        dateTime: activityIso,
      });
      continue;
    }
    if (field === 'pr' && hasPrRef) {
      // 占位:PR 徽标要单独订阅状态缓存(见 PrNumberPiece),内容由 SessionInfoMeta
      // 渲染时替换。放进 pieces 只为让它参与「按勾选顺序」排列。
      pieces.push({ key: 'pr', text: '' });
      continue;
    }
    if (field === 'worktree' && hasWorktree) {
      pieces.push({ key: 'worktree', text: '' });
    }
  }
  return pieces;
}

export function useProjectedSessionInfoPieces(
  session: Session,
  fields: readonly TaskInfoField[],
  activityIso: string | undefined,
  t: TFunc,
  hasPrRef: boolean,
  hasWorktree: boolean,
  costPresentation: SdkCostPresentation,
  showSdkEstimate: boolean,
): SessionInfoPiece[] {
  // A session can switch providers over its lifetime.  New message rows carry a
  // per-turn provider classification, so always rebuild the cost projection when
  // the field is visible; the current provider is only the fallback for legacy rows.
  const needsMoneyProjection = fields.includes('cost');
  const usage = useSidebarSessionUsageMoney(
    needsMoneyProjection ? session.id : undefined,
    needsMoneyProjection ? (session.totalMoney ?? null) : null,
    needsMoneyProjection ? session.totalCostUsd : null,
    costPresentation,
    showSdkEstimate,
  );
  const projectedSession = needsMoneyProjection
    ? {
        ...session,
        totalMoney: usage.totalMoney ?? undefined,
        totalCostUsd: usage.totalMoney?.currency === 'USD' ? usage.totalMoney.amount : 0,
      }
    : session;
  return buildSessionInfoPieces(
    projectedSession,
    fields,
    activityIso,
    t,
    hasPrRef,
    hasWorktree,
  );
}

/**
 * PR 徽标(C' 期)——单独组件以隔离 statuses 订阅(文件头性能边界)。
 * 挂载即请求状态(fetchStatusesForSession 有去重 + main 60s TTL)。
 * 视觉与顶栏 PrChip 同款:状态 icon(形状 + 颜色双编码)+ 等宽 `#号`;
 * `#号` 文字继承信息槽前景色(active 让位由父级统一处理),状态颜色只上
 * 在 icon 上(open 按所在表面取,见 prStatusIconColor)。状态未加载时 icon
 * 灰色 GitPullRequest 占位;文字状态与未解决条数进 title。
 */
function readSidebarSurfaceLightness(isActive: boolean): number | null {
  if (typeof document === 'undefined') return null;
  const token = isActive ? '--sidebar-item-active' : '--sidebar';
  return hslTripletLightness(getComputedStyle(document.documentElement).getPropertyValue(token));
}

function PrNumberPiece({ prRef, isActive }: { prRef: SessionPrRef; isActive?: boolean }) {
  const { t } = useTranslation();
  const themeIsDark = useIsDarkMode();
  const [backgroundLightness, setBackgroundLightness] = useState(() =>
    readSidebarSurfaceLightness(Boolean(isActive)),
  );
  useEffect(() => {
    const read = () => setBackgroundLightness(readSidebarSurfaceLightness(Boolean(isActive)));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      // data-theme:同模式切社区/导入主题时 class 与 colorScheme 都不动,
      // applyTheme 只改 dataset.theme(2026-08-17 review P1)。
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    return () => observer.disconnect();
  }, [isActive, themeIsDark]);
  // fetch 从恒定的 actions context 拿——经 usePrStatuses 拿会连带订阅整表快照,
  // 徽标就退化回"任一状态变化全体重渲染"。
  const { fetchStatusesForSession } = usePrActions();
  useEffect(() => {
    fetchStatusesForSession(prRef.sessionId);
  }, [fetchStatusesForSession, prRef.sessionId]);
  // 按 key 精准订阅(2026-08-13 review P1):整表快照会让任一 PR 的刷新惊动
  // 全部已挂载徽标;usePrStatus 在本 PR 结果未变时快照引用不变、不重渲染。
  const status = usePrStatus(prStatusKey(prRef));
  const kind = status?.ok ? status.status : null;
  const unresolvedCount = status?.ok ? status.unresolvedCount : null;
  const showDot = shouldShowPrUnresolvedDot(kind, unresolvedCount);
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const color = prStatusIconColor(
    kind,
    prIconSurface({
      themeIsDark,
      isActive: Boolean(isActive),
      backgroundLightness,
    }),
  );
  const baseTitle = kind
    ? `${prRef.owner}/${prRef.repo}#${prRef.prNumber} · ${t(`ccAgent.gitContext.pr.status.${kind}`)}`
    : `${prRef.owner}/${prRef.repo}#${prRef.prNumber}`;
  const title =
    showDot && unresolvedCount
      ? `${baseTitle} · ${t('ccAgent.gitContext.pr.unresolved', { count: unresolvedCount })}`
      : baseTitle;
  return (
    <span className="flex shrink-0 items-center gap-0.5 font-mono" title={title}>
      <span className="relative shrink-0">
        <Icon size={11} strokeWidth={1.75} className="block" style={{ color }} />
        {showDot ? (
          <span
            aria-hidden
            className={cn(
              'absolute rounded-full bg-[var(--status-bar-accent)]',
              isActive
                ? 'shadow-[0_0_0_1.25px_hsl(var(--sidebar-item-active))]'
                : [
                    'shadow-[0_0_0_1.25px_hsl(var(--sidebar))]',
                    'group-hover:shadow-[0_0_0_1.25px_hsl(var(--sidebar-item-hover))]',
                    'group-hover/card:shadow-[0_0_0_1.25px_hsl(var(--sidebar-item-hover))]',
                  ],
            )}
            style={{ width: 5, height: 5, top: -1.5, right: -1.5 }}
          />
        ) : null}
      </span>
      #{prRef.prNumber}
    </span>
  );
}

/**
 * 信息槽内容。tabular-nums 保持数字纵向对齐;分隔点用低对比度,不与正文抢焦点。
 * 调用方负责外层布局(让位动画 / 对齐),本组件只渲染内容。
 * prRef 的位置由 pieces 里的 'pr' 占位决定(= 用户勾选顺序);兼容未传
 * hasPrRef 的旧调用:那时 pieces 里没有占位,PR 仍前置渲染。
 */
function WorktreePiece({ info }: { info: SessionWorktreeInfo }) {
  const { t } = useTranslation();
  const openLabel = t('ccAgent.sidebar.taskInfo.openWorktree');
  const detail = info.branch ? `${info.branch} · ${info.path}` : info.path;
  const icon = <Folders size={11} strokeWidth={1.75} className="block" />;
  if (!info.canReveal) {
    return (
      <Tip text={detail} mono>
        <span className="flex shrink-0 items-center">{icon}</span>
      </Tip>
    );
  }
  return (
    <Tip text={`${openLabel} · ${detail}`} mono>
      <button
        type="button"
        aria-label={openLabel}
        onClick={(event) => {
          event.stopPropagation();
          void window.electronAPI
            .worktreeReveal({ path: info.path })
            .then((result) => {
              if (result && result.ok === false) {
                log.warn('reveal rejected:', result.error?.message ?? 'unknown');
              }
            })
            .catch((err) => {
              log.warn('reveal failed:', err);
            });
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className="flex shrink-0 items-center"
      >
        {icon}
      </button>
    </Tip>
  );
}

export function SessionInfoMeta({
  pieces,
  prRef,
  worktree,
  isActive,
  className,
}: {
  pieces: readonly SessionInfoPiece[];
  /** 勾选了 pr 且该会话有 PR 引用时传入(最新一条);否则 undefined 不占位。 */
  prRef?: SessionPrRef;
  /** 勾选了 worktree 且该会话有 live / 路径形态 worktree 时传入。 */
  worktree?: SessionWorktreeInfo;
  isActive?: boolean;
  className?: string;
}) {
  if (pieces.length === 0 && !prRef && !worktree) return null;
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 truncate text-right text-xs font-medium tabular-nums',
        isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
        className,
      )}
    >
      {/* 顺序完全由 pieces 决定(= 用户勾选顺序);'pr' / 'worktree' 是占位,这里换成徽标。
          兼容旧调用:未把字段排进 pieces 时,仍按老样子前置。 */}
      {prRef && !pieces.some((piece) => piece.key === 'pr') && (
        <PrNumberPiece prRef={prRef} isActive={isActive} />
      )}
      {worktree && !pieces.some((piece) => piece.key === 'worktree') && (
        <WorktreePiece info={worktree} />
      )}
      {pieces.map((piece, index) => (
        <span key={piece.key} className="flex shrink-0 items-center gap-1" title={piece.title}>
          {(index > 0 ||
            (prRef && !pieces.some((p) => p.key === 'pr')) ||
            (worktree && !pieces.some((p) => p.key === 'worktree'))) && (
            <span aria-hidden className="opacity-50">
              ·
            </span>
          )}
          {piece.key === 'pr' ? (
            prRef ? (
              <PrNumberPiece prRef={prRef} isActive={isActive} />
            ) : null
          ) : piece.key === 'worktree' ? (
            worktree ? (
              <WorktreePiece info={worktree} />
            ) : null
          ) : piece.dateTime ? (
            <time dateTime={piece.dateTime}>{piece.text}</time>
          ) : (
            piece.text
          )}
        </span>
      ))}
    </span>
  );
}
