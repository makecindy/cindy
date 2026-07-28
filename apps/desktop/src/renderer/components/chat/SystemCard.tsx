/**
 * SystemCard
 * ---------------------------------------------------------------------------
 * F-CMD: Local-only system information cards for slash commands.
 * Renders /help, /cost, /context, /pwd, /status as styled info panels in the chat stream.
 */

import { useState, type ReactNode } from 'react';
import { ArrowLeftRight, ChevronRight, Layers, RefreshCw, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import { LearnStatusCard } from '@/features/learn/LearnStatusCard';

interface SystemCardProps {
  cardType: 'help' | 'cost' | 'context' | 'pwd' | 'status' | 'compact' | 'cmd' | 'goal-complete' | 'goal-resumed' | 'learn' | 'auto-resume' | 'agent-switch';
  data?: Record<string, unknown>;
  /** 卡片所在消息流的 sessionId(MessageStream 注入)。learn 卡按它路由 / 判定
   *  归属会话 —— 嵌入式视图(Orca split pane)里 URL 参数是 lead 而非本 pane,
   *  不能用 useParams(Codex review #548)。 */
  sessionId?: string;
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
  'inline shrink-0 px-[5px] py-[1px] rounded-[4px] font-mono text-[13px]',
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
        'px-3 py-3 text-[13px] leading-none text-[var(--msg-user-text)] select-text',
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
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
          {t('chat.systemCard.context.title')}
        </span>
        <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--msg-tool-text)]">
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
            <div className="mb-2 truncate text-[12px] leading-[1.3] text-[var(--msg-tool-text)]">
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
                  <span className="min-w-0 truncate text-[12px] leading-none text-[var(--msg-user-text)]">
                    {localizeContextCategory(t, cat.name)}
                    {cat.isDeferred && (
                      <span className="ml-1 text-[12px] text-[var(--msg-tool-text)]">
                        {t('chat.systemCard.context.deferred')}
                      </span>
                    )}
                  </span>
                </div>
                <span className="shrink-0 text-[12px] tabular-nums text-[var(--msg-tool-text)]">
                  {fmtContextTokens(cat.tokens)}
                </span>
                <span className="w-[42px] shrink-0 text-right text-[12px] tabular-nums text-[var(--msg-user-text)]">
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
                        'text-left text-[12px] text-[var(--msg-tool-text)] select-none',
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
        <div className="mb-1 text-[12px] font-medium text-[var(--msg-user-text)]">{title}</div>
      )}
      <div className="flex flex-col gap-[2px]">
        {visibleRows.map(([label, tokens]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-[12px]">
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
      <span className={cn(codeClass, 'text-[14px]')}>{workingDir}</span>
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
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground tabular-nums">
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
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground tabular-nums">
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
function GoalResumedCard() {
  const { t } = useTranslation();
  // 目前只有 'usage-resumed' 一种 notice;未来多 kind 再分支。
  const label = t('goal.usageResumeNotice');
  return (
    <div className="flex w-full items-center gap-3 py-2 select-none" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground tabular-nums">
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
function AutoResumeCard() {
  const { t } = useTranslation();
  const label = t('chat.systemCard.autoResume.label');
  return (
    <div className="flex w-full items-center gap-3 py-2 select-none" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
      <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--msg-tool-card-border)] bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground tabular-nums">
        <RefreshCw size={12} className="shrink-0" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-[var(--msg-tool-card-border)]" />
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
    kind === 'codex' ? 'Codex' : 'Claude Code';
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
            'bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground',
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
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
              {t(
                isEnglishSourceHandoff(handoff)
                  ? 'chat.systemCard.agentSwitch.handoffTitleEnglishSource'
                  : 'chat.systemCard.agentSwitch.handoffTitle',
              )}
            </div>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-[var(--msg-tool-text)]">
              {handoff}
            </pre>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}

export function SystemCard({ cardType, data, sessionId }: SystemCardProps) {
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
      return <GoalResumedCard />;
    case 'auto-resume':
      return <AutoResumeCard />;
    case 'agent-switch':
      return <AgentSwitchCard data={data} />;
    case 'learn':
      return <LearnStatusCard data={data} contextSessionId={sessionId} />;
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
        'shrink-0 px-[8px] py-[1px] rounded-full font-mono text-[11px]',
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
  const sectionLabelClass = cn(labelClass, 'mt-3 text-[12px]');

  return (
    <div className={cardClass}>
      <div className="flex items-center gap-2">
        <span className={cn(titleClass, 'mb-0')}>$ Shell</span>
        {statusChip}
        <span className={cn(labelClass, 'text-[12px] ml-auto')}>{elapsedMs}ms</span>
      </div>

      <pre className={cmdLineClass}>{cmdLine || '<empty>'}</pre>

      {cwd && (
        <div className={cn(labelClass, 'mt-1 text-[12px] truncate')} title={cwd}>
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
        <div className={cn(labelClass, 'mt-2 text-[12px] italic')}>(no output)</div>
      )}
    </div>
  );
}
