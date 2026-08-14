/**
 * SessionInfoMeta — 任务行右侧信息槽的内容(sidebar-redesign C / C' 期)。
 * ---------------------------------------------------------------------------
 * 按「任务信息」复选(useTaskInfoFields)拼装,**渲染顺序 = 用户勾选顺序**
 * (2026-08-12 用户裁决,此前是固定的 pr → tokens → cost → time):勾选状态本身
 * 就按先后追加(nextTaskInfoAfterToggle),这里遍历该数组即可。以「·」分隔;
 * 全不选渲染 null(行右侧留空)。
 *
 * 数据口径:
 *   - pr:session_pr_refs 的最新一条(lastSeenAt 降序首位),显示「状态 icon +
 *     等宽 `#号`」,与会话顶栏 GitContextBadge 的 PrChip 同款(2026-08-12 用户
 *     裁决:仿顶栏,状态颜色只上在 icon 上,`#号` 文字用信息槽常规灰):形状表
 *     PR_STATUS_ICON + 色表 PR_STATUS_COLOR(色弱友好,四态形状不同);状态
 *     未加载 / no-token / 查询失败时 icon 降级 GitPullRequest + tertiary 灰
 *     (号码本地就有)。文字状态放 hover。
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

import { useEffect } from 'react';
import { GitPullRequest } from 'lucide-react';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Session } from '@/lib/ccAgent.types';
import type { SessionPrRef } from '@/lib/gitContext.types';
import { formatMoney, formatUsd } from '@/lib/usageFormat';
import { prStatusKey } from '@/lib/prStatus';
import { usePrActions, usePrStatus } from '@/contexts/PrRefsContext';
import { PR_STATUS_COLOR, PR_STATUS_ICON } from '../gitContextPrVisuals';
import { formatSidebarTime, formatSidebarTimeAbsolute } from '../lib/formatSidebarTime';
import type { TaskInfoField } from '../hooks/useTaskInfoFields';

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
        pieces.push({
          key: 'cost',
          text: formatMoney(money),
          title: t('ccAgent.sidebar.taskInfoTip.cost'),
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
    }
  }
  return pieces;
}

/**
 * PR 徽标(C' 期)——单独组件以隔离 statuses 订阅(文件头性能边界)。
 * 挂载即请求状态(fetchStatusesForSession 有去重 + main 60s TTL)。
 * 视觉与顶栏 PrChip 同款:状态 icon(形状 + 颜色双编码)+ 等宽 `#号`;
 * `#号` 文字继承信息槽前景色(active 让位由父级统一处理),状态颜色只上
 * 在 icon 上。状态未加载时 icon 灰色 GitPullRequest 占位;文字状态进 title。
 */
function PrNumberPiece({ prRef }: { prRef: SessionPrRef }) {
  const { t } = useTranslation();
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
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  const title = kind
    ? `${prRef.owner}/${prRef.repo}#${prRef.prNumber} · ${t(`ccAgent.gitContext.pr.status.${kind}`)}`
    : `${prRef.owner}/${prRef.repo}#${prRef.prNumber}`;
  return (
    <span className="flex shrink-0 items-center gap-0.5 font-mono" title={title}>
      <Icon
        size={11}
        strokeWidth={1.75}
        className="shrink-0"
        style={{ color: kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)' }}
      />
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
export function SessionInfoMeta({
  pieces,
  prRef,
  isActive,
  className,
}: {
  pieces: readonly SessionInfoPiece[];
  /** 勾选了 pr 且该会话有 PR 引用时传入(最新一条);否则 undefined 不占位。 */
  prRef?: SessionPrRef;
  isActive?: boolean;
  className?: string;
}) {
  if (pieces.length === 0 && !prRef) return null;
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 truncate text-right text-xs font-medium tabular-nums',
        isActive ? 'text-sidebar-item-active-foreground' : 'text-sidebar-action-icon',
        className,
      )}
    >
      {/* 顺序完全由 pieces 决定(= 用户勾选顺序);'pr' 是占位,这里换成徽标。
          兼容旧调用:未把 pr 排进 pieces 时(hasPrRef 未传),仍按老样子前置。 */}
      {prRef && !pieces.some((piece) => piece.key === 'pr') && <PrNumberPiece prRef={prRef} />}
      {pieces.map((piece, index) => (
        <span key={piece.key} className="flex shrink-0 items-center gap-1" title={piece.title}>
          {(index > 0 || (prRef && !pieces.some((p) => p.key === 'pr'))) && (
            <span aria-hidden className="opacity-50">
              ·
            </span>
          )}
          {piece.key === 'pr' ? (
            prRef ? (
              <PrNumberPiece prRef={prRef} />
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
