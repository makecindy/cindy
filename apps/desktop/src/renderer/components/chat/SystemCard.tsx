/**
 * SystemCard
 * ---------------------------------------------------------------------------
 * F-CMD: Local-only system information cards for slash commands.
 * Renders /help, /cost, /context, /pwd, /status as styled info panels in the chat stream.
 */

import { useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Layers,
  RefreshCw,
  Target,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import { LearnStatusCard } from '@/features/learn/LearnStatusCard';
import {
  readReviewFailureCode,
  reviewFailureCodeFromLegacyError,
  type ReviewFailureCode,
} from '../../../shared/reviewRun';
import {
  ACTIVITY_ROW_CHEVRON_SLOT_CLASS,
  ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
  ACTIVITY_ROW_HOVER_SURFACE_CLASS,
  ACTIVITY_ROW_RADIUS_CLASS,
} from './activityRowChrome';
import { MarkdownRenderer } from './MarkdownRenderer';

interface SystemCardProps {
  cardType:
    | 'help'
    | 'cost'
    | 'context'
    | 'pwd'
    | 'status'
    | 'compact'
    | 'cmd'
    | 'goal-complete'
    | 'goal-resumed'
    | 'learn'
    | 'review'
    | 'auto-resume'
    | 'auto-resume-pending'
    | 'agent-switch';
  data?: Record<string, unknown>;
  /**
   * 这条自愈记录此刻是否真的在飞（会话有在跑的 turn，且它就是那个 turn 的发起者）。
   * 由 MessageStream 注入，判据见那里的注释。只影响 `auto-resume` 卡。
   */
  autoResumeInFlight?: boolean;
  /** 卡片所在消息流的 sessionId(MessageStream 注入)。learn 卡按它路由 / 判定
   *  归属会话 —— 嵌入式视图(Orca split pane)里 URL 参数是 lead 而非本 pane,
   *  不能用 useParams(Codex review #548)。 */
  sessionId?: string;
  workingDir?: string;
}

const cardClass = cn(
  'w-full rounded-[12px] border',
  'border-[var(--msg-user-border)]',
  'bg-[var(--msg-user-bg)]',
  'px-5 py-4',
  'text-14 leading-[1.6]',
  'text-[var(--msg-user-text)]',
  'select-text',
);

const titleClass = 'text-15 font-semibold mb-2';
const labelClass = 'text-[var(--msg-tool-text)]';
const valueClass = 'font-medium';
const rowClass = 'flex items-baseline justify-between gap-3 py-[2px]';
const descClass = cn(labelClass, 'text-right flex-1');
const codeClass = cn(
  'inline shrink-0 px-[5px] py-[1px] rounded-[4px] font-mono text-13',
  'bg-[var(--status-bar-accent)]/15',
  'text-[var(--status-bar-accent)]',
);

function HelpCard({ data }: { data?: Record<string, unknown> }) {
  const commands = (data?.commands as Array<{ name: string; description?: string; source: string }>) ?? [];
  const desktopCmds = commands.filter((c) => c.source === 'desktop');
  const agentBuiltinCmds = commands.filter((c) => c.source === 'agent-builtin');
  const projectCmds = commands.filter((c) => c.source === 'user' || c.source === 'skill');

  const renderCommandRows = (items: Array<{ name: string; description?: string; source: string }>) => (
    <div className="flex flex-col gap-[2px]">
      {items.map((c) => (
        <div key={c.name} className={rowClass}>
          <span className={codeClass}>/{c.name}</span>
          <span className={descClass}>{c.description ?? ''}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className={cardClass}>
      <div className={titleClass}>Available Commands</div>
      {desktopCmds.length > 0 && renderCommandRows(desktopCmds)}
      {agentBuiltinCmds.length > 0 && (
        <>
          <div className={cn(titleClass, desktopCmds.length > 0 && 'mt-3')}>Built-in Commands</div>
          {renderCommandRows(agentBuiltinCmds)}
        </>
      )}
      {projectCmds.length > 0 && (
        <>
          <div className={cn(titleClass, (desktopCmds.length > 0 || agentBuiltinCmds.length > 0) && 'mt-3')}>Project Commands</div>
          {renderCommandRows(projectCmds)}
        </>
      )}
      {commands.length === 0 && (
        <div className={labelClass}>No commands available.</div>
      )}
    </div>
  );
}

function CostCard({ data }: { data?: Record<string, unknown> }) {
  const tokenUsage = (data?.tokenUsage as number) ?? 0;
  const tokenText = tokenUsage >= 1000 ? `${(tokenUsage / 1000).toFixed(1)}k` : String(tokenUsage);

  return (
    <div className={cardClass}>
      <div className={titleClass}>Session Cost</div>
      <div className="flex flex-col gap-[2px]">
        <div className={rowClass}>
          <span className={labelClass}>Tokens used (this turn)</span>
          <span className={valueClass}>{tokenText}</span>
        </div>
      </div>
    </div>
  );
}

function ContextCard({ data }: { data?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  // null = session not live / unsupported; undefined = still loading
  const rawUsage = data?.usage;
  const usage = rawUsage === undefined || rawUsage === null || isContextUsageData(rawUsage)
    ? rawUsage
    : null;
  const error = typeof data?.error === 'string' ? data.error : '';

  if (usage === undefined) {
    return (
      <div className={cardClass}>
        <div className={titleClass}>{t('chat.systemCard.context.title')}</div>
        <span className={labelClass}>{t('chat.systemCard.context.loading')}</span>
      </div>
    );
  }

  if (usage === null) {
    return (
      <div className={cardClass}>
        <div className={titleClass}>{t('chat.systemCard.context.title')}</div>
        <span className={labelClass}>
          {error || t('chat.systemCard.context.noLiveSession')}
        </span>
      </div>
    );
  }

  const categories = Array.isArray(usage.categories) ? usage.categories : [];
  const mcpTools = Array.isArray(usage.mcpTools) ? usage.mcpTools : [];
  const memoryFiles = Array.isArray(usage.memoryFiles) ? usage.memoryFiles : [];
  const agents = Array.isArray(usage.agents) ? usage.agents : [];
  const skillFrontmatter = Array.isArray(usage.skills?.skillFrontmatter)
    ? usage.skills.skillFrontmatter
    : [];

  const totalTokens = Math.max(0, finiteNumber(usage.totalTokens));
  const rawMaxTokens = Math.max(finiteNumber(usage.rawMaxTokens) || finiteNumber(usage.maxTokens), 0);
  const pct = rawMaxTokens > 0
    ? Math.min(100, Math.max(0, finiteNumber(usage.percentage) || (totalTokens / rawMaxTokens) * 100))
    : 0;
  const visibleCategories = categories.filter((cat) => finiteNumber(cat.tokens) > 0);
  const hasDetails =
    mcpTools.length > 0 ||
    memoryFiles.length > 0 ||
    agents.length > 0 ||
    !!usage.skills ||
    !!usage.slashCommands ||
    !!usage.messageBreakdown ||
    !!usage.apiUsage;
  const toggleDetail = (key: ContextDetailKey) => {
    setExpandedDetails((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const detailRows: ContextDetailRow[] = [
    {
      key: 'mcpTools',
      label: t('chat.systemCard.context.mcpTools'),
      tokens: sumTokens(mcpTools),
      count: String(mcpTools.length),
      content: (
        <ContextDetailSection
          rows={mcpTools.map((tool) => [
            `${tool.serverName}/${tool.name}${tool.isLoaded === false ? ` ${t('chat.systemCard.context.deferred')}` : ''}`,
            tool.tokens,
          ])}
          showZeroRows
        />
      ),
    },
    {
      key: 'memoryFiles',
      label: t('chat.systemCard.context.memoryFiles'),
      tokens: sumTokens(memoryFiles),
      count: String(memoryFiles.length),
      content: (
        <ContextDetailSection
          rows={memoryFiles.map((file) => [
            `${lastPathPart(file.path)} · ${file.type}`,
            file.tokens,
          ])}
          showZeroRows
        />
      ),
    },
    {
      key: 'customAgents',
      label: t('chat.systemCard.context.customAgents'),
      tokens: sumTokens(agents),
      count: String(agents.length),
      content: (
        <ContextDetailSection
          rows={agents.map((agent) => [
            `${agent.agentType} · ${agent.source}`,
            agent.tokens,
          ])}
          showZeroRows
        />
      ),
    },
  ];
  if (usage.skills) {
    detailRows.push({
      key: 'skills',
      label: t('chat.systemCard.context.skills'),
      tokens: finiteNumber(usage.skills.tokens),
      count: `${finiteNumber(usage.skills.includedSkills)} / ${finiteNumber(usage.skills.totalSkills)}`,
      content: (
        <ContextDetailSection
          rows={[
            [
              t('chat.systemCard.context.includedCount', {
                included: usage.skills.includedSkills,
                total: usage.skills.totalSkills,
              }),
              usage.skills.tokens,
            ],
            ...skillFrontmatter.map((skill) => [
              `${skill.name} · ${skill.source}`,
              skill.tokens,
            ] as [string, number]),
          ]}
          showZeroRows
        />
      ),
    });
  }
  if (usage.slashCommands) {
    detailRows.push({
      key: 'slashCommands',
      label: t('chat.systemCard.context.slashCommands'),
      tokens: finiteNumber(usage.slashCommands.tokens),
      count: `${finiteNumber(usage.slashCommands.includedCommands)} / ${finiteNumber(usage.slashCommands.totalCommands)}`,
      content: (
        <ContextDetailSection
          rows={[
            [
              t('chat.systemCard.context.includedCount', {
                included: usage.slashCommands.includedCommands,
                total: usage.slashCommands.totalCommands,
              }),
              usage.slashCommands.tokens,
            ],
          ]}
        />
      ),
    });
  }
  const visibleDetailRows = detailRows.filter((row) => finiteNumber(row.tokens) > 0 || row.count !== '0');

  return (
    <div
      className={cn(
        'w-full rounded-[12px] border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)]',
        'px-3 py-3 text-13 leading-none text-[var(--msg-user-text)] select-text',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('chat.systemCard.context.collapse')
          : t('chat.systemCard.context.expand')}
      >
        <Layers size={14} strokeWidth={1.8} className="shrink-0 text-[var(--msg-user-text)]" />
        <span className="min-w-0 flex-1 truncate text-15 font-medium">
          {t('chat.systemCard.context.title')}
        </span>
        <span className="shrink-0 text-12 font-medium tabular-nums text-[var(--msg-tool-text)]">
          {t('chat.systemCard.context.tokensSummary', {
            used: fmtContextTokens(totalTokens),
            total: fmtContextTokens(rawMaxTokens),
            pct: Math.round(pct),
          })}
        </span>
        <ChevronRight
          size={13}
          strokeWidth={1.8}
          className={cn(
            'shrink-0 text-[var(--msg-tool-text)] transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      <div
        className="mt-2 flex h-[7px] w-full overflow-hidden rounded-full bg-[var(--msg-tool-card-bg)]"
        aria-label={t('chat.systemCard.context.barAria')}
      >
        {visibleCategories.filter((cat) => !cat.isDeferred).map((cat) => (
          <div
            key={cat.name}
            className="h-full shrink-0"
            style={{
              width: `${rawMaxTokens > 0 ? Math.max((cat.tokens / rawMaxTokens) * 100, cat.tokens > 0 ? 0.6 : 0) : 0}%`,
              backgroundColor: contextColor(cat),
              opacity: cat.name === 'Free space' ? 0.24 : 1,
            }}
          />
        ))}
      </div>

      <Collapse open={expanded}>
        <div className="mt-2">
          {usage.model && (
            <div className="mb-2 truncate text-12 leading-[1.3] text-[var(--msg-tool-text)]">
              {t('chat.systemCard.context.model', { model: usage.model })}
            </div>
          )}

          <div className="flex flex-col gap-[5px]">
            {visibleCategories.map((cat) => (
              <div key={cat.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: contextColor(cat),
                      opacity: cat.name === 'Free space' ? 0.28 : 1,
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate text-12 leading-none text-[var(--msg-user-text)]">
                    {localizeContextCategory(t, cat.name)}
                    {cat.isDeferred && (
                      <span className="ml-1 text-12 text-[var(--msg-tool-text)]">
                        {t('chat.systemCard.context.deferred')}
                      </span>
                    )}
                  </span>
                </div>
                <span className="shrink-0 text-12 tabular-nums text-[var(--msg-tool-text)]">
                  {fmtContextTokens(cat.tokens)}
                </span>
                <span className="w-[42px] shrink-0 text-right text-12 tabular-nums text-[var(--msg-user-text)]">
                  {fmtPercent(finiteNumber(cat.tokens), rawMaxTokens)}
                </span>
              </div>
            ))}
          </div>

          {hasDetails && (
            <div className="mt-2 flex flex-col gap-[6px]">
              {visibleDetailRows.map((row) => {
                const isDetailExpanded = !!expandedDetails[row.key];
                return (
                  <div key={row.key}>
                    <button
                      type="button"
                      className={cn(
                        'grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3',
                        'text-left text-12 text-[var(--msg-tool-text)] select-none',
                      )}
                      onClick={() => toggleDetail(row.key)}
                      aria-expanded={isDetailExpanded}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ChevronRight
                          size={11}
                          strokeWidth={1.8}
                          className={cn('shrink-0 transition-transform', isDetailExpanded && 'rotate-90')}
                        />
                        <span className="min-w-0 truncate">{row.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{fmtContextTokens(row.tokens)}</span>
                      <span className="w-[42px] shrink-0 text-right tabular-nums">{row.count}</span>
                    </button>
                    {isDetailExpanded && (
                      <div className="mt-1 pl-[18px]">
                        {row.content}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(usage.messageBreakdown || usage.apiUsage) && (
            <div className="mt-3 space-y-3 border-t border-[var(--msg-tool-card-border)] pt-3">
              {usage.messageBreakdown && (
                <ContextDetailSection
                  title={t('chat.systemCard.context.messageBreakdown')}
                  rows={[
                    [t('chat.systemCard.context.userMessages'), usage.messageBreakdown.userMessageTokens],
                    [t('chat.systemCard.context.assistantMessages'), usage.messageBreakdown.assistantMessageTokens],
                    [t('chat.systemCard.context.toolCalls'), usage.messageBreakdown.toolCallTokens],
                    [t('chat.systemCard.context.toolResults'), usage.messageBreakdown.toolResultTokens],
                    [t('chat.systemCard.context.attachments'), usage.messageBreakdown.attachmentTokens],
                  ]}
                />
              )}
              {usage.apiUsage && (
                <ContextDetailSection
                  title={t('chat.systemCard.context.apiUsage')}
                  rows={[
                    [t('chat.systemCard.context.inputTokens'), usage.apiUsage.input_tokens],
                    [t('chat.systemCard.context.cacheCreate'), usage.apiUsage.cache_creation_input_tokens],
                    [t('chat.systemCard.context.cacheRead'), usage.apiUsage.cache_read_input_tokens],
                    [t('chat.systemCard.context.outputTokens'), usage.apiUsage.output_tokens],
                  ]}
                />
              )}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

type ContextDetailKey = 'mcpTools' | 'memoryFiles' | 'customAgents' | 'skills' | 'slashCommands';

interface ContextDetailRow {
  key: ContextDetailKey;
  label: string;
  tokens: number;
  count: string;
  content: ReactNode;
}

interface ContextUsageData {
  categories: Array<{ name: string; tokens: number; color: string; isDeferred?: boolean }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: Array<Array<{
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }>>;
  model: string;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

function ContextDetailSection({
  title,
  rows,
  showZeroRows = false,
}: {
  title?: string;
  rows: Array<[string, number]>;
  showZeroRows?: boolean;
}) {
  const visibleRows = rows.filter(([, tokens]) => showZeroRows || finiteNumber(tokens) > 0);

  return (
    <div>
      {title && (
        <div className="mb-1 text-12 font-medium text-[var(--msg-user-text)]">{title}</div>
      )}
      <div className="flex flex-col gap-[2px]">
        {visibleRows.map(([label, tokens]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-12">
            <span className="min-w-0 flex-1 truncate text-[var(--msg-tool-text)]">{label}</span>
            <span className="shrink-0 font-medium tabular-nums text-[var(--msg-tool-text)]">
              {fmtContextTokens(tokens)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function contextColor(category: { name: string; color?: string }): string {
  const categoryName = category.name;
  if (categoryName === 'Free space') return 'var(--msg-tool-card-border)';
  if (isCssColor(category.color)) return category.color;
  if (categoryName.includes('buffer') || categoryName.includes('deferred')) return 'var(--text-tertiary)';
  if (categoryName.includes('System prompt')) return 'var(--msg-user-text)';
  if (categoryName.includes('tools')) return 'var(--msg-tool-text)';
  if (categoryName.includes('Messages')) return 'var(--msg-tool-card-chevron)';
  if (categoryName.includes('Memory')) return 'var(--text-secondary)';
  return 'var(--msg-tool-text)';
}

function isCssColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|hsla\(|var\(--)/.test(value.trim());
}

function localizeContextCategory(t: ReturnType<typeof useTranslation>['t'], name: string): string {
  const keyByName: Record<string, string> = {
    'System prompt': 'systemPrompt',
    'System tools': 'systemTools',
    '[ANT-ONLY] System tools': 'systemTools',
    'MCP tools': 'mcpTools',
    'MCP tools (deferred)': 'mcpToolsDeferred',
    'System tools (deferred)': 'systemToolsDeferred',
    'Custom agents': 'customAgents',
    'Memory files': 'memoryFiles',
    Skills: 'skills',
    Messages: 'messages',
    'Autocompact buffer': 'autocompactBuffer',
    'Compact buffer': 'compactBuffer',
    'Free space': 'freeSpace',
  };
  const key = keyByName[name];
  return key ? t(`chat.systemCard.context.categories.${key}`) : name;
}

function lastPathPart(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sumTokens(items: Array<{ tokens: number }>): number {
  return items.reduce((sum, item) => sum + finiteNumber(item.tokens), 0);
}

function isContextUsageData(value: unknown): value is ContextUsageData {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Partial<ContextUsageData>;
  return (
    Array.isArray(usage.categories) &&
    typeof usage.totalTokens === 'number' &&
    typeof usage.maxTokens === 'number' &&
    typeof usage.rawMaxTokens === 'number' &&
    typeof usage.percentage === 'number' &&
    typeof usage.model === 'string'
  );
}

function fmtPercent(tokens: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${((tokens / total) * 100).toFixed(1)}%`;
}

function fmtContextTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(Math.max(0, Math.round(n)));
}

function PwdCard({ data }: { data?: Record<string, unknown> }) {
  const workingDir = (data?.workingDir as string) ?? '(not set)';

  return (
    <div className={cardClass}>
      <div className={titleClass}>Working Directory</div>
      <span className={cn(codeClass, 'text-14')}>{workingDir}</span>
    </div>
  );
}

function StatusCard({ data }: { data?: Record<string, unknown> }) {
  const model = (data?.model as string) ?? '';
  const effort = (data?.effort as string) ?? '';
  const permissionMode = (data?.permissionMode as string) ?? '';
  const workingDir = (data?.workingDir as string) ?? '(not set)';
  const isRunning = (data?.isRunning as boolean) ?? false;

  return (
    <div className={cardClass}>
      <div className={titleClass}>Session Status</div>
      <div className="flex flex-col gap-[2px]">
        <div className={rowClass}>
          <span className={labelClass}>Agent</span>
          <span className={valueClass}>{isRunning ? 'Running' : 'Idle'}</span>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>Model</span>
          <span className={valueClass}>{model}</span>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>Effort</span>
          <span className={valueClass}>{effort}</span>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>Permission mode</span>
          <span className={valueClass}>{permissionMode}</span>
        </div>
        <div className={rowClass}>
          <span className={labelClass}>Working directory</span>
          <span className={valueClass}>{workingDir}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * F-COMPACT-1 — horizontal divider rendered when SDK auto-compacts the
 * conversation. Visually distinct from the other "info panel" cards because
 * this isn't info to read — it's a transition marker telling the user
 * "old context was summarized; everything below this line is the new context."
 */
function CompactBoundaryCard({ data }: { data?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const trigger = (data?.trigger as 'manual' | 'auto') ?? 'auto';
  const preTokens = typeof data?.preTokens === 'number' ? data.preTokens : 0;
  const postTokens = typeof data?.postTokens === 'number' ? data.postTokens : 0;
  const durationMs = typeof data?.durationMs === 'number' ? data.durationMs : 0;
  const saved = preTokens > postTokens ? preTokens - postTokens : 0;

  const fmtTokens = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  // Build a single line of stats — only show pieces that have real data so
  // the chip doesn't read "saved 0 tokens · 0 ms" when SDK omits the optional
  // post_tokens / duration_ms fields.
  const stats: string[] = [];
  if (saved > 0) stats.push(t('chat.systemCard.compact.savedTokens', { tokens: fmtTokens(saved) }));
  if (durationMs > 0) stats.push(`${(durationMs / 1000).toFixed(1)}s`);
  const triggerLabel = trigger === 'manual' ? t('chat.systemCard.compact.manual') : t('chat.systemCard.compact.auto');

  return (
    <div
      className="flex w-full items-center gap-3 py-2 select-none"
      role="separator"
      aria-label={t('chat.systemCard.compact.aria')}
    >
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-11 text-muted-foreground tabular-nums">
        <Layers size={12} className="shrink-0" />
        <span>{triggerLabel}</span>
        {stats.length > 0 && (
          <>
            <span className="opacity-50">·</span>
            <span>{stats.join(' · ')}</span>
          </>
        )}
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}

/**
 * /goal 达成分隔记录 —— 复用 CompactBoundaryCard 的"分隔条 + 居中 chip"语言:
 * 它不是要读的信息面板,而是会话里的一条达成标记("目标已达成 · N 轮 · 耗时 X")。
 * 由 mapServerMessages 从持久化的 agentMeta.goalCompletion 派生(重开会话仍在)。
 */
function fmtGoalDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function GoalCompleteCard({ data }: { data?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const turnsUsed = typeof data?.turnsUsed === 'number' ? data.turnsUsed : 0;
  const elapsedMs = typeof data?.elapsedMs === 'number' ? data.elapsedMs : 0;
  const reason = typeof data?.reason === 'string' ? data.reason : '';
  const label = t('goal.complete.record', { turns: turnsUsed, duration: fmtGoalDuration(elapsedMs) });

  return (
    <div
      className="flex w-full items-center gap-3 py-2 select-none"
      role="separator"
      aria-label={label}
      title={reason || undefined}
    >
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-11 text-muted-foreground tabular-nums">
        <Target size={12} className="shrink-0" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}

/**
 * /goal 提示分隔条(目前:usageLimited 到点自动续跑的"用量已恢复,继续目标")。
 * 同 GoalCompleteCard 复用 CompactBoundaryCard 的分隔条语言。
 */
function GoalResumedCard({ data }: { data?: { kind?: string } }) {
  const { t } = useTranslation();
  // 两种续跑原因共用同一张分隔条,但说法必须分开:
  //   - 账号限流续跑:重置时刻来自账号额度信息, 说「用量已恢复」有依据;
  //   - 上游过载续跑:只是干等了 60s, **没有**任何容量探测。因此文案只能说
  //     「正在重试目标」—— 说「模型服务已恢复」在持续故障期会在每次重试前插一条
  //     假恢复通知, 紧接着又是一次容量失败(review #844 codex P1)。
  // 存档里的 kind 仍是 'capacity-resumed'(已落库的卡片按这个值渲染), 只有文案改。
  const label =
    data?.kind === 'capacity-resumed'
      ? t('goal.capacityRetryNotice')
      : t('goal.usageResumeNotice');
  return (
    <div className="flex w-full items-center gap-3 py-2 select-none" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-11 text-muted-foreground tabular-nums">
        <Target size={12} className="shrink-0" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}

/**
 * silent-stop 自动续跑分隔条:上游空响应静默收尾后,main 守卫自动补发了隐藏的
 * 「继续」。用户不看到用户气泡,只看到这条轻分隔线标记"上一段与下一段之间发生过
 * 一次自动接续"(否则模型"一句话断成两段凭空接着说"会让人怀疑消息丢了)。
 * 复用 CompactBoundaryCard / GoalResumedCard 的分隔条视觉语言。
 */
/** 活动行需要的展示信息(从 systemCardData 松散读取,缺字段一律降级而不是崩)。 */
interface AutoResumeCardInfo {
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  sessionTotal?: number;
  /** 结果:由 main 在产出 / 再次被打断时回填;缺省 = 还在等结果。 */
  outcome?: 'succeeded' | 'failed';
}

/**
 * 这条自动续跑记录属于「中断重连」还是 silent-stop 的「空回复后续跑」。
 *
 * 判据是有没有任何中断上下文（原因 / 次数 / 累计 / 结果）。**必须区分**：silent-stop 那条
 * 路径也走 `auto-resume` 卡，但它不是重连——把三态重连行套上去，历史里那条「已自动继续」
 * 会变成语义错误的「重新连接」（copilot review）。
 */
function hasInterruptionContext(info: AutoResumeCardInfo): boolean {
  return (
    info.error !== undefined ||
    info.attempt !== undefined ||
    info.maxAttempts !== undefined ||
    info.sessionTotal !== undefined ||
    info.outcome !== undefined
  );
}

function readAutoResumeInfo(data?: Record<string, unknown>): AutoResumeCardInfo {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    ...(typeof data?.error === 'string' && data.error.length > 0 ? { error: data.error } : {}),
    ...(num(data?.attempt) !== undefined ? { attempt: num(data?.attempt) } : {}),
    ...(num(data?.maxAttempts) !== undefined ? { maxAttempts: num(data?.maxAttempts) } : {}),
    ...(num(data?.sessionTotal) !== undefined ? { sessionTotal: num(data?.sessionTotal) } : {}),
    ...(data?.outcome === 'succeeded' || data?.outcome === 'failed'
      ? { outcome: data.outcome }
      : {}),
  };
}

/**
 * 把中断原文压成一行摘要，放进活动行的 param 位（对齐 AgentActionRow 的
 * 「动词 + 命令 / 文件名」结构）。
 *
 * 为什么必须有这一位：只写「已重新连接」是句没有信息量的结论，而这条行存在的唯一理由
 * 就是解释「这里的回复为什么断成两段」。原因得直接看得见，不能只藏在展开区里。
 *
 * 处理：去掉 `API Error:` 这类前缀噪音、只取首句、压掉换行、限长；完整原文仍在展开区。
 */
function summarizeInterruption(detail?: string): string | undefined {
  if (!detail) return undefined;
  const compact = detail
    .replace(/^\s*API Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length === 0) return undefined;
  const firstSentence = compact.split(/(?<=[.。!?！？])\s/)[0] ?? compact;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 71)}…` : firstSentence;
}

/**
 * silent-stop 自动续跑的分隔条（上游用空回复静默收尾后自动续跑）。形态与文案保持
 * 本 PR 之前的原样：居中 pill + 「连接中断，已自动继续」。它不是重连，没有原因也没有
 * 次数，套用重连行只会给出错误的语义。
 *
 * **文案 key 必须是它自己的 `autoResumeSeparator.label`。** 本 PR 把
 * `autoResume.label` 的**值**改成了「已重新连接」（那是重连成功态），复用它等于让
 * silent-stop 行显示「已重新连接」—— 恢复了组件形态却仍然改错文案，只是把回归从
 * 组件层搬到了 i18n 层（copilot review）。
 */
function AutoResumeSeparator() {
  const { t } = useTranslation();
  const label = t('chat.systemCard.autoResumeSeparator.label');
  return (
    <div className="flex w-full items-center gap-3 py-2 select-none" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-11 text-muted-foreground tabular-nums">
        <RefreshCw size={12} className="shrink-0" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
    </div>
  );
}

/**
 * 中断自愈活动行（进行中 / 已完成共用）。
 *
 * **形态刻意对齐 AgentActionRow（工具活动行）**：inner-control 8px / `px-2 py-[3px]` / 16px 状态
 * 图标槽位 / 14px `--msg-tool-card-chevron` 文字 / param 位 / 尾部 18×18 槽始终占位 / hover 抬到
 * `--msg-code-inline-bg`。产品语义就是「这是 agent 干活流程里的一步，只不过这一步在
 * 重连」，而不是一条系统公告——所以它读起来必须像正常工作行，不是横幅、不是警告。
 *
 * 展开详情给三件事：为什么重连（完整原文）、本轮第几次 / 上限、本会话累计多少次。
 * 自愈成功时 error 行**不落库**，所以这里是中断原因唯一的用户可见出口。
 *
 * **只服务「中断重连」这一条路径**：silent-stop 那套（空回复后自动续跑）没有中断原因也
 * 没有重试次数，它继续用原来的 `AutoResumeSeparator`。判据见 `hasInterruptionContext`。
 */
function AutoResumeActionRow({
  state,
  info,
  inFlight,
}: {
  /**
   * `live` = 退避窗口里的 ephemeral 行（一定是"正在重连"）。
   * `recorded` = 落库的那条续跑记录，结果看 `info.outcome` 与 `inFlight`。
   */
  state: 'live' | 'recorded';
  info: AutoResumeCardInfo;
  /**
   * 落库记录**此刻是否真的在飞**：会话有在跑的 turn，且这条续跑指令就是那个 turn 的
   * 发起者（判据在 MessageStream）。为真且结果还没回填时，这一行按"正在重连"呈现。
   */
  inFlight?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasProgress = info.attempt !== undefined && info.maxAttempts !== undefined;
  // **转圈的判据是"此刻真的有 turn 在跑",不是"是不是 ephemeral 行"。**
  //
  // 一次中断的进行中状态跨两种载体:退避那 3–20 秒是 ephemeral 行(state='live'),续跑
  // 指令发出去之后交棒给落库的这一行 —— 那时任务确实在跑,只是还没吐出第一个可见字符。
  // 早先把"落库行"一律做成静态,导致转圈在交棒那一刻断掉,用户看到一个静止的「重新连接」
  // 却不知道是不是还在跑(实测截图)。
  //
  // 但也**不能**只看"结果未回填":app 在回填前退出的话 outcome 永远回不来,会话重开后
  // 一堆历史记录会集体转圈,那是假的。所以由 `inFlight` 把两者分开:
  //   - 未回填 + 正在飞 → 「重新连接中 N/5」+ 转圈(与退避那段文案连续,不跳变)
  //   - 未回填 + 没在飞 → 静态 ⟳ +「重新连接」(中性、无时态,不骗人)
  //   - 已回填          → ✓ / ✗ 定格,`inFlight` 不参与(终态优先)
  const live = state === 'live' || (inFlight === true && info.outcome === undefined);
  const outcome = live ? undefined : info.outcome;
  const label = live
    ? hasProgress
      ? t('chat.systemCard.autoResumePending.labelWithProgress', {
          attempt: info.attempt,
          total: info.maxAttempts,
        })
      : t('chat.systemCard.autoResumePending.label')
    : outcome === 'succeeded'
      ? t('chat.systemCard.autoResume.label')
      : outcome === 'failed'
        ? t('chat.systemCard.autoResume.labelFailed')
        : t('chat.systemCard.autoResume.labelNeutral');
  const summary = summarizeInterruption(info.error);
  const canExpand = Boolean(info.error) || hasProgress || info.sessionTotal !== undefined;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        // 刻意**不设 aria-label**:设了会覆盖按钮的可见文本,读屏就只念得到「已重新连接」,
        // 听不到紧跟其后的中断原因摘要 —— 而那句摘要正是这行存在的理由(copilot review)。
        // 图标与 chevron 都是 aria-hidden,可见文本(动词 + 摘要)本身就是正确的无障碍名。
        disabled={!canExpand}
        className={cn(
          'flex w-full items-center gap-[6px]',
          ACTIVITY_ROW_RADIUS_CLASS,
          'px-2 py-[3px]',
          'text-left outline-none',
          canExpand
            ? cn(
                'group cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-[var(--info-700)]/40',
                ACTIVITY_ROW_COLOR_TRANSITION_CLASS,
                ACTIVITY_ROW_HOVER_SURFACE_CLASS,
              )
            : 'cursor-default select-none',
        )}
      >
        {/* 固定 16px 状态槽位:三态只在同槽位换图标,零布局位移(规则 7)。成功用 Check
            (与工具活动行 done 完全一致)、失败用 X;两者都走同一个灰 token —— 设计规范
            禁止在正文引入 chromatic 色,失败**不给红**,靠图形与文案区分。 */}
        <span
          aria-hidden="true"
          className="inline-flex h-[18px] w-4 items-center justify-center shrink-0 text-[var(--msg-tool-card-chevron)]"
        >
          {live ? (
            <Spinner size={13} />
          ) : outcome === 'succeeded' ? (
            <Check size={13} />
          ) : outcome === 'failed' ? (
            <X size={13} />
          ) : (
            <RefreshCw size={13} />
          )}
        </span>
        <span className="text-14 text-[var(--msg-tool-card-chevron)] shrink-0">{label}</span>
        {/* param 位:中断原因摘要。与动词同色同字号(工具行的命令同款处理),
            不加色 —— 设计规范禁止在正文里引入 chromatic 色。 */}
        {summary && (
          <span
            title={summary}
            className="min-w-0 truncate text-14 text-[var(--msg-tool-card-chevron)]"
          >
            {summary}
          </span>
        )}
        <span className="flex-1" />
        <span aria-hidden="true" className={ACTIVITY_ROW_CHEVRON_SLOT_CLASS}>
          {canExpand ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </span>
      </button>
      {canExpand && expanded && (
        <div
          className={cn(
            'mx-2 mt-1 mb-1 rounded-[6px] px-[10px] py-2',
            'bg-[var(--msg-user-bg)]',
            'border border-[var(--msg-user-border)]',
            'text-[var(--msg-tool-card-chevron)]',
            'select-text cursor-text',
          )}
        >
          {info.error && (
            <>
              <div className="text-12 opacity-70">
                {t('chat.systemCard.autoResume.detail.reason')}
              </div>
              <pre className="m-0 mt-[2px] whitespace-pre-wrap break-words font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[calc(var(--app-code-font-size)_+_4px)]">
                {info.error}
              </pre>
            </>
          )}
          {(hasProgress || info.sessionTotal !== undefined) && (
            <div className={cn('flex flex-wrap gap-x-4 gap-y-[2px] text-12', info.error && 'mt-2')}>
              {hasProgress && (
                <span>
                  {t('chat.systemCard.autoResume.detail.attempt', {
                    attempt: info.attempt,
                    total: info.maxAttempts,
                  })}
                </span>
              )}
              {info.sessionTotal !== undefined && (
                <span>
                  {t('chat.systemCard.autoResume.detail.sessionTotal', {
                    count: info.sessionTotal,
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 交接正文是否为英文格式。
 *
 * `content.handoff` 是持久化数据:英文化之前落库的行仍是中文正文,升级后展开老卡片
 * 看到的就是中文。标题里"原文为英文"那句只能对新格式说,否则会自相矛盾。判据取英文
 * 结束标记的公共尾巴——三种英文标记(handoff / rebuild / fork)都含它,旧中文标记不含。
 * main 侧对应常量见 maker-ipc/agentHandoff.ts 的 *_TERMINATOR。
 */
const ENGLISH_HANDOFF_TERMINATOR_TAIL = "; the user's new message follows ==";

function isEnglishSourceHandoff(handoff: string): boolean {
  // 锚在**尾部**而不是 includes:交接正文里嵌着用户与助手的历史原文,里面完全可能
  // 出现这段尾串(比如聊过这段代码),那样旧中文交接会被误判成英文。结束标记只可能
  // 在整段的最末尾。
  return handoff.trimEnd().endsWith(ENGLISH_HANDOFF_TERMINATOR_TAIL);
}

/**
 * session-agent-switch 边界分隔条:复用 CompactBoundaryCard 的"分隔线 + 居中
 * chip"语言标记"此处引擎从 X 切换到 Y"。chip 可点展开交接内容面板(发给新引擎
 * 的上下文摘要全文)——默认不打扰,想看时可核查我们替用户做了什么交接。
 * 全灰度(docs/design-rules/cindy-design-system.md §4),无 chromatic 色;展开面板复用 msg-tool 系 token。
 */
function AgentSwitchCard({ data }: { data?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const engineLabel = (kind: unknown): string =>
    kind === 'codex' ? 'Codex' : kind === 'pi' ? 'Pi' : 'Claude Code';
  const fromLabel = engineLabel(data?.fromAgentKind);
  const toLabel = engineLabel(data?.toAgentKind);
  const toModel = typeof data?.toModel === 'string' ? data.toModel : '';
  const handoff = typeof data?.handoff === 'string' ? data.handoff : '';
  const label = t('chat.systemCard.agentSwitch.label', { from: fromLabel, to: toLabel });

  return (
    <div className="w-full select-none py-2" role="separator" aria-label={label}>
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
        <button
          type="button"
          onClick={() => handoff && setExpanded((v) => !v)}
          className={cn(
            // min-w-0(而非 shrink-0):自定义供应商的模型 id 可以很长,胶囊必须
            // 能收缩、由内部模型名 truncate 让位,不许把整行顶出卡片宽度。
            'flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)]',
            'bg-background/50 px-2.5 py-1 text-11 text-muted-foreground',
            handoff && 'cursor-pointer hover:bg-[var(--msg-tool-card-bg)]',
          )}
          aria-expanded={expanded}
          title={handoff ? t('chat.systemCard.agentSwitch.toggleHint') : undefined}
        >
          <ArrowLeftRight size={12} className="shrink-0" />
          <span>{label}</span>
          {toModel && (
            <>
              <span className="opacity-50">·</span>
              <span title={toModel} className="min-w-0 truncate font-mono">{toModel}</span>
            </>
          )}
          {Boolean(data?.resumed) && (
            <>
              <span className="opacity-50">·</span>
              <span>{t('chat.systemCard.agentSwitch.resumedBadge')}</span>
            </>
          )}
          {handoff && (
            <ChevronRight
              size={12}
              className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}
            />
          )}
        </button>
        <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      </div>
      <Collapse open={expanded && !!handoff}>
        {handoff ? (
          <div
            className={cn(
              'mx-auto mt-2 max-w-full rounded-[10px] border border-[var(--msg-tool-card-border)]',
              'bg-[var(--msg-tool-card-bg)] px-4 py-3 select-text',
            )}
          >
            <div className="mb-1.5 text-11 font-medium text-muted-foreground">
              {t(
                isEnglishSourceHandoff(handoff)
                  ? 'chat.systemCard.agentSwitch.handoffTitleEnglishSource'
                  : 'chat.systemCard.agentSwitch.handoffTitle',
              )}
            </div>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-12 leading-[1.55] text-[var(--msg-tool-text)]">
              {handoff}
            </pre>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}

const REVIEW_FAILURE_I18N_KEY: Record<ReviewFailureCode, string> = {
  'no-visible-result': 'chat.systemCard.review.noResult',
  'reviewer-closed': 'chat.systemCard.review.failure.reviewerClosed',
  'cancelled-before-start': 'chat.systemCard.review.failure.cancelledBeforeStart',
  interrupted: 'chat.systemCard.review.failure.interrupted',
  'source-workspace-changed': 'chat.systemCard.review.failure.sourceWorkspaceChanged',
  'source-conversation-changed': 'chat.systemCard.review.failure.sourceConversationChanged',
  'source-files-changed': 'chat.systemCard.review.failure.sourceFilesChanged',
  'artifact-changed': 'chat.systemCard.review.failure.artifactChanged',
  'artifact-unavailable': 'chat.systemCard.review.failure.artifactUnavailable',
  'provider-failed': 'chat.systemCard.review.failure.providerFailed',
};

function ReviewCard({ data, workingDir }: { data?: Record<string, unknown>; workingDir?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const status =
    data?.status === 'completed' || data?.status === 'failed' ? data.status : 'running';
  const reviewerSessionId =
    typeof data?.reviewerSessionId === 'string' ? data.reviewerSessionId : '';
  const result = typeof data?.result === 'string' ? data.result : '';
  const error = typeof data?.error === 'string' ? data.error : '';
  const failureCode =
    readReviewFailureCode(data?.failureCode) ?? reviewFailureCodeFromLegacyError(error);
  const failureMessage = failureCode
    ? t(REVIEW_FAILURE_I18N_KEY[failureCode])
    : error || t('chat.systemCard.review.noResult');

  return (
    <div className="my-2 rounded-lg border border-border bg-[var(--surface-chip)] px-3.5 py-3 text-sm">
      <div className="flex items-center gap-2">
        {status === 'running' ? (
          <Spinner size={15} className="text-muted-foreground" />
        ) : status === 'completed' ? (
          <Check size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <X size={15} className="shrink-0 text-[var(--error-fg)]" />
        )}
        <span className="min-w-0 flex-1 font-medium">{t(`chat.systemCard.review.${status}`)}</span>
        {reviewerSessionId && (
          <button
            type="button"
            onClick={() => navigate(`/cc-agent/${reviewerSessionId}`)}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
          >
            {t('chat.systemCard.review.openTask')}
            <ArrowRight size={12} />
          </button>
        )}
      </div>
      {status === 'running' && (
        <p className="mt-1 pl-[23px] text-xs text-muted-foreground">
          {t('chat.systemCard.review.readOnlyHint')}
        </p>
      )}
      {status === 'failed' && (
        <p className="mt-1.5 pl-[23px] text-xs text-[var(--error-fg)]">{failureMessage}</p>
      )}
      {status === 'completed' && result && (
        <div className="mt-3 border-t border-border pt-3">
          <MarkdownRenderer content={result} workingDir={workingDir ?? ''} />
        </div>
      )}
    </div>
  );
}

export function SystemCard({
  cardType,
  data,
  sessionId,
  workingDir,
  autoResumeInFlight,
}: SystemCardProps) {
  switch (cardType) {
    case 'help':
      return <HelpCard data={data} />;
    case 'cost':
      return <CostCard data={data} />;
    case 'context':
      return <ContextCard data={data} />;
    case 'pwd':
      return <PwdCard data={data} />;
    case 'status':
      return <StatusCard data={data} />;
    case 'compact':
      return <CompactBoundaryCard data={data} />;
    case 'cmd':
      return <CmdCard data={data} />;
    case 'goal-complete':
      return <GoalCompleteCard data={data} />;
    case 'goal-resumed':
      return <GoalResumedCard data={data as { kind?: string } | undefined} />;
    case 'auto-resume': {
      // 同一个卡类型承载两套自愈:带中断上下文的是本份的「重连」记录,没有的是 silent-stop
      // 的「已自动继续」分隔条 —— 后者保持原形态原文案,不被重连三态改写(copilot review)。
      const info = readAutoResumeInfo(data);
      return hasInterruptionContext(info) ? (
        <AutoResumeActionRow state="recorded" info={info} inFlight={autoResumeInFlight === true} />
      ) : (
        <AutoResumeSeparator />
      );
    }
    case 'auto-resume-pending':
      return <AutoResumeActionRow state="live" info={readAutoResumeInfo(data)} />;
    case 'agent-switch':
      return <AgentSwitchCard data={data} />;
    case 'learn':
      return <LearnStatusCard data={data} contextSessionId={sessionId} />;
    case 'review':
      return <ReviewCard data={data} workingDir={workingDir} />;
    default:
      return null;
  }
}

// ── CmdCard ──────────────────────────────────────────────────────────────
// /cmd shell 执行结果 —— 终端风格, 严格遵守 docs/design-rules/cindy-design-system.md 的"全灰度"规则:
//   - 不允许任何 chromatic 色 (无绿/红/橙)
//   - 状态/cmdLine/输出全部走 msg-* 灰度 token
//   - exit 0 / exit !=0 / TIMEOUT 通过文案区分, 不通过颜色
// 字段从 main 端 CmdExecutionResult broadcast 过来, 形状契约见
// apps/desktop/src/main/commands/builtins.ts:CmdExecutionResult。

function CmdCard({ data }: { data?: Record<string, unknown> }) {
  const cmdLine = (data?.cmdLine as string) ?? '';
  const cwd = (data?.cwd as string) ?? '';
  const exitCode = (data?.exitCode as number) ?? -1;
  const stdout = (data?.stdout as string) ?? '';
  const stderr = (data?.stderr as string) ?? '';
  const elapsedMs = (data?.elapsedMs as number) ?? 0;
  const timedOut = Boolean(data?.timedOut);
  const spawnError = data?.spawnError as string | undefined;

  // 状态 chip —— 全灰度, pill 形状 (docs/design-rules/cindy-design-system.md §4 Chip & Button Neutrals)。
  // 文案区分 ok / timeout / spawn-err / exit code。
  const statusText = timedOut ? 'timeout' : spawnError ? 'spawn err' : `exit ${exitCode}`;
  const statusChip = (
    <span
      className={cn(
        'shrink-0 px-[8px] py-[1px] rounded-full font-mono text-11',
        'bg-[var(--msg-tool-card-bg)] text-[var(--msg-tool-text)]',
        'border border-[var(--msg-tool-card-border)]',
      )}
    >
      {statusText}
    </span>
  );

  // cmdLine + 各种输出块共用同一个等宽 + 灰度 Card-tone block (12px radius 是
  // docs/design-rules/cindy-design-system.md §5 内置容器圆角)。stderr 和 stdout 视觉一致, 仅靠上方 label 区分,
  // 不用红色 (违反 §2 grayscale 硬规则)。
  const blockClass = cn(
    'mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words',
    'rounded-[12px] px-[12px] py-[10px]',
    'font-mono text-[length:calc(var(--app-code-font-size)_-_1.5px)] leading-[1.55]',
    'bg-[var(--msg-code-block-bg)] text-[var(--msg-user-text)]',
    'border border-[var(--msg-code-block-border)]',
  );
  const cmdLineClass = cn(
    'mt-2 px-[12px] py-[8px] rounded-[12px] overflow-x-auto',
    'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
    'bg-[var(--msg-code-block-bg)] text-[var(--msg-user-text)]',
    'border border-[var(--msg-code-block-border)]',
  );
  const sectionLabelClass = cn(labelClass, 'mt-3 text-12');

  return (
    <div className={cardClass}>
      <div className="flex items-center gap-2">
        <span className={cn(titleClass, 'mb-0')}>$ Shell</span>
        {statusChip}
        <span className={cn(labelClass, 'text-12 ml-auto')}>{elapsedMs}ms</span>
      </div>

      <pre className={cmdLineClass}>{cmdLine || '<empty>'}</pre>

      {cwd && (
        <div className={cn(labelClass, 'mt-1 text-12 truncate')} title={cwd}>
          cwd: {cwd}
        </div>
      )}

      {spawnError && (
        <>
          <div className={sectionLabelClass}>spawn error</div>
          <pre className={blockClass}>{spawnError}</pre>
        </>
      )}
      {stdout && (
        <>
          <div className={sectionLabelClass}>stdout</div>
          <pre className={blockClass}>{stdout}</pre>
        </>
      )}
      {stderr && (
        <>
          <div className={sectionLabelClass}>stderr</div>
          <pre className={blockClass}>{stderr}</pre>
        </>
      )}
      {!stdout && !stderr && !spawnError && (
        <div className={cn(labelClass, 'mt-2 text-12 italic')}>(no output)</div>
      )}
    </div>
  );
}
