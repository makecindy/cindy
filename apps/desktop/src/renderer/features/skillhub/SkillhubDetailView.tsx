/**
 * SkillhubDetailView — route for /skillhub/{kind}/{global|project}/[hash]/:name.
 *
 * Layout (per prod spec v0.5 F4):
 *   ┌ Top toolbar (h-16) ─────────────────────────────────────────────┐
 *   │ ← Back | name | kind chip | scope chip | path                    │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Files + Usage    │  body markdown                                 │
 *   │ (280px)          │  fill                                          │
 *   └──────────────────┴───────────────────────────────────────────────┘
 *
 * v0.5 covers all three Claude Code customization kinds:
 *   - skill   → folder-based, left aside shows siblings + usage metrics
 *   - command → single .md file, FILES section hidden
 *   - agent   → single .md file, FILES section hidden
 */

import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, AlertTriangle, ArrowLeft, ArrowUp, Bot, CheckCircle, ChevronDown, ChevronRight, Clock3, FileText, Folder, FolderOpen, Globe, type LucideIcon, Package, Pencil, Save, Search, SquareTerminal, Trash2, Upload, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { PlaintextEditor, type PlaintextEditorHandle } from '@/components/markdown/PlaintextEditor';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { useCCSessions } from '@/hooks/useCCSessions';
import { plainTextToTiptapDoc, saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import { createLogger } from '@/lib/logger';
import { buildFence, detectRenderable } from '@/lib/textPreview';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { useMetaColumnResize } from './hooks/useMetaColumnResize';
import { invalidateHash, useSkillFolderHash } from './hooks/useSkillFolderHash';
import {
  clearHistory,
  clearLastEntryId,
  refresh as refreshSkillhub,
  setLastEntryId,
  useSkillhub,
} from './hooks/useSkillhub';
import { triggerIncrementalSync } from './hooks/useSkillSync';
import { type DetailState, deriveDetailActionState, deriveDetailState } from './lib/detailButtons';
import {
  buildLocalSkillRoute,
  findLocalSkillByPath,
  findLocalSkillRouteEntry,
} from './lib/localRoutes';
import { isMarketDeleted as checkMarketDeleted, getCachedInfo, invalidate as invalidateInfo, refreshInfo } from './lib/infoDedupe';
import {
  activePublishedReviewFromVersions,
  activePublishedReviewVersion,
  effectivePublishedStatus,
  isEffectiveActivePublishedReview,
  latestRejectedVersionFromVersions,
  publishedStatusLabelKey,
  rejectedPublishedReviewFromVersions,
} from './lib/publishedStatus';
import { isPassingScanStatus } from './lib/scanStatus';
import {
  beginUsageSummaryRequest,
  buildUsageSummaryRequest,
  type SkillUsagePanelState,
  settleUsageSummaryFailure,
  settleUsageSummarySuccess,
} from './lib/skillUsageState';
import { buildRecentTrendRows, formatLocalDayKey } from './lib/skillUsageTrend';
import { type SkillUsageVersionComparison, selectSkillUsageVersionComparison } from './lib/skillUsageViewModel';
import { PublishDialog, type ScanResultPayload } from './PublishDialog';
import { ScanResultDialog } from './ScanResultDialog';
import { useSkillhubIdentityPolicy } from './hooks/useSkillhubIdentityPolicy';
import { SkillhubDiffPanel } from './SkillhubDiffPanel';

const log = createLogger('SkillhubDetailView');

// In-app .md edit support: only files this regex matches are eligible for
// the WYSIWYG editor. Non-md files surface a tooltip on the disabled
// button instead. Case-insensitive to match readSkillContent's gate.
const MD_EXTENSION_RE = /\.md$/i;

// 内容缓存被拎到 lib/skillContentCache.ts —— sidebar 点击 cell 时也要
// 走 prefetch 写入这套缓存,避免首访闪「读取内容…」占位帧。
import {
  deleteCachedContent,
  getCachedContent,
  getCachedContentError,
  hasCachedContent,
  setCachedContent as setContentCache,
  setCachedContentError as setContentErrorCache,
} from './lib/skillContentCache';

const KIND_LABEL: Record<SkillhubKind, string> = {
  skill: 'Skill',
  command: 'Cmd',
  agent: 'Agent',
};

// All three kinds use lucide glyphs of similar visual weight (squarish
// outline shapes). SquareTerminal for command keeps the "command" semantic
// while matching the rectangle-y feel of Package / Bot.
const KIND_ICON: Record<SkillhubKind, LucideIcon> = {
  skill: Package,
  command: SquareTerminal,
  agent: Bot,
};

// Compact chip — tuned to sit cleanly to the right of the h2 title (text-lg).
// h-5 + text-11 keeps the visual weight subdued so the title leads.
function KindChip({ kind }: { kind: SkillhubKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 whitespace-nowrap',
        'bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]',
      )}
    >
      <Icon size={11} className="shrink-0 text-[var(--settings-theme-icon)]" />
      {/* relative top-[1px]: optical correction — Inter's cap sits high in
          the line-box at small sizes, so text-only nudge gets it level
          with the icon center without affecting layout. */}
      <span className="relative top-[0.5px] text-11 font-medium leading-none">{KIND_LABEL[kind]}</span>
    </span>
  );
}

function ScopeChip({ scope }: { scope: SkillhubScope }) {
  const { t } = useTranslation();
  const Icon = scope === 'global' ? Globe : FolderOpen;
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 whitespace-nowrap',
        'bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]',
      )}
    >
      <Icon size={11} className="shrink-0 text-[var(--settings-theme-icon)]" />
      <span className="relative top-[0.5px] text-11 font-medium leading-none">
        {scope === 'global' ? t('skillhub.detail.scopeGlobal') : t('skillhub.detail.scopeProject')}
      </span>
    </span>
  );
}

// Joins a directory path with a child name using whatever separator the
// parent already uses. Scanner returns absolutePath in the platform's
// native format (\\ on Windows, / elsewhere), so we mirror that to keep
// the path readable when shown as a tooltip / passed to shell APIs.
function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
}

// Description value with a 6-line collapse + show more / show less toggle.
// Line clamp lives on the inner div so the toggle button always renders
// outside the clamped region. Only kicks in when the value is "tall enough"
// to need clamping — otherwise show-more would look like a no-op.
function ClampedText({ value }: { value: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // scrollHeight > clientHeight means the line-clamp is currently hiding
    // content. Captured on initial mount; if the description rerenders
    // (different entry), the ref re-fires and we re-measure.
    setOverflows(node.scrollHeight - node.clientHeight > 1);
  }, []);
  return (
    <div className="flex flex-col gap-1">
      <div
        ref={measureRef}
        className={cn(
          // No font-mono here — JetBrains Mono lacks CJK glyphs, so
          // Chinese characters fall back to the system sans font and
          // visually drift apart from ASCII fields above (which DO
          // render mono). Stick with Inter so Chinese + ASCII match.
          'whitespace-pre-wrap break-words text-sm leading-[1.5]',
          'text-[var(--msg-assistant-text)]',
          !expanded && 'line-clamp-6',
        )}
      >
        {value}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            'self-start text-xs font-medium',
            'text-[var(--settings-section-desc)] hover:text-[var(--msg-assistant-text)]',
          )}
        >
          {expanded ? t('skillhub.detail.showLess') : t('skillhub.detail.showMore')}
        </button>
      )}
    </div>
  );
}

// Frontmatter 统一贴在正文上方。左栏现在只放使用表现和文件树,避免元信息
// 与正文割裂;空值和解析错误仍内联展示,让用户能区分"没有 frontmatter"
// 和"frontmatter 解析失败"。
function FrontmatterPanel({ entry }: { entry: SkillhubSkill }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
        {t('skillhub.detail.frontmatterTitle')}
      </h3>
      {entry.parseError ? (
        <p className="text-sm text-[var(--cmd-palette-item-meta)]">
          {t('skillhub.detail.frontmatterParseFailed', { error: entry.parseError })}
        </p>
      ) : entry.frontmatter && Object.keys(entry.frontmatter).length > 0 ? (
        <dl className="flex flex-col gap-3">
          {Object.entries(entry.frontmatter).map(([k, v]) => {
            // description gets the clamp-with-show-more treatment; every
            // other field is rendered inline since they're short enough
            // (name, version, category, ...).
            const isLongTextField = k === 'description' && typeof v === 'string';
            return (
              <div key={k} className="flex flex-col gap-1">
                <dt className="text-xs text-[var(--cmd-palette-item-meta)]">{k}</dt>
                <dd>
                  {isLongTextField ? (
                    <ClampedText value={v as string} />
                  ) : (
                    <span className="whitespace-pre-wrap break-words text-sm text-[var(--msg-assistant-text)]">
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.frontmatterEmpty')}</p>
      )}
    </section>
  );
}

interface SkillUsagePanelProps {
  summary: SkillUsageSummary | null;
  loading: boolean;
  error: string | null;
  diagnoseLoading: boolean;
  diagnoseDisabled: boolean;
  todayKey: string;
  onDiagnose: () => void;
}

function SkillUsagePanel({
  summary,
  loading,
  error,
  diagnoseLoading,
  diagnoseDisabled,
  todayKey,
  onDiagnose,
}: SkillUsagePanelProps) {
  const { t, i18n } = useTranslation();
  const formatterLocale = i18n.resolvedLanguage ?? i18n.language;
  const decimalFormatter = useMemo(
    () => new Intl.NumberFormat(formatterLocale, { maximumFractionDigits: 1 }),
    [formatterLocale],
  );
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(formatterLocale, { style: 'percent', maximumFractionDigits: 0 }),
    [formatterLocale],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(formatterLocale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
    [formatterLocale],
  );

  const formatAverage = (value: number) => decimalFormatter.format(value);
  const formatRate = (value: number | null) => (value === null ? t('skillhub.detail.usageNoData') : percentFormatter.format(value));
  const formatDate = (value: number | null) => {
    if (!value) return t('skillhub.detail.usageNever');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('skillhub.detail.usageNever');
    return dateFormatter.format(date);
  };
  const formatByteSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${formatAverage(bytes / 1024)} KB`;
  };
  const formatDocumentSize = (size: SkillUsageDocumentSize) =>
    t('skillhub.detail.usageDocumentSizeValue', {
      size: formatByteSize(size.byteCount),
      tokens: decimalFormatter.format(size.estimatedTokenCount),
    });
  const formatAgentBreakdownTooltip = (title: string, value: string, breakdown: SkillUsageAgentBreakdown) => (
    <SkillUsageTooltipFrame title={title} value={value}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        <SkillUsageTooltipCount
          label={t('skillhub.detail.usageDiagnosisClaude')}
          value={t('skillhub.detail.usageCount', { count: breakdown.claude })}
        />
        <SkillUsageTooltipCount
          label={t('skillhub.detail.usageDiagnosisCodex')}
          value={t('skillhub.detail.usageCount', { count: breakdown.codex })}
        />
      </div>
    </SkillUsageTooltipFrame>
  );
  const formatReadObservation = (observation: SkillUsageReadObservation) => formatRate(observation.shortWindowRereadRate);
  const readObservationTooltip = (observation: SkillUsageReadObservation) => (
    <SkillUsageTooltipFrame
      title={t('skillhub.detail.usageReadObservation')}
      value={formatRate(observation.shortWindowRereadRate)}
    >
      <p>{t('skillhub.detail.usageReadObservationTooltip')}</p>
    </SkillUsageTooltipFrame>
  );
  const formatVersionComparison = (comparison: SkillUsageVersionComparison) => {
    switch (comparison.status) {
      case 'no_current':
        return t('skillhub.detail.usageVersionNoCurrent');
      case 'no_previous':
        return t('skillhub.detail.usageVersionNoPrevious');
      case 'current_low_sample':
        return t('skillhub.detail.usageVersionCurrentLowSample');
      case 'previous_low_sample':
        return t('skillhub.detail.usageVersionPreviousLowSample');
      case 'comparable':
        return t('skillhub.detail.usageVersionComparable');
    }
  };
  const versionComparisonTooltip = (comparison: SkillUsageVersionComparison): ReactNode => {
    const title = t('skillhub.detail.usageVersionComparisonTitle');
    const value = formatVersionComparison(comparison);
    switch (comparison.status) {
      case 'no_current':
        return (
          <SkillUsageTooltipFrame title={title} value={value}>
            <p>{t('skillhub.detail.usageVersionNoCurrentTooltip')}</p>
          </SkillUsageTooltipFrame>
        );
      case 'no_previous':
        return (
          <SkillUsageTooltipFrame title={title} value={value}>
            <p>{t('skillhub.detail.usageVersionNoPreviousTooltip')}</p>
          </SkillUsageTooltipFrame>
        );
      case 'current_low_sample':
        return (
          <SkillUsageTooltipFrame title={title} value={value}>
            <p>{t('skillhub.detail.usageVersionCurrentLowSampleTooltip')}</p>
          </SkillUsageTooltipFrame>
        );
      case 'previous_low_sample':
        return (
          <SkillUsageTooltipFrame title={title} value={value}>
            <p>{t('skillhub.detail.usageVersionPreviousLowSampleTooltip')}</p>
          </SkillUsageTooltipFrame>
        );
      case 'comparable':
        return (
          <SkillUsageTooltipFrame title={title} value={value}>
            <p>{t('skillhub.detail.usageVersionComparableTooltip')}</p>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1 border-t border-[var(--cmd-palette-border)] pt-1.5">
              <span />
              <span className="text-right text-11 opacity-70">
                {t('skillhub.detail.usageVersionMetricCurrent')}
              </span>
              <span className="text-right text-11 opacity-70">
                {t('skillhub.detail.usageVersionMetricPrevious')}
              </span>
              <SkillUsageTooltipMetric
                label={t('skillhub.detail.usageVersionMetricToolCalls')}
                current={formatAverage(comparison.current.averageToolCalls)}
                previous={formatAverage(comparison.previous.averageToolCalls)}
              />
              <SkillUsageTooltipMetric
                label={t('skillhub.detail.usageVersionMetricRepeatedCalls')}
                current={formatAverage(comparison.current.averageRepeatedToolCalls)}
                previous={formatAverage(comparison.previous.averageRepeatedToolCalls)}
              />
              <SkillUsageTooltipMetric
                label={t('skillhub.detail.usageVersionMetricCommandFailureRate')}
                current={formatRate(comparison.current.commandFailureRate)}
                previous={formatRate(comparison.previous.commandFailureRate)}
              />
            </div>
          </SkillUsageTooltipFrame>
        );
    }
  };
  const versionComparison = useMemo(
    () => summary ? selectSkillUsageVersionComparison(summary) : null,
    [summary],
  );
  const trendRows = useMemo(
    () => (summary?.trend.length ? buildRecentTrendRows(summary.trend, todayKey) : []),
    [summary?.trend, todayKey],
  );
  const trendMaxUseCount = Math.max(0, ...trendRows.map((point) => point.useCount));
  const trendActiveDayCount = trendRows.filter((point) => point.useCount > 0).length;
  const trendLast7UseCount = trendRows.slice(-7).reduce((total, point) => total + point.useCount, 0);
  const trendPeakUseCount = trendRows.reduce((max, point) => Math.max(max, point.useCount), 0);
  const trendChartHeight = 48;
  const canDiagnose = !error && !!summary && summary.totalUseCount > 0;

  return (
    <section className="flex flex-col gap-3 border-t border-[var(--cmd-palette-border)] pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
          {t('skillhub.detail.usageTitle')}
        </h3>
        {loading && <Spinner size={13} className="text-[var(--settings-theme-icon)]" />}
      </div>

      {error ? (
        <p className="text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
          {t('skillhub.detail.usageFailed', { message: error })}
        </p>
      ) : loading && !summary ? (
        <p className="text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
          {t('skillhub.detail.usageLoading')}
        </p>
      ) : !summary || summary.totalUseCount === 0 ? (
        <p className="text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
          {t('skillhub.detail.usageEmpty')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <SkillUsageStat
              label={t('skillhub.detail.usageCurrentCount')}
              value={t('skillhub.detail.usageCount', { count: summary.currentDocumentVersionUseCount })}
              tooltip={formatAgentBreakdownTooltip(
                t('skillhub.detail.usageCurrentCount'),
                t('skillhub.detail.usageCount', { count: summary.currentDocumentVersionUseCount }),
                summary.currentDocumentVersion?.agentBreakdown ?? { claude: 0, codex: 0 },
              )}
            />
            <SkillUsageStat
              label={t('skillhub.detail.usageTotalCount')}
              value={t('skillhub.detail.usageCount', { count: summary.totalUseCount })}
              tooltip={formatAgentBreakdownTooltip(
                t('skillhub.detail.usageTotalCount'),
                t('skillhub.detail.usageCount', { count: summary.totalUseCount }),
                summary.agentBreakdown,
              )}
            />
          </div>

          <dl className="flex flex-col rounded-xl border border-[var(--cmd-palette-border)] px-3 py-2 text-xs">
            <SkillUsageFactRow label={t('skillhub.detail.usageLatestSeen')}>
              <span className="block truncate">{formatDate(summary.latestSeenAt)}</span>
            </SkillUsageFactRow>
            {summary.currentDocumentSize && (
              <SkillUsageFactRow label={t('skillhub.detail.usageDocumentSize')}>
                <span className="block truncate">
                  {formatDocumentSize(summary.currentDocumentSize)}
                </span>
              </SkillUsageFactRow>
            )}
            {summary.readObservation.fileReadCount > 0 && (
              <SkillUsageFactRow label={t('skillhub.detail.usageReadObservation')}>
                <Tip
                  text={readObservationTooltip(summary.readObservation)}
                  contentClassName="w-[280px] max-w-[280px] px-3 py-2.5 [word-break:normal]"
                >
                  <button
                    type="button"
                    className="inline-block max-w-full cursor-help truncate rounded-sm bg-transparent p-0 text-right font-medium text-inherit underline decoration-[var(--cmd-palette-item-meta)] decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {formatReadObservation(summary.readObservation)}
                  </button>
                </Tip>
              </SkillUsageFactRow>
            )}
            {versionComparison && versionComparison.status !== 'no_current' && (
              <SkillUsageFactRow label={t('skillhub.detail.usageVersionComparisonTitle')}>
                <Tip
                  text={versionComparisonTooltip(versionComparison)}
                  contentClassName="w-[300px] max-w-[300px] px-3 py-2.5 [word-break:normal]"
                >
                  <button
                    type="button"
                    className="inline-block max-w-full cursor-help truncate rounded-sm bg-transparent p-0 text-right font-medium text-inherit underline decoration-[var(--cmd-palette-item-meta)] decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {formatVersionComparison(versionComparison)}
                  </button>
                </Tip>
              </SkillUsageFactRow>
            )}
          </dl>

          {canDiagnose && (
            <button
              type="button"
              onClick={onDiagnose}
              disabled={diagnoseDisabled || diagnoseLoading}
              className={cn(
                'inline-flex h-8 w-full items-center justify-center gap-2 rounded-full px-2 text-xs font-medium',
                'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
                'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {diagnoseLoading ? (
                <Spinner size={13} />
              ) : (
                <Search size={13} className="shrink-0" />
              )}
              <span className="truncate">
                {diagnoseLoading
                  ? t('skillhub.detail.usageDiagnosisStarting')
                  : t('skillhub.detail.usageDiagnose')}
              </span>
            </button>
          )}

          <div className="flex flex-col gap-2 rounded-xl border border-[var(--cmd-palette-border)] px-3 py-2.5">
            <p className="text-xs font-medium text-[var(--msg-assistant-text)]">
              {t('skillhub.detail.usageTrendTitle')}
            </p>
            {trendRows.length === 0 ? (
              <p className="text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
                {t('skillhub.detail.usageTrendEmpty')}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div
                  role="img"
                  aria-label={t('skillhub.detail.usageTrendChartLabel')}
                  className="flex h-14 items-end gap-[3px] border-b border-[var(--cmd-palette-border)]"
                >
                  {trendRows.map((point) => {
                    const height =
                      point.useCount > 0 && trendMaxUseCount > 0
                        ? Math.max(4, Math.round((point.useCount / trendMaxUseCount) * trendChartHeight))
                        : 0;
                    const countLabel = t('skillhub.detail.usageCount', { count: point.useCount });
                    return (
                      <Tip
                        key={point.day}
                        text={(
                          <div className="grid min-w-[8rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                            <span className="truncate text-11 text-[var(--text-secondary)]">
                              {point.day}
                            </span>
                            <span className="text-xs font-medium text-[var(--text-primary)]">
                              {countLabel}
                            </span>
                          </div>
                        )}
                        contentClassName="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-[var(--text-primary)] shadow-none dark:border-[var(--border-default)] [word-break:normal]"
                        delay={150}
                      >
                        <div
                          className="flex h-full min-w-0 flex-1 items-end"
                        >
                          <div
                            className={cn(
                              'w-full',
                              point.useCount > 0
                                ? 'bg-[var(--msg-assistant-text)]'
                                : 'bg-transparent',
                            )}
                            style={{ height: `${height}px` }}
                          />
                        </div>
                      </Tip>
                    );
                  })}
                </div>
                <div className="flex justify-between text-10 text-[var(--cmd-palette-item-meta)]">
                  <span>{trendRows[0]?.day.slice(5)}</span>
                  <span>{trendRows.at(-1)?.day.slice(5)}</span>
                </div>
                <ul className="sr-only">
                  {trendRows.map((point) => (
                    <li key={point.day}>
                      {point.day}: {t('skillhub.detail.usageCount', { count: point.useCount })}
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-3 gap-2 border-t border-[var(--cmd-palette-border)] pt-2">
                  <SkillUsageMetric
                    label={t('skillhub.detail.usageTrendLast7')}
                    value={t('skillhub.detail.usageCount', { count: trendLast7UseCount })}
                  />
                  <SkillUsageMetric
                    label={t('skillhub.detail.usageTrendPeak')}
                    value={t('skillhub.detail.usageCount', { count: trendPeakUseCount })}
                    align="center"
                  />
                  <SkillUsageMetric
                    label={t('skillhub.detail.usageTrendActiveDays')}
                    value={t('skillhub.detail.usageDayCount', { count: trendActiveDayCount })}
                    align="right"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function useLocalTodayKey(): string {
  const [todayKey, setTodayKey] = useState(() => formatLocalDayKey(new Date()));

  useEffect(() => {
    let timer: number | null = null;
    const scheduleNextDay = () => {
      const now = new Date();
      const nextDay = new Date(now);
      nextDay.setHours(24, 0, 0, 0);
      const delay = Math.max(1_000, nextDay.getTime() - now.getTime() + 1_000);
      timer = window.setTimeout(() => {
        setTodayKey(formatLocalDayKey(new Date()));
        scheduleNextDay();
      }, delay);
    };
    scheduleNextDay();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return todayKey;
}

function SkillUsageStat({ label, value, tooltip }: { label: string; value: string; tooltip?: ReactNode }) {
  const content = (
    <>
      <span className="truncate text-11 leading-4 text-[var(--cmd-palette-item-meta)]">{label}</span>
      <span className="truncate text-base font-medium leading-5 text-[var(--msg-assistant-text)]">{value}</span>
    </>
  );
  if (!tooltip) {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-[var(--settings-btn-secondary-bg)] px-3 py-2.5">
        {content}
      </div>
    );
  }
  return (
    <Tip text={tooltip} contentClassName="w-[220px] max-w-[220px] px-3 py-2.5 [word-break:normal]">
      <button
        type="button"
        className={cn(
          'flex min-w-0 w-full cursor-help flex-col gap-1 rounded-xl bg-[var(--settings-btn-secondary-bg)] px-3 py-2.5 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        {content}
      </button>
    </Tip>
  );
}

function SkillUsageFactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 py-1">
      <dt className="min-w-0 truncate text-[var(--cmd-palette-item-meta)]">{label}</dt>
      <dd className="min-w-0 max-w-[11rem] text-right font-medium text-[var(--msg-assistant-text)]">
        {children}
      </dd>
    </div>
  );
}

function SkillUsageTooltipFrame({ title, value, children }: { title: string; value: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--cmd-palette-border)] pb-1.5">
        <span className="min-w-0 truncate text-11 font-medium uppercase tracking-wide opacity-70">{title}</span>
        <span className="max-w-[9rem] shrink-0 truncate text-right text-xs font-medium">{value}</span>
      </div>
      <div className="flex flex-col gap-1.5 text-xs leading-relaxed opacity-90">
        {children}
      </div>
    </div>
  );
}

function SkillUsageTooltipMetric({ label, current, previous }: { label: string; current: string; previous: string }) {
  return (
    <>
      <span className="min-w-0 truncate opacity-80">{label}</span>
      <span className="text-right font-medium">{current}</span>
      <span className="text-right font-medium">{previous}</span>
    </>
  );
}

function SkillUsageTooltipCount({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="min-w-0 truncate opacity-80">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </>
  );
}

function SkillUsageMetric({ label, value, align = 'left' }: { label: string; value: string; align?: 'left' | 'center' | 'right' }) {
  return (
    <div
      className={cn(
        'min-w-0',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
      )}
    >
      <div className="truncate text-11 text-[var(--cmd-palette-item-meta)]">{label}</div>
      <div className="truncate text-xs font-medium text-[var(--msg-assistant-text)]">{value}</div>
    </div>
  );
}

type DiagnosisAgentKind = 'cc' | 'codex';

interface DiagnosisAgentPickerDialogProps {
  open: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (agentKind: DiagnosisAgentKind) => void;
}

function DiagnosisAgentPickerDialog({
  open,
  loading,
  onOpenChange,
  onSelect,
}: DiagnosisAgentPickerDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!loading) onOpenChange(nextOpen); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-5',
            'shadow-[var(--confirm-shadow)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <Dialog.Title className="text-base font-semibold text-[var(--msg-assistant-text)]">
            {t('skillhub.detail.usageDiagnosisAgentTitle')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-[var(--cmd-palette-item-meta)]">
            {t('skillhub.detail.usageDiagnosisAgentDescription')}
          </Dialog.Description>
          {loading && (
            <div
              role="status"
              className="mt-3 flex items-center gap-2 text-xs text-[var(--cmd-palette-item-meta)]"
            >
              <Spinner size={13} />
              <span>{t('skillhub.detail.usageDiagnosisStarting')}</span>
            </div>
          )}

          <div className="mt-5 grid grid-cols-2 gap-3">
            <DiagnosisAgentOption
              icon={Bot}
              title={t('skillhub.detail.usageDiagnosisClaude')}
              disabled={loading}
              onClick={() => onSelect('cc')}
            />
            <DiagnosisAgentOption
              icon={SquareTerminal}
              title={t('skillhub.detail.usageDiagnosisCodex')}
              disabled={loading}
              onClick={() => onSelect('codex')}
            />
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={loading}
              onClick={() => onOpenChange(false)}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-sm',
                'border-[var(--cmd-palette-border)] bg-[var(--settings-btn-secondary-bg)]',
                'text-[var(--msg-assistant-text)] hover:bg-[var(--surface-hover)]',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {t('skillhub.detail.usageDiagnosisCancel')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DiagnosisAgentOption({
  icon: Icon,
  title,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-[84px] flex-col items-start justify-between gap-2 rounded-xl border p-3 text-left',
        'border-[var(--cmd-palette-border)] bg-[var(--surface-elevated)]',
        'hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]">
        <Icon size={16} />
      </span>
      <span className="text-sm font-medium text-[var(--msg-assistant-text)]">{title}</span>
    </button>
  );
}

// One row in the FILES tree. Files swap the right pane to their own
// content on click (markdown rendered, anything else wrapped in a code
// fence). Folders toggle expansion + lazy-load children on first open.
// Caret column is reserved on every row so file names line up under
// folder names.
interface FileTreeRowProps {
  entry: SkillhubFileEntry;
  parentDir: string;
  depth: number;
  /** Absolute path of the file currently shown in the right pane — used to
      highlight the matching row. */
  currentPath: string | null;
  onSelectFile: (filePath: string) => void;
}
function FileTreeRow({ entry, parentDir, depth, currentPath, onSelectFile }: FileTreeRowProps) {
  const { t } = useTranslation();
  const fullPath = joinPath(parentDir, entry.name);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<SkillhubFileEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = async () => {
    if (children !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await window.electronAPI.skillhub.listChildren({ dirPath: fullPath });
      if (res.success) setChildren(res.entries ?? []);
      else setLoadError(res.error ?? t('skillhub.detail.fileTreeReadError'));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const onRowClick = () => {
    if (entry.kind === 'dir') {
      void loadChildren();
      setExpanded((e) => !e);
    } else {
      onSelectFile(fullPath);
    }
  };

  const Caret = expanded ? ChevronDown : ChevronRight;
  const TypeIcon = entry.kind === 'dir' ? (expanded ? FolderOpen : Folder) : FileText;
  const isSelected = entry.kind !== 'dir' && currentPath === fullPath;

  return (
    <>
      <button
        type="button"
        onClick={onRowClick}
        style={{ paddingLeft: 4 + depth * 16 }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left',
          'transition-colors',
          isSelected
            ? 'bg-[var(--settings-btn-secondary-bg)]'
            : 'hover:bg-[var(--surface-hover)]',
        )}
        title={fullPath}
      >
        {entry.kind === 'dir' ? (
          <Caret size={13} className="shrink-0 text-[var(--settings-theme-icon)]" />
        ) : (
          <span aria-hidden className="inline-block w-[13px] shrink-0" />
        )}
        <TypeIcon size={13} className="shrink-0 text-[var(--settings-theme-icon)]" />
        <span className={cn(
          'truncate font-mono text-sm',
          isSelected
            ? 'text-[var(--msg-assistant-text)]'
            : 'text-[var(--msg-assistant-text)]',
        )}>
          {entry.name}
          {entry.kind === 'dir' && '/'}
        </span>
      </button>
      {entry.kind === 'dir' && expanded && (
        <>
          {loading && (
            <p
              style={{ paddingLeft: 4 + (depth + 1) * 16 }}
              className="px-1 py-0.5 text-xs text-[var(--cmd-palette-item-meta)]"
            >
              {t('skillhub.detail.fileTreeReading')}
            </p>
          )}
          {loadError && (
            <p
              style={{ paddingLeft: 4 + (depth + 1) * 16 }}
              className="px-1 py-0.5 text-xs text-[var(--cmd-palette-item-meta)]"
            >
              {loadError}
            </p>
          )}
          {children?.length === 0 && !loading && !loadError && (
            <p
              style={{ paddingLeft: 4 + (depth + 1) * 16 }}
              className="px-1 py-0.5 text-xs text-[var(--cmd-palette-item-meta)]"
            >
              {t('skillhub.detail.fileTreeChildEmpty')}
            </p>
          )}
          {children?.map((c) => (
            <FileTreeRow
              key={c.name}
              entry={c}
              parentDir={fullPath}
              depth={depth + 1}
              currentPath={currentPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </>
      )}
    </>
  );
}

export function SkillhubDetailView() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { skills, bootstrapped } = useSkillhub();
  const { createSession } = useCCSessions();
  // 入口来源：market 卡片会带 state.from。详情页返回不走浏览器式历史，
  // 而是退出到 SkillHub 一级页：market 来源回 market，其它入口回 local 欢迎页。
  const navState = location.state as { from?: string; resetHistory?: boolean } | null;
  const fromRoute = navState?.from ?? '/skillhub';
  const backTargetRoute = fromRoute === '/skillhub/market' ? '/skillhub/market' : '/skillhub/local';
  // 兼容旧 sessionStorage 栈：从外部入口进入时先清掉，避免老版本留下的
  // detail 链影响后续返回语义。
  const shouldResetHistory = navState?.resetHistory === true;
  const shouldResetHistoryRef = useRef(shouldResetHistory);
  shouldResetHistoryRef.current = shouldResetHistory;
  const metaResize = useMetaColumnResize();

  const entry = useMemo(() => {
    return findLocalSkillRouteEntry(
      skills,
      params as Record<string, string | undefined>,
      searchParams,
    );
  }, [params, searchParams, skills]);

  // 记录最近访问项供下次打开 SkillHub 时恢复；返回按钮会清掉它，避免用户
  // 主动退出详情页后又被 welcome 自动带回同一条记录。
  useEffect(() => {
    if (!entry) return;
    if (shouldResetHistoryRef.current) clearHistory();
    setLastEntryId(entry.id);
    // shouldResetHistory 故意不进 deps —— 它是入口时刻的一次性信号,后续 entry
    // 切换不应该拿这个旧值再清一次栈。
  }, [entry]);

  // 返回按钮：编辑态只退出编辑；阅读态直接退出详情页到来源页，不回放
  // detail 内部访问历史。
  const goBack = async () => {
    // 编辑态下「返回」语义是退出编辑，不真的离开当前 entry。
    // dirty 时仍要走一次 leave-guard 让用户确认丢弃修改。
    if (editMode) {
      if (dirty) {
        const ok = await confirm({
          title: t('skillhub.detail.discardDialog.title'),
          description: t('skillhub.detail.discardDialog.description'),
          confirmText: t('skillhub.detail.discardDialog.confirm'),
          cancelText: t('skillhub.detail.discardDialog.cancel'),
        });
        if (!ok) return;
      }
      setEditMode(false);
      setDirty(false);
      setSaveError(null);
      return;
    }
    clearLastEntryId();
    clearHistory();
    navigate(backTargetRoute);
  };

  // ── v0.2.1: 4-state detection for kind === 'skill' ────────────────────────
  const isSkill = entry?.kind === 'skill';

  // Publish dialog state (hoisted before onPublishProgress effect so ref can track it)
  const [publishOpen, setPublishOpen] = useState(false);
  // 实时 scan 状态（由 scan-status 事件 / versions 兜底驱动，scan-result 到达时清除）
  const [liveScanStatus, setLiveScanStatus] = useState<{ status: string; version: string } | null>(null);

  // Fetch server info once per entry — infoDedupe 同时承担并发去重 + SWR 缓存。
  // 切 entry 时优先从 getCachedInfo 同步拿上次结果做 seed,后台 useEffect 仍照跑
  // 拉新数据;publish 完成后通过 invalidateInfo + bump infoFetchTrigger 强刷。
  // detailState 完全基于 infoResult 派生(不再用批量 syncResults),保证按钮永远
  // 反映「这个 skill 在服务器上的真实状态」。
  const entryCatalogScope = entry?.registryEntry?.catalogScope;
  const [infoResult, setInfoResult] = useState<SkillhubInfoResult | null>(
    () => (entry?.name ? getCachedInfo(entry.name, entryCatalogScope) : null),
  );
  const [infoLoading, setInfoLoading] = useState(false);
  const [publishTargetInfo, setPublishTargetInfo] = useState<SkillhubInfoResult | null>(
    () => (entry?.name && entryCatalogScope === 'team' ? getCachedInfo(entry.name) : null),
  );
  const [publishTargetLoading, setPublishTargetLoading] = useState(false);
  const [infoFetchTrigger, setInfoFetchTrigger] = useState(0);

  // 同步重置:entry.name 变化时立刻把 infoResult 切到新 name 的缓存值。
  // FadeSwitcher 按 feature 段(/skillhub)聚合 key,同 feature 内切 skill 不重挂,
  // useEffect 在 commit 之后才跑——若不在 render 阶段重置,第一帧会拿
  // 「新 entry + 旧 infoResult」算出错误的 detailState。
  // 关键升级:不再无脑置 null(那会让按钮闪过一次"无版本号 → 有版本号"),
  // 改成同步从 SWR 缓存取上次结果,缓存命中(常见的重访场景)时直接渲染最终态,
  // 完全不闪;缓存 miss(首访)时才退回到 null + loading=true。
  const entryInfoKey = entry?.name ? `${entryCatalogScope ?? 'default'}:${entry.name}` : null;
  const [trackedEntryInfoKey, setTrackedEntryInfoKey] = useState<string | null>(entryInfoKey);
  if (entryInfoKey !== trackedEntryInfoKey) {
    setTrackedEntryInfoKey(entryInfoKey);
    const cached = entry?.name ? getCachedInfo(entry.name, entryCatalogScope) : null;
    setInfoResult(cached);
    setPublishTargetInfo(
      entry?.name && entryCatalogScope === 'team' ? getCachedInfo(entry.name) : null,
    );
    setLiveScanStatus(null);
    // 有缓存就不显示 loading(SWR 后台静默刷),没缓存才进 loading 态
    setInfoLoading(isSkill && entry != null && cached === null);
  }

  const refreshRemoteInfo = useCallback(async (name: string, catalogScope?: StoredInstall['catalogScope']): Promise<{
    info: SkillhubInfoResult | null;
    liveScanStatus: { status: string; version: string } | null;
  }> => {
    const info = await refreshInfo(name, catalogScope);
    if (!info) {
      return { info: null, liveScanStatus: null };
    }
    if (activePublishedReviewVersion(info)) {
      return { info, liveScanStatus: null };
    }
    const directStatus = effectivePublishedStatus(info);
    if (directStatus && directStatus !== 'rejected') {
      return { info, liveScanStatus: null };
    }

    const versionsRes = await window.electronAPI.skillhub.listPublishedVersions(name, catalogScope);
    if (versionsRes.success) {
      const active = activePublishedReviewFromVersions(versionsRes.versions);
      if (active) {
        return { info, liveScanStatus: { status: active.status, version: active.version } };
      }
      const rejected = rejectedPublishedReviewFromVersions(versionsRes.versions, info?.latestVersion);
      if (rejected) {
        return { info, liveScanStatus: { status: rejected.status, version: rejected.version } };
      }
      if (directStatus === 'rejected' && info) {
        return {
          info: {
            ...info,
            moderationStatus: undefined,
            pendingVersion: undefined,
          },
          liveScanStatus: null,
        };
      }
    }
    return { info, liveScanStatus: null };
  }, []);

  const remoteInfoName = isSkill ? (entry?.name ?? null) : null;
  const remoteInfoRequest = useMemo(() => {
    if (!remoteInfoName) return null;
    return { name: remoteInfoName, catalogScope: entryCatalogScope, refreshKey: infoFetchTrigger };
  }, [remoteInfoName, entryCatalogScope, infoFetchTrigger]);

  useEffect(() => {
    if (!remoteInfoRequest) {
      setInfoResult(null);
      setInfoLoading(false);
      return;
    }
    let cancelled = false;
    // SWR:不再清空 infoResult。render 阶段已经 seed 过(缓存命中 → 旧值/缓存值;
    // miss → null),这里只决定要不要显示 loading 态。后台 fetch 拿到新值再 setState。
    const cached = getCachedInfo(remoteInfoRequest.name, remoteInfoRequest.catalogScope);
    if (cached === null) setInfoLoading(true);
    refreshRemoteInfo(remoteInfoRequest.name, remoteInfoRequest.catalogScope)
      .then((result) => {
        if (cancelled) return;
        setLiveScanStatus(result.liveScanStatus);
        setInfoResult(result.info);
      })
      .catch((err) => {
        log.warn(`[DetailView/info] getInfo failed name=${remoteInfoRequest.name}`, err);
      })
      .finally(() => {
        if (!cancelled) setInfoLoading(false);
      });
    return () => { cancelled = true; };
  }, [remoteInfoRequest, refreshRemoteInfo]);

  // 组织目录条目可能来自只读代理，而发布始终写入原生 Hub。用无 scope
  // 详情独立读取写入目标，避免拿组织目录的同名 Skill 判断首发/升级。
  useEffect(() => {
    if (!remoteInfoRequest || remoteInfoRequest.catalogScope !== 'team') {
      setPublishTargetLoading(false);
      return;
    }
    let cancelled = false;
    setPublishTargetLoading(getCachedInfo(remoteInfoRequest.name) === null);
    refreshInfo(remoteInfoRequest.name)
      .then((info) => {
        if (!cancelled) setPublishTargetInfo(info);
      })
      .catch((err) => {
        log.warn(`[DetailView/publish-target] getInfo failed name=${remoteInfoRequest.name}`, err);
      })
      .finally(() => {
        if (!cancelled) setPublishTargetLoading(false);
      });
    return () => { cancelled = true; };
  }, [remoteInfoRequest]);

  // Local folder hash — only meaningful for skill kind.
  // force=true:每次切换 entry 都强制重算,bypass 30s cache,
  // 与下方 getInfo 一起组成"切换 entry 时的原子刷新"。
  const { folderHash: localFolderHash, loading: hashLoading } = useSkillFolderHash(
    isSkill ? (entry?.absolutePath ?? null) : null,
    { force: true },
  );

  // Publish 成功后 main → renderer 推 done 事件,detail 也订阅一次:
  //   1) invalidateInfo + invalidateHash + refreshSkillhub 确保 registryEntry/hash/infoResult 都刷新
  //   2) bump trigger 触发上面的 useEffect 重跑,刷 infoResult
  // 注意: dialog 打开期间不响应 done 事件(defer),否则 infoResult 更新会导致
  // isFirstPublish 翻转,表单布局中途切换。dialog 关闭后再统一刷新。
  const publishOpenRef = useRef(false);
  const previousPublishOpenRef = useRef(publishOpen);
  const deferredDoneRef = useRef(false);
  publishOpenRef.current = publishOpen;
  const publishProgressName = isSkill ? (entry?.name ?? null) : null;
  const publishProgressAbsolutePath = isSkill ? (entry?.absolutePath ?? null) : null;
  const publishProgressTarget = useMemo(() => {
    if (!publishProgressName || !publishProgressAbsolutePath) return null;
    return { name: publishProgressName, absolutePath: publishProgressAbsolutePath };
  }, [publishProgressName, publishProgressAbsolutePath]);
  useEffect(() => {
    if (!publishProgressTarget) return;
    const unsubscribe = window.electronAPI.skillhub.onPublishProgress((event) => {
      if (event.phase === 'done') {
        if (event.name !== publishProgressTarget.name) return;
        if (publishOpenRef.current) {
          deferredDoneRef.current = true;
          return;
        }
        invalidateInfo(publishProgressTarget.name);
        invalidateHash(publishProgressTarget.absolutePath);
        void refreshSkillhub();
        setInfoFetchTrigger((n) => n + 1);
        return;
      }

      if (event.phase === 'scan-status') {
        if (event.name !== publishProgressTarget.name) return;
        setLiveScanStatus({ status: event.status, version: event.version });
        return;
      }

      if (event.phase === 'scan-result') {
        if (event.name !== publishProgressTarget.name) return;
        if (isPassingScanStatus(event.status)) {
          setLiveScanStatus(null);
        } else {
          setLiveScanStatus({ status: event.status, version: event.version });
        }
        invalidateInfo(publishProgressTarget.name);
        invalidateHash(publishProgressTarget.absolutePath);
        void refreshSkillhub();
        void triggerIncrementalSync([event.name]);
        setInfoFetchTrigger((n) => n + 1);
        if (!publishOpenRef.current) {
          setScanResult({ status: event.status, gates: event.gates });
        }
        return;
      }
    });
    return unsubscribe;
  }, [publishProgressTarget]);

  // dialog 关闭后重新查一次当前 skill 远端状态。进入人工审核后不再自动轮询，
  // 用户主动刷新时由常规 info 请求读取最新状态。
  useEffect(() => {
    const wasOpen = previousPublishOpenRef.current;
    previousPublishOpenRef.current = publishOpen;
    if (publishOpen || !wasOpen || !publishProgressTarget) return;
    if (deferredDoneRef.current) {
      deferredDoneRef.current = false;
      invalidateHash(publishProgressTarget.absolutePath);
      void refreshSkillhub();
    }
    invalidateInfo(publishProgressTarget.name);
    setInfoFetchTrigger((n) => n + 1);
  }, [publishOpen, publishProgressTarget]);

  const liveScanSource = liveScanStatus
    ? {
        moderationStatus: liveScanStatus.status,
        latestVersion: liveScanStatus.version,
      }
    : null;
  const effectivePublishInfo = entryCatalogScope === 'team' ? publishTargetInfo : infoResult;
  const effectivePublishLoading = entryCatalogScope === 'team' ? publishTargetLoading : infoLoading;
  const reviewVersion = activePublishedReviewVersion(effectivePublishInfo) ?? activePublishedReviewVersion(liveScanSource);
  const isPublishedReviewing = isEffectiveActivePublishedReview(effectivePublishInfo) || isEffectiveActivePublishedReview(liveScanSource);
  const publishedStatus = effectivePublishedStatus(effectivePublishInfo) ?? effectivePublishedStatus(liveScanSource);
  const publishDialogPendingVersion =
    effectivePublishInfo?.pendingVersion ??
    (reviewVersion && publishedStatus
      ? { version: reviewVersion, status: publishedStatus }
      : null);

  // 按钮区/banner 数据就绪:info 落定 + hash 算完即可,不再依赖批量 sync。
  // 仅 isSkill 场景需要 hash;command/agent 直接视为 ready。
  const hashReady = !isSkill || (!hashLoading && localFolderHash !== null);
  const detailReady = !isSkill || (!infoLoading && !effectivePublishLoading && hashReady);

  // 三维度 detail state
  const marketDeleted = !infoLoading && checkMarketDeleted(entry?.name ?? '', entryCatalogScope);
  const detailState = useMemo<DetailState | null>(() => {
    const state = deriveDetailState(isSkill ? entry : null, infoResult, marketDeleted);
    return state;
  }, [isSkill, entry, infoResult, marketDeleted]);
  const publishTargetDeleted = !effectivePublishLoading
    && checkMarketDeleted(entry?.name ?? '', entryCatalogScope === 'team' ? undefined : entryCatalogScope);
  const publishDetailState = useMemo<DetailState | null>(() => (
    deriveDetailState(isSkill ? entry : null, effectivePublishInfo, publishTargetDeleted)
  ), [isSkill, entry, effectivePublishInfo, publishTargetDeleted]);

  // ── 从 detailState 派生互斥的 UI action state ──
  const registryEntry = entry?.registryEntry ?? null;
  const detailActionState = useMemo(
    () => deriveDetailActionState(
      detailState,
      registryEntry,
      localFolderHash,
      publishedStatus,
      identityPolicy.canWrite,
      publishDetailState,
    ),
    [detailState, registryEntry, localFolderHash, publishedStatus, identityPolicy.canWrite, publishDetailState],
  );
  const detailAction = detailActionState?.status ?? null;
  const isOutdated = detailActionState?.isOutdated ?? false;
  const isMineDirty = detailActionState?.isMineDirty ?? false;
  const showUninstall = detailActionState?.showUninstall ?? false;
  const showForeignDirtyBanner = detailActionState?.showForeignDirtyBanner ?? false;

  const [scanResult, setScanResult] = useState<ScanResultPayload | null>(null);

  // Diff panel state — 点 mine-dirty banner 时打开,看本地跟上次发布版的逐文件 diff
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);

  // ── v0.2.2: in-app .md edit ─────────────────────────────────────────────
  // editMode: false   → read-only MarkdownRenderer
  // editMode: true    → PlaintextEditor swap-in for the right pane
  // dirty: tracks whether the editor's current value differs from initial
  // rawCache: raw .md content (frontmatter intact) — separate from view's
  //           contentCache which strips frontmatter
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Back-button tooltip / aria 文案 —— 反映 goBack 的实际去处。
  // 必须放在 editMode 声明之后,否则触发 TDZ。
  const backLabel = editMode
    ? t('skillhub.detail.back.exitEdit')
    : fromRoute === '/skillhub/market'
      ? t('skillhub.detail.back.market')
      : t('skillhub.detail.back.skillhub');
  const plaintextEditorRef = useRef<PlaintextEditorHandle>(null);
  // Raw initial content the editor was mounted with — used to compare on
  // change for dirty detection AND to reset when leaving edit mode.
  // Holds the raw file content (including frontmatter for Markdown files).
  const initialRawRef = useRef<string>('');
  const { confirm } = useConfirmDialog();

  const openPublish = useCallback(async () => {
    if (entry?.kind !== 'skill' || !identityPolicy.canWrite) return;

    if (isPublishedReviewing) {
      const shouldProceed = await confirm({
        title: t('skillhub.publishDialog.pendingPublishDialog.title'),
        description: t('skillhub.publishDialog.pendingPublishDialog.description'),
        confirmText: t('skillhub.publishDialog.pendingPublishDialog.abandon'),
        cancelText: t('skillhub.publishDialog.pendingPublishDialog.continueInBackground'),
      });
      if (!shouldProceed) return;
    }

    setPublishOpen(true);
  }, [entry, identityPolicy.canWrite, isPublishedReviewing, confirm, t]);

  // installed-from-market 视图的卸载/更新动作。
  // 跟 SkillhubMarketListView 走同一条 IPC，保持后端逻辑唯一。
  const [marketActionRunning, setMarketActionRunning] = useState(false);

  const handleUninstallInstalled = useCallback(async () => {
    if (!entry?.absolutePath) return;
    const ok = await confirm({
      title: t('skillhub.detail.uninstallDialog.title', { name: entry.name }),
      description: t('skillhub.detail.uninstallDialog.description', { path: entry.absolutePath }),
      confirmText: t('skillhub.detail.uninstallDialog.confirm'),
      cancelText: t('skillhub.detail.uninstallDialog.cancel'),
    });
    if (!ok) return;
    setMarketActionRunning(true);
    try {
      const res = await window.electronAPI.skillhub.uninstall(entry.absolutePath);
      if (res.success) {
        toast.success(t('skillhub.detail.uninstalledToast', { name: entry.name }));
        // 卸载后当前 entry 已经不存在,detail view 渲染会失败 → 跳到 local
        // 欢迎页(它会自己 pick 上一次选中的本地技能;若该技能就是刚卸载的,
        // welcome 会清掉 lastEntryId 然后展示空态)。原来跳到 market 不合理 ——
        // 用户从 local 树点进 detail 时不应该被甩到 market。
        clearLastEntryId();
        clearHistory();
        void refreshSkillhub();
        navigate('/skillhub/local');
      } else {
        toast.error(t('skillhub.detail.uninstallFailed', { message: res.message }));
      }
    } finally {
      setMarketActionRunning(false);
    }
  }, [entry, confirm, navigate, t]);

  const handleUpdateInstalled = useCallback(async (
    latestVersion: string,
    options?: { confirmLocalChanges?: boolean },
  ) => {
    if (!entry) return;
    if (options?.confirmLocalChanges) {
      const ok = await confirm({
        title: t('skillhub.detail.updateDirtyDialog.title'),
        description: t('skillhub.detail.updateDirtyDialog.description', { version: latestVersion }),
        confirmText: t('skillhub.detail.updateDirtyDialog.confirm'),
        cancelText: t('skillhub.detail.updateDirtyDialog.cancel'),
      });
      if (!ok) return;
    }
    setMarketActionRunning(true);
    try {
      const res = await window.electronAPI.skillhub.install({
        name: entry.name,
        installPath: entry.absolutePath,
        version: latestVersion,
        catalogScope: entry.registryEntry?.catalogScope,
        // 主动"更新到 vN":完整替换,但保留 Cindy 备份。即使 dirty 判定漏掉,
        // 旧目录也不会在更新成功后被直接删除;替换失败会尽力恢复旧目录。
        force: true,
        skipBackup: false,
      });
      if (res.success) {
        toast.success(t('skillhub.detail.updatedToast', { name: entry.name, version: res.version }));
        // install 已经把磁盘内容整盘替换,但 useSkillFolderHash 的 30s 缓存还
        // 抓着旧 hash 不放——不主动 invalidate,按钮区会用旧 localHash 跟新
        // serverHash 比对,误命中 isMineDirty 分支显示「发布新版本」。
        invalidateHash(entry.absolutePath);
        invalidateInfo(entry.name);
        setInfoFetchTrigger((n) => n + 1);
        void refreshSkillhub();
      } else if (res.errorCode !== 'CANCELLED') {
        toast.error(t('skillhub.detail.updateFailed', { message: res.message }));
      }
    } finally {
      setMarketActionRunning(false);
    }
  }, [entry, confirm, t]);

  // viewingPath: which file's content is shown in the right pane.
  //   - default = entry.mdPath (the SKILL.md / command / agent file)
  //   - clicking a sibling file in the FILES list switches it
  //   - changing entry resets it back to the new entry's mdPath
  const [viewingPath, setViewingPath] = useState<string | null>(entry?.mdPath ?? null);
  useEffect(() => {
    setViewingPath(entry?.mdPath ?? null);
  }, [entry]);

  // liveFiles: 顶层 files 的"现拉"版本。entry.files 来自 useSkillhub 的 scan
  // 快照,scan 之后用户在外部增删 skill 内文件不会反映出来。每次进 detail
  // (或切到不同 skill) 时主动调一次 listChildren 同步当前目录的实际状态,
  // 让 FILES 树跟磁盘对齐。子目录展开本来就走 listChildren,无需处理。
  // null = 还在拉,渲染时 fallback 到 entry.files,避免空白闪烁。
  const [liveFiles, setLiveFiles] = useState<SkillhubFileEntry[] | null>(null);
  const liveFilesRequest = useMemo(() => {
    if (entry?.kind !== 'skill') return null;
    return { id: entry.id, dir: entry.absolutePath };
  }, [entry?.id, entry?.absolutePath, entry?.kind]);
  useEffect(() => {
    if (!liveFilesRequest) {
      setLiveFiles(null);
      return;
    }
    let cancelled = false;
    const dir = liveFilesRequest.dir;
    void window.electronAPI.skillhub.listChildren({ dirPath: dir }).then((res) => {
      if (cancelled) return;
      if (res.success) setLiveFiles(res.entries ?? []);
    });
    return () => { cancelled = true; };
  }, [liveFilesRequest]);

  const [usageRefreshNonce, setUsageRefreshNonce] = useState(0);
  const [diagnosisStarting, setDiagnosisStarting] = useState(false);
  const [diagnosisAgentPickerOpen, setDiagnosisAgentPickerOpen] = useState(false);
  const [usageState, setUsageState] = useState<SkillUsagePanelState>({
    entryId: null,
    loading: false,
    error: null,
    summary: null,
  });
  const usageEntryId = entry?.kind === 'skill' ? entry.id : null;
  const usageSkillName = entry?.kind === 'skill' ? entry.name : null;
  const usageSkillMdPath = entry?.kind === 'skill' ? entry.mdPath : null;
  const usageTodayKey = useLocalTodayKey();
  const usageRequest = useMemo(() => buildUsageSummaryRequest({
    entryId: usageEntryId,
    name: usageSkillName,
    mdPath: usageSkillMdPath,
    refreshNonce: usageRefreshNonce,
    dayKey: usageTodayKey,
  }), [usageEntryId, usageSkillName, usageSkillMdPath, usageRefreshNonce, usageTodayKey]);

  useEffect(() => {
    if (!usageRequest) {
      setUsageState({ entryId: null, loading: false, error: null, summary: null });
      return;
    }

    let cancelled = false;
    const { entryId, name, mdPath } = usageRequest;
    setUsageState((previous) => beginUsageSummaryRequest(previous, entryId));
    void window.electronAPI.skillhub.getUsageSummary({ name, mdPath })
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setUsageState((previous) =>
            settleUsageSummarySuccess(previous, entryId, {
              refreshing: res.refreshing,
              summary: res.summary,
            })
          );
        } else {
          setUsageState((previous) => settleUsageSummaryFailure(previous, entryId, res.error));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setUsageState((previous) =>
          settleUsageSummaryFailure(previous, entryId, err instanceof Error ? err.message : String(err))
        );
      });
    return () => { cancelled = true; };
  }, [usageRequest]);

  useEffect(() => {
    if (!usageEntryId) return;
    return window.electronAPI.skillhub.onUsageAnalyticsRefreshed(() => {
      setUsageRefreshNonce((n) => n + 1);
    });
  }, [usageEntryId]);

  const openDiagnosisAgentPicker = useCallback(() => {
    if (entry?.kind !== 'skill' || diagnosisStarting) return;
    setDiagnosisAgentPickerOpen(true);
  }, [diagnosisStarting, entry?.kind]);

  const handleCreateDiagnosisSession = useCallback(async (agentKind: DiagnosisAgentKind) => {
    if (entry?.kind !== 'skill' || diagnosisStarting) return;
    setDiagnosisStarting(true);
    try {
      const res = await window.electronAPI.skillhub.getUsageDiagnosisContext({
        name: entry.name,
        mdPath: entry.mdPath,
      });
      if (!res.success) {
        toast.error(t('skillhub.detail.usageDiagnosisFailed', { message: res.error }));
        return;
      }

      const prefs = getDraft().lastByVendor[agentKind];
      const newSession = await createSession({
        agentKind,
        workingDir: entry.absolutePath,
        workspaceKind: 'project',
        model: prefs.model,
        effort: prefs.effort,
        permissionMode: prefs.permissionMode,
        fastMode: getFastModeForModel(prefs.model),
      });
      if (!newSession) {
        toast.error(t('skillhub.detail.usageDiagnosisCreateSessionFailed'));
        return;
      }

      saveComposerDraft(newSession.id, {
        text: plainTextToTiptapDoc(res.context.prompt),
        attachments: [],
      });
      setDiagnosisAgentPickerOpen(false);
      navigate(`/cc-agent/${newSession.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t('skillhub.detail.usageDiagnosisFailed', { message }));
    } finally {
      setDiagnosisStarting(false);
    }
  }, [createSession, diagnosisStarting, entry, navigate, t]);

  // Leave-guard wrapper for switching the viewing file. Used by the FILES
  // tree row clicks. If editing with unsaved changes, prompt; otherwise
  // pass through. Shared with the back-button handler.
  const requestLeaveEditMode = useCallback(async (): Promise<boolean> => {
    if (!editMode || !dirty) return true;
    const ok = await confirm({
      title: t('skillhub.detail.discardDialog.title'),
      description: t('skillhub.detail.discardDialog.description'),
      confirmText: t('skillhub.detail.discardDialog.confirm'),
      cancelText: t('skillhub.detail.discardDialog.cancel'),
    });
    return ok;
  }, [editMode, dirty, confirm, t]);

  const handleSelectFile = useCallback(async (filePath: string) => {
    const ok = await requestLeaveEditMode();
    if (!ok) return;
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
    setViewingPath(filePath);
  }, [requestLeaveEditMode]);

  // Enter edit mode — pulls the raw .md (frontmatter intact) via the v0.2.2
  // read-raw IPC, then mounts PlaintextEditor. Disabled paths are gated upstream
  // by `editButtonState` so the click handler can assume viewingPath is a
  // valid .md.
  const enterEditMode = useCallback(async () => {
    if (!viewingPath) return;
    setSaveError(null);
    try {
      const res = await window.electronAPI.skillhub.readRaw({ filePath: viewingPath });
      if (!res.success) {
        toast.error(res.error ?? t('skillhub.detail.readFileFailed'));
        return;
      }
      initialRawRef.current = res.content ?? '';
      setEditMode(true);
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [viewingPath, t]);

  // Save the editor's current value back to disk. Re-validates frontmatter
  // (warn-only — doesn't block save), invalidates folderHash to drive the
  // v0.2.1 dirty-state recomputation, then exits edit mode.
  // All files go through PlaintextEditor, so pull the value from
  // plaintextEditorRef regardless of extension. The
  // isMd flag still gates frontmatter cache-strip + validation below
  // (those rules are tied to the FILE TYPE, not the editor used).
  const saveEdit = useCallback(async () => {
    if (!viewingPath || !entry || !plaintextEditorRef.current) return;
    const isMd = MD_EXTENSION_RE.test(viewingPath);
    const next = plaintextEditorRef.current.getValue();
    setSaving(true);
    setSaveError(null);
    try {
      const res = await window.electronAPI.skillhub.writeFile({
        filePath: viewingPath,
        content: next,
      });
      if (!res.success) {
        setSaveError(res.error ?? t('skillhub.detail.saveFailedDefault'));
        return;
      }
      // 不在 renderer 这边自己 strip frontmatter — 之前用 matter(next).content
      // 在浏览器环境下行为不可靠(gray-matter 是 Node lib,Vite 兜底版本跟 main 进程
      // 那份不完全等价),会出现"frontmatter 被当成正文显示"的 bug。
      // 改为直接走 main 进程的同一条读取链路重新拉一次,跟首次进 detail 时的解析逻辑
      // 保持完全一致。
      // 同时调 refresh() 触发 skillhub 整体重扫,把 entry.frontmatter 也刷新,
      // 否则顶部 FRONTMATTER 面板会一直显示旧值。
      deleteCachedContent(viewingPath);
      // Invalidate folderHash so v0.2.1 dirty detection picks up the change.
      invalidateHash(entry.absolutePath);

      const [, readRes] = await Promise.all([
        refreshSkillhub(),
        isMd
          ? window.electronAPI.skillhub.readSkill({ mdPath: viewingPath })
          : window.electronAPI.skillhub.readSiblingFile({ filePath: viewingPath }),
      ]);
      if (readRes.success) {
        const body = readRes.content ?? '';
        setContentCache(viewingPath, body);
        setContent(body);
        setContentError(null);
      } else {
        // 读取失败不阻断保存成功的事实,只把错误显示在 view 模式
        const msg = readRes.error ?? t('skillhub.detail.readFailedAfterSave');
        setContentErrorCache(viewingPath, msg);
        setContent('');
        setContentError(msg);
      }
      // Frontmatter schema warnings — non-blocking, surface as a soft toast
      // so the user notices missing required fields without losing the save.
      // Only meaningful for .md files (others have no frontmatter). 解析+校验
      // 都走 main 进程,避免 renderer 打包 gray-matter (eval 警告 + 浏览器/Node 行为差异)。
      if (isMd) {
        const kind = viewingPath === entry.mdPath
          ? entry.kind                    // SKILL.md / command.md / agent.md
          : 'sibling';                    // any other .md inside skill folder
        const res = await window.electronAPI.skillhub.validateFrontmatter({ content: next, kind });
        if (res.success && res.issues.length > 0) {
          toast.warning(t('skillhub.detail.savedWithIssuesToast', {
            count: res.issues.length,
            first: res.issues[0].message,
          }));
        } else {
          toast.success(t('skillhub.detail.savedToast'));
        }
      } else {
        toast.success(t('skillhub.detail.savedToast'));
      }
      if (entry.kind === 'skill' && viewingPath === entry.mdPath) {
        setUsageRefreshNonce((n) => n + 1);
      }
      setEditMode(false);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [viewingPath, entry, t]);

  // Cancel — leave guard prompts on dirty, then drops back to view mode.
  const cancelEdit = useCallback(async () => {
    const ok = await requestLeaveEditMode();
    if (!ok) return;
    setEditMode(false);
    setDirty(false);
    setSaveError(null);
  }, [requestLeaveEditMode]);

  // Edit-button enable/disable + tooltip text. Kept as a single source of
  // truth so the JSX below can read `state.disabled` / `state.tip` without
  // re-doing the branching.
  const editButtonState = useMemo(() => {
    if (!entry || !viewingPath) {
      return { hidden: true, disabled: true, tip: '' };
    }
    // v0.2.2 only ships skill + command edit. agent stays read-only — the
    // entry won't appear in the sidebar yet, but be defensive.
    if (entry.kind === 'agent') {
      return { hidden: true, disabled: true, tip: '' };
    }
    // 装的别人技能不允许编辑
    if (detailState?.isMine === false && detailState.origin === 'installed') {
      return { hidden: true, disabled: true, tip: '' };
    }
    // outdated:有更新未拉取,编辑会被覆盖
    if (isOutdated) {
      return { hidden: false, disabled: true, tip: t('skillhub.detail.editTipUpdateFirst') };
    }
    const isMd = MD_EXTENSION_RE.test(viewingPath);
    const renderable = detectRenderable(viewingPath);
    if (!isMd && renderable.kind !== 'code' && renderable.kind !== 'text') {
      return { hidden: false, disabled: true, tip: t('skillhub.detail.editTipBinary') };
    }
    return {
      hidden: false,
      disabled: false,
      tip: isMd ? t('skillhub.detail.editTipMarkdown') : t('skillhub.detail.editTipPlaintext'),
    };
  }, [entry, viewingPath, detailState, isOutdated, t]);

  // Body content — fetched lazily per viewingPath. State initializes
  // synchronously from contentCache so re-visiting a previously-loaded
  // file renders without a loading frame.
  const cachedContent = viewingPath ? getCachedContent(viewingPath) : null;
  const cachedError = viewingPath ? getCachedContentError(viewingPath) : null;
  const [content, setContent] = useState<string | null>(cachedContent);
  const [contentError, setContentError] = useState<string | null>(cachedError);
  const [loadingContent, setLoadingContent] = useState(
    cachedContent === null && cachedError === null && viewingPath !== null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!viewingPath) {
      setContent(null);
      setContentError(null);
      setLoadingContent(false);
      return;
    }

    if (hasCachedContent(viewingPath)) {
      setContent(getCachedContent(viewingPath));
      setContentError(getCachedContentError(viewingPath));
      setLoadingContent(false);
      return;
    }

    setLoadingContent(true);
    setContentError(null);
    // Markdown files go through readSkill (frontmatter-stripped); everything
    // else through readSiblingFile (raw text), which the renderer wraps in
    // a code fence below.
    const isMarkdown = viewingPath.toLowerCase().endsWith('.md');
    const promise = isMarkdown
      ? window.electronAPI.skillhub.readSkill({ mdPath: viewingPath })
      : window.electronAPI.skillhub.readSiblingFile({ filePath: viewingPath });

    void promise
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          const body = res.content ?? '';
          setContentCache(viewingPath, body);
          setContent(body);
          setContentError(null);
        } else {
          const msg = res.error ?? t('skillhub.detail.readFailed');
          setContentErrorCache(viewingPath, msg);
          setContent('');
          setContentError(msg);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setContentErrorCache(viewingPath, msg);
        setContent('');
        setContentError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [viewingPath, t]);

  if (!entry) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-sm text-[var(--cmd-palette-item-meta)]">
        {bootstrapped ? (
          <>
            <p>{t('skillhub.detail.notFound')}</p>
            <button
              type="button"
              onClick={() => {
                clearLastEntryId();
                clearHistory();
                navigate('/skillhub');
              }}
              className="text-[var(--msg-assistant-text)] underline-offset-2 hover:underline"
            >
              {t('skillhub.detail.backToSkillhub')}
            </button>
          </>
        ) : (
          <p>{t('skillhub.detail.scanning')}</p>
        )}
      </div>
    );
  }

  // FILES panel only makes sense for kind=skill (folder-based). Commands and
  // agents are single .md files with no siblings to list.
  const showFiles = entry.kind === 'skill';

  // Whether the right pane should render a frontmatter strip above the body.
  // All kinds now stack frontmatter into the right pane (skills used to park
  // it in the left aside, but the aside now shows only the FILES tree —
  // body + frontmatter belong together). When this is false we tighten the
  // right pane's top padding so the body sits flush under the toolbar.
  const showInlineFrontmatter =
    !!entry.parseError ||
    (!!entry.frontmatter && Object.keys(entry.frontmatter).length > 0);

  return (
    <div
      className="flex h-full w-full flex-col motion-safe:animate-[detail-soft-in_220ms_ease-out]"
      style={{
        // 内层 fade — 叠在 MainLayout FadeSwitcher 的 220ms 0→1 之上,
        // 专门软化 detail 数据加载完成那一刻的"硬切"感:
        // FadeSwitcher 让外壳渐入,这里让填入的内容也带一点透明度起步,
        // 两层组合后用户感知到的是"逐渐浮现",不是"啪一下出现"。
        // motion-safe: 尊重 prefers-reduced-motion,无障碍偏好关闭后直接显示。
      }}
    >
      {/* ─── Top toolbar ─────────────────────────────────────────
          Detail Top Bar 规格:
            height: 72  → h-[72px]
            padding: [0,24,0,16] → pl-4 pr-6
            gap: 16 → gap-4
          chips + path 在 72px 高度内对齐,与「编辑 / 发布」按钮 (h-9) 视觉协调。
          mac 上本页不渲染通用 ContentHeader,toolbar 行承担窗口拖拽,行内交互
          元素各自 no-drag(windowDrag.tsx 约定)。 */}
      <div
        className="flex h-[72px] w-full shrink-0 items-center gap-4 border-b border-[var(--cmd-palette-border)] pl-4 pr-6"
        style={WINDOW_DRAG_STYLE}
      >
        <Tip text={backLabel}>
          <button
            type="button"
            onClick={goBack}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full',
              'text-[var(--settings-section-desc)] hover:bg-[var(--surface-hover)]',
            )}
            style={WINDOW_NO_DRAG_STYLE}
            aria-label={backLabel}
          >
            <ArrowLeft size={18} />
          </button>
        </Tip>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-lg font-medium leading-none text-[var(--msg-assistant-text)]">
              {(entry.frontmatter?.displayName as string) || (entry.frontmatter?.name as string) || entry.name}
            </h2>
            <KindChip kind={entry.kind} />
            <ScopeChip scope={entry.scope} />
            {entry.linkedEngines.map(le => {
              const statusKey = le.runtimeStatus === 'discovered'
                ? 'skillhub.common.statusDiscovered'
                : le.runtimeStatus === 'approved'
                  ? 'skillhub.common.statusApproved'
                  : le.runtimeStatus === 'loaded'
                    ? 'skillhub.common.statusLoaded'
                    : le.runtimeStatus === 'failed'
                      ? 'skillhub.common.statusFailed'
                      : le.runtimeStatus === 'unknown'
                        ? 'skillhub.common.statusUnknown'
                        : null;
              return (
                <span
                  key={le.engine}
                  className={cn(
                    'inline-flex h-5 shrink-0 items-center rounded-full px-2 whitespace-nowrap',
                    'bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]',
                  )}
                >
                  <span className="relative top-[0.5px] text-11 font-medium leading-none">
                    {statusKey ? `${le.label} · ${t(statusKey)}` : le.label}
                  </span>
                </span>
              );
            })}
            {publishDetailState?.canManage && publishedStatus === 'rejected' && (
              <Tip text={t('skillhub.detail.rejectedTooltip')}>
                <button
                  type="button"
                  className="inline-flex h-5 shrink-0 items-center text-[var(--error-fg-strong)] hover:opacity-70 transition-opacity"
                  onClick={async () => {
                    if (!entry?.name) return;
                    const res = await window.electronAPI.skillhub.listPublishedVersions(entry.name);
                    if (!res.success || !res.versions) {
                      setScanResult({ status: 'rejected', gates: [] });
                      return;
                    }
                    const rejected = latestRejectedVersionFromVersions(res.versions);
                    if (!rejected) {
                      setScanResult({ status: 'rejected', gates: [] });
                      return;
                    }
                    const item = (res.versions as Array<Record<string, unknown>>).find(
                      (v) => String(v.version ?? '').trim() === rejected.version,
                    );
                    const raw = item?.scanResult;
                    const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
                    const gates = (parsed && typeof parsed === 'object' && Array.isArray((parsed as { gates?: unknown }).gates))
                      ? (parsed as { gates: Array<{ name: string; label?: Record<string, string>; status: string; issues?: unknown[] }> }).gates
                      : [];
                    setScanResult({ status: 'rejected', gates });
                  }}
                >
                  <AlertCircle size={14} />
                </button>
              </Tip>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              // Skill entries are folders → open the folder itself so the
              // user lands inside it. Commands / agents are single .md files
              // → reveal-in-folder so the file gets highlighted in its dir.
              if (entry.kind === 'skill') {
                void window.electronAPI.openPath(entry.absolutePath);
              } else {
                void window.electronAPI.showItemInFolder({ filePath: entry.absolutePath });
              }
            }}
            className={cn(
              // Truncate at the chip row width; the underlying file path is
              // long but the user mostly recognises the tail (filename).
              'block max-w-full truncate text-left font-mono text-xs',
              'text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)] hover:underline',
            )}
            style={WINDOW_NO_DRAG_STYLE}
            title=""
            aria-label={entry.kind === 'skill' ? t('skillhub.detail.openDirAria') : t('skillhub.detail.showInFolderAria')}
          >
            {entry.absolutePath}
          </button>
        </div>

        {/* v0.2.2 edit-mode actions: when editMode is on, show Cancel + Save
            and hide everything else (publish UI / tag) to avoid ambiguity.
            View-mode actions live in the else-branch below. */}
        {editMode ? (
          <div className="flex shrink-0 items-center gap-2" style={WINDOW_NO_DRAG_STYLE}>
            <button
              type="button"
              onClick={() => { void cancelEdit(); }}
              disabled={saving}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2 rounded-full border px-[18px]',
                'text-sm font-medium',
                'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                'hover:bg-[var(--surface-hover)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-colors',
              )}
            >
              <X size={14} className="shrink-0" />
              <span>{t('skillhub.detail.cancel')}</span>
            </button>
            <button
              type="button"
              onClick={() => { void saveEdit(); }}
              disabled={saving || !dirty}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2 rounded-full px-[18px]',
                'text-sm font-medium',
                'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
                'hover:bg-[var(--lightbox-cta-hover)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-colors',
              )}
            >
              <Save size={14} className="shrink-0" />
              <span>{saving ? t('skillhub.detail.saving') : t('skillhub.detail.save')}</span>
            </button>
          </div>
        ) : (isSkill || entry.kind === 'command') && (
          <div className="flex shrink-0 items-center gap-2" style={WINDOW_NO_DRAG_STYLE}>
            {/* command kind:只有 [编辑] 按钮,不参与 publish/install 流程,
                独立分支,不被 isSkill 的 detailReady 节流。 */}
            {entry.kind === 'command' && !editButtonState.hidden && (
              <Tip text={editButtonState.tip}>
                <button
                  type="button"
                  onClick={() => { void enterEditMode(); }}
                  disabled={editButtonState.disabled}
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-2 rounded-full border px-[18px]',
                    'text-sm font-medium',
                    'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                    'hover:bg-[var(--surface-hover)]',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'transition-colors',
                  )}
                >
                  <Pencil size={14} className="shrink-0" />
                  <span>{t('skillhub.detail.edit')}</span>
                </button>
              </Tip>
            )}

            {/* skill 按钮组 — detailAction.status 保证市场状态/动作互斥 */}
            {isSkill && detailState && (
              <>
            {/* D1: 卸载 — origin=installed（市场）或 imported（本地导入） */}
            {showUninstall && (
              <button
                type="button"
                onClick={() => { void handleUninstallInstalled(); }}
                disabled={marketActionRunning}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-2 rounded-full border px-[18px]',
                  'text-sm font-medium',
                  'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                  'hover:bg-[var(--surface-hover)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors',
                )}
              >
                <Trash2 size={14} className="shrink-0" />
                <span>{t('skillhub.detail.uninstall')}</span>
              </button>
            )}
            {/* 编辑入口 */}
            {!editButtonState.hidden && (
              <Tip text={editButtonState.tip}>
                <button
                  type="button"
                  onClick={() => { void enterEditMode(); }}
                  disabled={editButtonState.disabled}
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-2 rounded-full border px-[18px]',
                    'text-sm font-medium',
                    'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                    'hover:bg-[var(--surface-hover)]',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'transition-colors',
                  )}
                >
                  <Pencil size={14} className="shrink-0" />
                  <span>{t('skillhub.detail.edit')}</span>
                </button>
              </Tip>
            )}
            {/* My published skill, local is clean. */}
            {detailAction?.kind === 'published-tag' && (
              isPublishedReviewing && identityPolicy.canWrite ? (
                <button
                  type="button"
                  onClick={openPublish}
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-2 rounded-full border border-transparent px-[18px]',
                    'text-sm font-medium',
                    'bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]',
                    'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                    'transition-colors',
                  )}
                >
                  {publishedStatus === 'pending' ? <Clock3 size={14} /> : <Spinner size={14} />}
                  <span>
                    {publishedStatus
                      ? t(publishedStatusLabelKey(publishedStatus))
                      : t('skillhub.detail.reviewing')}
                  </span>
                </button>
              ) : (
                <span className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-full border px-[14px]',
                  'text-13 text-[var(--cmd-palette-item-meta)]',
                  'border-[var(--confirm-btn-secondary-border)]',
                )}>
                  <CheckCircle size={12} className="shrink-0" />
                  {t('skillhub.detail.tagPublishedV', { version: detailAction.version })}
                </span>
              )
            )}
            {/* Local registry fallback / foreign installed skill. */}
            {detailAction?.kind === 'installed-tag' && (
              <span className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full border px-[14px]',
                'text-13 text-[var(--cmd-palette-item-meta)]',
                'border-[var(--confirm-btn-secondary-border)]',
              )}>
                <CheckCircle size={12} className="shrink-0" />
                {t('skillhub.detail.tagInstalledV', { version: detailAction.version })}
              </span>
            )}

            {/* My published skill has local changes. */}
            {detailAction?.kind === 'publish-new-version' && (
              <>
                {isPublishedReviewing ? (
                  <button
                    type="button"
                    onClick={openPublish}
                    className={cn(
                      'flex h-[35px] shrink-0 items-center gap-2 rounded-full border border-transparent px-[18px]',
                      'text-sm font-medium',
                      'bg-[var(--settings-btn-secondary-bg)] text-[var(--msg-assistant-text)]',
                      'hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                      'transition-colors',
                    )}
                  >
                    {publishedStatus === 'pending' ? <Clock3 size={14} /> : <Spinner size={14} />}
                    <span>
                      {publishedStatus
                        ? t(publishedStatusLabelKey(publishedStatus))
                        : t('skillhub.detail.reviewing')}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openPublish}
                    className={cn(
                      'flex h-[35px] shrink-0 items-center gap-2 rounded-full border border-transparent px-[18px]',
                      'text-sm font-medium',
                      'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
                      'transition-colors',
                    )}
                  >
                    <Upload size={14} className="shrink-0" />
                    <span>{t('skillhub.detail.publishNewVersion')}</span>
                  </button>
                )}
                {isOutdated && detailState.latestVersion !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      const latestVersion = detailState.latestVersion;
                      if (latestVersion) void handleUpdateInstalled(latestVersion, { confirmLocalChanges: true });
                    }}
                    disabled={marketActionRunning}
                    className={cn(
                      'flex h-[35px] shrink-0 items-center gap-2 rounded-full border px-[18px]',
                      'text-sm font-medium',
                      'border-[var(--confirm-btn-secondary-border)] bg-transparent text-[var(--settings-btn-secondary-text)]',
                      'hover:bg-[var(--surface-hover)]',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'transition-colors',
                    )}
                  >
                    <ArrowUp size={14} className="shrink-0" />
                    <span>
                      {marketActionRunning
                        ? t('skillhub.detail.updating')
                        : t('skillhub.detail.updateToVersion', { version: detailState.latestVersion })}
                    </span>
                  </button>
                )}
              </>
            )}

            {/* Server explicitly has no market record; first-publish flow. */}
            {detailAction?.kind === 'publish-to-market' && (
              <button
                type="button"
                onClick={openPublish}
                className={cn(
                  'flex h-[35px] shrink-0 items-center gap-2 rounded-full border border-transparent px-[18px]',
                  'text-sm font-medium',
                  'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
                  'transition-colors',
                )}
              >
                <Upload size={14} className="shrink-0" />
                <span>{t('skillhub.detail.publishToMarket')}</span>
              </button>
            )}

            {/* Server confirms a newer version exists. */}
            {detailAction?.kind === 'update' && (
              <button
                type="button"
                onClick={() => { void handleUpdateInstalled(detailAction.latestVersion); }}
                disabled={marketActionRunning}
                className={cn(
                  'flex h-[35px] shrink-0 items-center gap-2 rounded-full border border-transparent px-[18px]',
                  'text-sm font-medium',
                  'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors',
                )}
              >
                <ArrowUp size={14} className="shrink-0" />
                <span>
                  {marketActionRunning
                    ? t('skillhub.detail.updating')
                    : t('skillhub.detail.updateToVersion', { version: detailAction.latestVersion })}
                </span>
              </button>
            )}
              </>
            )}
          </div>
        )}
      </div>

      {/* v0.2.2: save-error banner — only in edit mode after a failed save.
          Stays put while user retries (doesn't auto-dismiss).
          左缘对齐 sidebar cell (pl-3),右缘对齐 content cell (pr-8) */}
      {editMode && saveError && (
        <div className="shrink-0 pl-3 pr-8 pt-4">
          <div className={cn(
            'flex items-center gap-2.5 rounded-xl px-4 py-3',
            'bg-[var(--settings-btn-secondary-bg)]',
          )}>
            <AlertTriangle size={16} className="shrink-0 text-[var(--settings-section-desc)]" />
            <span className="text-sm font-medium text-[var(--msg-assistant-text)]">
              {t('skillhub.detail.saveFailedBanner', { message: saveError })}
            </span>
          </div>
        </div>
      )}

      {/* State banners — mine-dirty + unregistered-local/name-taken.
          detailState is null until skill+infoResult arrive (detailReady guard). */}
      {!editMode && isSkill && detailReady && detailState && (
        <>
          {/* mine + dirty: local changes not yet published */}
          {isMineDirty && (
            <div className="shrink-0 pl-3 pr-3 pt-4">
              <button
                type="button"
                onClick={() => setDiffPanelOpen(true)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left',
                  'bg-[var(--settings-btn-secondary-bg)]',
                  'hover:bg-[var(--settings-btn-secondary-hover-bg)] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon)]',
                )}
              >
                <AlertTriangle size={16} className="shrink-0 text-[var(--settings-section-desc)]" />
                <span className="flex-1 text-sm font-medium text-[var(--msg-assistant-text)]">
                  {t('skillhub.detail.bannerLocalChanges')}
                </span>
                <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.bannerSeeChanges')}</span>
              </button>
            </div>
          )}
          {/* outdated: 另一台设备发布了新版,本地版本号已落后 */}
          {isOutdated && publishDetailState?.canManage && entry.registryEntry && (
            <div className="shrink-0 pl-3 pr-3 pt-4">
              <button
                type="button"
                onClick={() => setDiffPanelOpen(true)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left',
                  'bg-[var(--settings-btn-secondary-bg)]',
                  'hover:bg-[var(--settings-btn-secondary-hover-bg)] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon)]',
                )}
              >
                <AlertTriangle size={16} className="shrink-0 text-[var(--settings-section-desc)]" />
                <span className="flex-1 text-sm font-medium text-[var(--msg-assistant-text)]">
                  {t('skillhub.detail.bannerOtherDevicePublished', {
                    latest: detailState.latestVersion,
                    current: entry.registryEntry.version,
                  })}
                </span>
                <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.bannerSeeChanges')}</span>
              </button>
            </div>
          )}
          {/* foreign + dirty: installed skill modified locally */}
          {showForeignDirtyBanner && (
            <div className="shrink-0 pl-3 pr-3 pt-4">
              <button
                type="button"
                onClick={() => setDiffPanelOpen(true)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left',
                  'bg-[var(--settings-btn-secondary-bg)]',
                  'hover:bg-[var(--settings-btn-secondary-hover-bg)] transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--settings-theme-icon)]',
                )}
              >
                <AlertTriangle size={16} className="shrink-0 text-[var(--settings-section-desc)]" />
                <span className="flex-1 text-sm font-medium text-[var(--msg-assistant-text)]">
                  {t('skillhub.detail.bannerLocalModified')}
                </span>
                <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.bannerSeeChanges')}</span>
              </button>
            </div>
          )}
          {/* unregistered: name may be taken by someone else */}
          {detailState.origin === null && effectivePublishInfo && !effectivePublishInfo.canManage && (
            <div className="shrink-0 pl-3 pr-3 pt-4">
              <div className={cn(
                'flex items-center gap-2.5 rounded-xl px-4 py-3',
                'bg-[var(--settings-btn-secondary-bg)]',
              )}>
                <AlertTriangle size={16} className="shrink-0 text-[var(--settings-section-desc)]" />
                <span className="text-sm font-medium text-[var(--msg-assistant-text)]">
                  {t('skillhub.detail.bannerNameTaken', { name: entry.name, author: effectivePublishInfo.authorName })}
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── Body ────────────────────────────────────────────────
          Layout depends on kind:
          - skill: classic two-column (meta+files aside + content pane)
          - command / agent: single-pane — frontmatter folds into the top
            of the markdown column, since there are no sibling files to
            list and the meta is small enough to coexist with the body. */}
      <div
        className={cn(
          // relative: 锚点。变更面板(floating 浮卡)挂在本容器内,贴正文区
          // inset 浮出 —— 不再写死 top 像素,顶栏多高都不会错位。
          'relative flex min-h-0 flex-1 w-full',
          showFiles && !editMode && metaResize.isDragging && 'select-none cursor-col-resize',
        )}
      >
        {/* Left aside (Files + Usage) — hidden in edit mode so the
            text editor takes the full main area. Frontmatter stays in the
            same source buffer instead of occupying a separate left column. */}
        {showFiles && !editMode && (
          // 可调宽左栏。Frontmatter 已经移到右侧正文上方;这里保留文件树
          // 和本机使用表现,让用户先定位文件,再看这个 skill 的实际表现。
          // px-3 让文件树文字贴近 resize handle,左栏读起来更像紧凑导航。
          <aside
            className="relative flex h-full shrink-0 select-text flex-col gap-4 overflow-y-auto border-r border-[var(--cmd-palette-border)] px-3 py-4"
            style={{ width: metaResize.width }}
          >
            <section className="flex flex-col gap-1">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
                {t('skillhub.detail.filesTitle')}
              </h3>
              {(() => {
                // 优先用 liveFiles(进 detail 时现拉),没拉到时 fallback 到
                // scan 快照 entry.files,避免短暂空白。
                const files = liveFiles ?? entry.files;
                return files.length > 0 ? (
                // entry.absolutePath is the skill folder; use it as the
                // root parentDir so child paths resolve correctly.
                // gap-[2px] adds a hairline rhythm between rows so the
                // selected/hover backgrounds don't visually merge into
                // a single block.
                <div className="flex flex-col gap-[2px]">
                  {files.map((f) => (
                    <FileTreeRow
                      key={f.name}
                      entry={f}
                      parentDir={entry.absolutePath}
                      depth={0}
                      currentPath={viewingPath}
                      onSelectFile={(p) => { void handleSelectFile(p); }}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.filesEmpty')}</p>
              );
              })()}
            </section>
            <SkillUsagePanel
              summary={usageState.entryId === entry.id ? usageState.summary : null}
              loading={usageState.entryId === entry.id && usageState.loading}
              error={usageState.entryId === entry.id ? usageState.error : null}
              diagnoseLoading={diagnosisStarting}
              diagnoseDisabled={usageState.entryId !== entry.id || usageState.loading}
              todayKey={usageTodayKey}
              onDiagnose={openDiagnosisAgentPicker}
            />

            {/* Resize handle — same pattern as the main sidebar: 4px transparent
                hit area, 1px highlight line on hover, double-click to reset. */}
            <hr
              aria-orientation="vertical"
              aria-valuemin={metaResize.minWidth}
              aria-valuemax={metaResize.maxWidth}
              aria-valuenow={metaResize.width}
              aria-label={t('skillhub.detail.resizeUsageFilesColumn')}
              tabIndex={0}
              className="absolute right-0 top-0 z-10 m-0 h-full w-[4px] cursor-col-resize border-0 bg-transparent p-0 transition-colors hover:bg-[var(--file-chip-bg)] focus-visible:bg-[var(--file-chip-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--settings-theme-icon)]"
              onPointerDown={metaResize.handleDragStart}
              onDoubleClick={metaResize.resetWidth}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  metaResize.resizeByKeyboard(-1, event.shiftKey);
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  metaResize.resizeByKeyboard(1, event.shiftKey);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  metaResize.resetWidth();
                }
              }}
            />
          </aside>
        )}

        {/* Right pane: file content (and the frontmatter strip prepended
            for command / agent kinds). Same `Renderable` three-state
            dispatch as TextLightbox (see lib/textPreview.ts). In edit mode
            the pane drops its padding + scroll handling so PlaintextEditor can
            use its own flex-fill layout and internal scrolling. */}
        <div
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            editMode
              ? 'overflow-hidden'
              : cn(
                  'overflow-y-auto px-8 pb-8',
                  // No inline frontmatter → drop the top padding so a single
                  // .md without frontmatter sits flush against the toolbar
                  // instead of floating below empty space.
                  showInlineFrontmatter || showFiles ? 'pt-8' : 'pt-2',
                ),
          )}
        >
          {/* In single-pane (command / agent) layout the frontmatter strip
              only earns its real estate if it actually has something to
              show — empty frontmatter just becomes wasted vertical space
              + a stray divider above the body. Parse errors still render
              so the user knows why fields are missing. Suppressed in edit
              mode — the raw frontmatter is edited inline with the file. */}
          {!editMode && showInlineFrontmatter && (
            <div className="mb-6 select-text">
              <FrontmatterPanel entry={entry} />
              <hr className="mt-6 border-[var(--cmd-palette-border)]" />
            </div>
          )}
          {editMode && viewingPath ? (
            // All editable text formats share PlaintextEditor; Markdown keeps
            // its frontmatter visible in the same source buffer.
            <PlaintextEditor
              key={viewingPath}
              ref={plaintextEditorRef}
              initialValue={initialRawRef.current}
              // Pass an hljs language alias for code files so the editor
              // uses CodeMirror's code 主题(行号 + 高亮)。detectRenderable
              // returns { kind: 'code', lang } for known extensions; .md
              // and unknown text files get no language → CodeMirror plain 主题
              // (Inter sans,无行号无高亮)。两条路径都走 CodeMirror,搜索
              // overlay decoration 表现一致。
              language={(() => {
                const r = detectRenderable(viewingPath);
                return r.kind === 'code' ? r.lang : undefined;
              })()}
              onChange={(text) => {
                setDirty(text !== initialRawRef.current);
              }}
            />
          ) : loadingContent ? (
            <p className="text-sm text-[var(--cmd-palette-item-meta)]">{t('skillhub.detail.loadingContent')}</p>
          ) : contentError ? (
            <p className="text-sm text-[var(--cmd-palette-item-meta)]">{contentError}</p>
          ) : (() => {
              const renderable = viewingPath ? detectRenderable(viewingPath) : { kind: 'markdown' as const };
              // For skills the absolutePath IS the folder; for commands/agents
              // it's the .md file itself, so its parent dir is the right
              // anchor for relative @mentions inside the markdown.
              const workingDir =
                entry.kind === 'skill'
                  ? entry.absolutePath
                  : entry.absolutePath.replace(/[\\/][^\\/]+$/, '');
              const body = content ?? '';
              if (renderable.kind === 'markdown') {
                // Strip leading blank lines + an orphan `---` separator. Files
                // with broken frontmatter (missing closing `---`, leading
                // whitespace before the opening one) leave that delimiter in
                // the body, where markdown renders it as a stray <hr> at the
                // very top of the pane — a divider with nothing above it to
                // divide from.
                const cleaned = body
                  .replace(/^\s+/, '')
                  .replace(/^---\s*\n/, '');
                // Wrap MarkdownRenderer in the SAME typography envelope
                // that chat (AssistantMessage.tsx) uses — 15px / weight 400
                // / line-height 1.6 / `--msg-assistant-text` color. This
                // ensures headings, paragraphs, lists, etc. inherit the
                // identical base used elsewhere in the app, instead of
                // whatever the right-pane wrapper happens to provide.
                // light + dark both flow through the --msg-* CSS variables
                // defined globally in styles/globals.css.
                return (
                  <div
                    className={cn(
                      'w-full min-w-0',
                      'text-15 font-normal leading-[1.6]',
                      'text-[var(--msg-assistant-text)]',
                    )}
                  >
                    <MarkdownRenderer workingDir={workingDir} content={cleaned} />
                  </div>
                );
              }
              if (renderable.kind === 'code') {
                // Same chat typography envelope as the markdown branch +
                // the chat-bubble code-block chrome stripping (we want
                // the file content to fill the pane, not look like a
                // chat code bubble).
                return (
                  <div className={cn(
                    'w-full min-w-0',
                    'text-15 font-normal leading-[1.6]',
                    'text-[var(--msg-assistant-text)]',
                    '[&_pre]:!my-0 [&_pre]:!rounded-none [&_pre]:!border-0 [&_pre]:!bg-transparent [&_pre]:!p-0',
                    '[&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_pre]:!overflow-x-visible',
                    '[&_code]:!bg-transparent',
                  )}>
                    <MarkdownRenderer
                      workingDir={workingDir}
                      content={buildFence(body, renderable.lang)}
                    />
                  </div>
                );
              }
              // 'text' — unknown extension. No syntax highlight, just a
              // monospace pre block with soft wrapping so log/csv/.txt files
              // don't force horizontal scroll. Font size + leading match
              // the `code` branch's <pre> so toggling between a .py and a
              // .log doesn't reflow the user's visual rhythm.
              return (
                <pre className="select-text whitespace-pre-wrap break-words font-mono text-[length:var(--app-code-font-size)] leading-[1.5] text-[var(--msg-assistant-text)]">
                  {body}
                </pre>
              );
            })()}
        </div>
        {/* Diff panel — 浮层卡片(market 详情浮层同款),锚定在本 body 的
            relative 容器内、贴正文区 inset 浮出,不吃顶栏高度。始终挂载让
            滑入动画生效;切换 entry 时 DetailView 走 FadeSwitcher 整体重挂,
            panel 自然 unmount。 */}
        {isSkill && entry?.absolutePath && (
          <SkillhubDiffPanel
            open={diffPanelOpen}
            onClose={() => setDiffPanelOpen(false)}
            skillName={entry.name}
            absolutePath={entry.absolutePath}
          />
        )}
      </div>

      {/* v0.2.1: PublishDialog — only rendered for skill kind */}
      {isSkill && entry && (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          skill={entry}
          isFirstPublish={!publishDetailState || detailAction?.kind === 'publish-to-market'}
          autoCleanName={
            detailState?.origin === null &&
            !!effectivePublishInfo && !effectivePublishInfo.canManage
          }
          latestVersion={
            publishDetailState?.canManage && publishDetailState.latestVersion !== null
              ? publishDetailState.latestVersion
              : undefined
          }
          latestVersionStatus={publishDetailState?.canManage ? effectivePublishInfo?.moderationStatus : undefined}
          pendingVersion={
            publishDetailState?.canManage
              ? publishDialogPendingVersion
              : undefined
          }
          onLocalRenamed={(newAbsolutePath) => {
            // skill 在本地被改名(目录 + frontmatter)。先清掉 history(旧 entry id 已失效)
            // + 旧 name 的 info 缓存(让新 name 重新查),然后刷新 scanner,
            // 最后导航到新 URL。先 await refresh 才 navigate,确保新 URL 落地时
            // skills 已包含新 entry,免得短暂闪一下"未找到"。
            invalidateInfo(entry.name);
            invalidateHash(newAbsolutePath);
            void refreshSkillhub().then((scannedSkills) => {
              const renamed = findLocalSkillByPath(scannedSkills, newAbsolutePath);
              if (!renamed) return;
              setLastEntryId(renamed.id);
              navigate(buildLocalSkillRoute(renamed), { replace: true });
            });
          }}
          onScanResult={setScanResult}
        />
      )}

      <DiagnosisAgentPickerDialog
        open={diagnosisAgentPickerOpen}
        loading={diagnosisStarting}
        onOpenChange={setDiagnosisAgentPickerOpen}
        onSelect={(agentKind) => { void handleCreateDiagnosisSession(agentKind); }}
      />

      <ScanResultDialog
        open={scanResult !== null}
        onClose={() => setScanResult(null)}
        result={scanResult}
      />
    </div>
  );
}
