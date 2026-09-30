import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Mail,
  Plus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getLatestMessageTodoState, isPlanUserBoundary } from '@cindy/maker-shared/message-render';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { collectCachedGeneratedFiles } from '@/components/chat/generatedFilesProjection';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotDelegationView } from '../../../shared/botDelegation';
import type {
  BotWorkbench as BotWorkbenchData,
  BotWorkbenchCard,
  BotWorkbenchDirectory,
  BotWorkbenchRow,
} from '../../../shared/botWorkbench';
import { isActiveDelegationStatus, useBotDelegations } from './botDelegationLive';
import { isBotPrimaryGeneratedFile } from './botGeneratedArtifacts';

/**
 * 伙伴工作台:常驻在伙伴对话右侧的一列统一卡片(参照 Cowork 的 Progress / Outputs / Context)。
 *
 * - 进度、产出、工作来源由宿主从真实状态实时派生:计划步骤、后台任务、生成的文件、
 *   主人交给伙伴的目录。选完目录立刻出现,不等模型。
 * - 伙伴经 `update_workbench` 写入的卡片是它对这份工作的理解,排在进度之后。
 * - 卡片上的按钮 = 以主人身份给伙伴发一句话。
 */

type ChatStore = typeof import('@/lib/makerChatStore').makerChatStore;
type ChatSnapshot = ReturnType<ChatStore['getSnapshot']>;

const COLLAPSE_KEY = 'cindy.botWorkbench.collapsed';
const RECENT_TASK_MS = 24 * 60 * 60 * 1_000;
const MAX_RECENT_TASKS = 3;
const MAX_OUTPUTS = 6;

/**
 * 发送链路(makerChatStore)初始化较重,且依赖完整 i18n 实例;工作台在挂载后再加载它,
 * 不拖慢伙伴页首屏,也不让只渲染伙伴页的轻量环境被连带初始化。
 */
function useChatStore(): ChatStore | null {
  const [store, setStore] = useState<ChatStore | null>(null);
  useEffect(() => {
    let alive = true;
    import('@/lib/makerChatStore')
      .then((module) => {
        if (alive) setStore(module.makerChatStore);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return store;
}

function useChatSnapshot(store: ChatStore | null, sessionId: string): ChatSnapshot | null {
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(sessionId, onChange) : () => {}),
    [sessionId, store],
  );
  const read = useCallback(() => (store ? store.getSnapshot(sessionId) : null), [sessionId, store]);
  return useSyncExternalStore(subscribe, read, read);
}

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function BotWorkbench({
  botId,
  botName,
  sessionId,
}: {
  botId: string;
  botName: string;
  sessionId: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const store = useChatStore();
  const chat = useChatSnapshot(store, sessionId);
  const delegations = useBotDelegations(sessionId);
  const [workbench, setWorkbench] = useState<BotWorkbenchData | null>(null);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);

  const toggle = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = { ...previous, [key]: !previous[key] };
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* 折叠状态只是偏好,写不进去就算了 */
      }
      return next;
    });
  }, []);

  const api = window.electronAPI?.localDb?.bots?.workbench;

  const load = useCallback(() => {
    if (!api) return;
    void api
      .get(botId)
      .then((next) => setWorkbench(next))
      .catch(() => {});
  }, [api, botId]);

  useEffect(() => {
    setWorkbench(null);
    load();
    const off = window.electronAPI?.maker?.onBotWorkbenchChanged?.((payload) => {
      if (payload.botId === botId) load();
    });
    // 目录的分支与改动数是现算的:回到窗口时刷新一次,不做轮询。
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      off?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [botId, load]);

  useEffect(() => {
    let alive = true;
    void sessionService
      .get(sessionId)
      .then((row) => {
        if (alive) setWorkingDir(row.workingDir ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const sendToBot = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        const [chatStore, row] = await Promise.all([
          store ?? import('@/lib/makerChatStore').then((module) => module.makerChatStore),
          sessionService.get(sessionId),
        ]);
        const sent = row.workingDir
          ? await chatStore.sendMessage(sessionId, text, row.model, row.effort, row.permissionMode, row.workingDir)
          : false;
        if (!sent) toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } catch {
        toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } finally {
        setSending(false);
      }
    },
    [botName, sending, sessionId, store, t],
  );

  const giveDirectory = useCallback(async () => {
    const picked = await window.electronAPI.dialog?.showOpenDirectory();
    const dirPath = picked?.success ? picked.path : null;
    if (!dirPath || !api) return;
    const added = await api.addDirectory(botId, dirPath).catch(() => null);
    if (!added?.ok) {
      toast.error(
        added?.errorCode === 'TOO_MANY'
          ? t('bots.workbench.tooManyDirs', { name: botName })
          : t('bots.workbench.dirUnavailable'),
      );
      return;
    }
    const name = dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath;
    void sendToBot(t('bots.workbench.dirPrompt', { name, path: dirPath }));
  }, [api, botId, botName, sendToBot, t]);

  const removeDirectory = useCallback(
    (dirPath: string) => {
      void api?.removeDirectory(botId, dirPath).catch(() => {});
    },
    [api, botId],
  );

  const openTask = useCallback(
    (childSessionId: string) => navigate(`/cc-agent/${encodeURIComponent(childSessionId)}`),
    [navigate],
  );

  const progress = useMemo(() => deriveProgress(chat, delegations), [chat, delegations]);
  const outputs = useMemo(() => deriveOutputs(chat, delegations, workingDir), [chat, delegations, workingDir]);
  const now = useNow(progress.tasks.some((task) => isActiveDelegationStatus(task.status)));
  const cards = workbench?.cards ?? [];
  const directories = workbench?.directories ?? [];
  const streaming = chat?.isStreaming ?? false;

  const connectors = [
    { key: 'mail', icon: Mail, onClick: () => void sendToBot(t('bots.workbench.mailPrompt')) },
    { key: 'calendar', icon: CalendarDays, onClick: () => void sendToBot(t('bots.workbench.calendarPrompt')) },
  ] as const;

  return (
    <aside
      aria-label={t('bots.workbench.title')}
      className="hidden w-[336px] shrink-0 flex-col gap-3 overflow-y-auto py-4 pl-1 pr-4 min-[1180px]:flex"
    >
      <Section
        title={t('bots.workbench.progress')}
        collapsed={collapsed.progress}
        onToggle={() => toggle('progress')}
      >
        {progress.steps.length === 0 && progress.tasks.length === 0 && !streaming ? (
          <Empty>{t('bots.workbench.progressEmpty', { name: botName })}</Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {progress.steps.map((step, index) => (
              <StepRow key={`${step.content}-${index}`} status={step.status} animated={streaming}>
                {step.status === 'in_progress' && step.activeForm ? step.activeForm : step.content}
              </StepRow>
            ))}
            {progress.steps.length === 0 && streaming ? (
              <StepRow status="in_progress" animated>
                {t('bots.workbench.working', { name: botName })}
              </StepRow>
            ) : null}
            {progress.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                onOpen={task.childSessionId ? () => openTask(task.childSessionId!) : undefined}
              />
            ))}
          </div>
        )}
      </Section>

      {cards.map((card, index) => (
        <WorkCard
          key={`${card.title}-${index}`}
          card={card}
          updatedAt={index === 0 ? workbench?.updatedAt ?? null : null}
          language={i18n.language}
          collapsed={collapsed[`card:${card.title}`]}
          onToggle={() => toggle(`card:${card.title}`)}
          disabled={sending}
          onAction={sendToBot}
        />
      ))}

      <Section
        title={t('bots.workbench.outputs')}
        collapsed={collapsed.outputs}
        onToggle={() => toggle('outputs')}
      >
        {outputs.length === 0 ? (
          <Empty>{t('bots.workbench.outputsEmpty', { name: botName })}</Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {outputs.map((file) => (
              <button
                key={file.path}
                type="button"
                title={file.path}
                onClick={() => void window.electronAPI.openPath?.(file.path)}
                className={ROW_BUTTON_CLASS}
              >
                <FileGlyph name={file.name} />
                <span className="min-w-0 flex-1 truncate text-13 leading-5 text-[var(--text-primary)]">{file.name}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t('bots.workbench.context')}
        collapsed={collapsed.context}
        onToggle={() => toggle('context')}
      >
        {directories.length === 0 ? (
          <Empty>{t('bots.workbench.contextEmpty', { name: botName })}</Empty>
        ) : null}
        <div className="flex flex-col gap-0.5">
          {directories.map((dir) => (
            <DirectoryRow key={dir.path} dir={dir} language={i18n.language} onRemove={() => removeDirectory(dir.path)} />
          ))}
          <SourceButton icon={FolderOpen} label={t('bots.workbench.dir')} hint={t('bots.workbench.dirHint')} disabled={sending} onClick={giveDirectory} />
          {connectors.map(({ key, icon, onClick }) => (
            <SourceButton
              key={key}
              icon={icon}
              label={t(`bots.workbench.${key}`)}
              hint={t(`bots.workbench.${key}Hint`)}
              disabled={sending}
              onClick={onClick}
            />
          ))}
        </div>
      </Section>
    </aside>
  );
}

// ─── 派生:全部来自宿主已有的真实状态 ────────────────────────────────

interface ProgressView {
  steps: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>;
  tasks: BotDelegationView[];
}

function deriveProgress(chat: ChatSnapshot | null, delegations: readonly BotDelegationView[]): ProgressView {
  const messages = chat?.messages ?? [];
  let steps: ProgressView['steps'] = [];
  if (messages.length > 0) {
    const state = getLatestMessageTodoState(messages);
    // 计划只属于最近一次真实的主人发言;主人换了话题,旧计划就退场。
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isPlanUserBoundary(messages[index])) {
        lastUser = index;
        break;
      }
    }
    if (state.insertion && state.latestPlanIndex > lastUser) steps = state.insertion.todos;
  }
  const cutoff = Date.now() - RECENT_TASK_MS;
  const sorted = [...delegations].sort((a, b) => b.createdAt - a.createdAt);
  const active = sorted.filter((task) => isActiveDelegationStatus(task.status));
  const recent = sorted
    .filter((task) => !isActiveDelegationStatus(task.status) && (task.completedAt ?? task.updatedAt) >= cutoff)
    .slice(0, MAX_RECENT_TASKS);
  return { steps, tasks: [...active, ...recent] };
}

interface OutputFile {
  path: string;
  name: string;
}

function deriveOutputs(
  chat: ChatSnapshot | null,
  delegations: readonly BotDelegationView[],
  workingDir: string | null,
): OutputFile[] {
  const out: OutputFile[] = [];
  const seen = new Set<string>();
  const push = (file: OutputFile) => {
    if (out.length >= MAX_OUTPUTS || seen.has(file.path)) return;
    seen.add(file.path);
    out.push(file);
  };
  // 后台任务交回的文件在前(它们是明确交付的成果),再补本对话里伙伴新建的文件。
  for (const task of [...delegations].sort((a, b) => b.createdAt - a.createdAt)) {
    for (const artifact of task.artifacts) {
      if (!artifact.absolutePath || artifact.status === 'deleted') continue;
      const name = artifact.absolutePath.split(/[\\/]/).pop() ?? artifact.path;
      if (isBotPrimaryGeneratedFile({ path: artifact.absolutePath, name, source: 'tool' })) {
        push({ path: artifact.absolutePath, name });
      }
    }
  }
  if (chat && workingDir && chat.messages.length > 0) {
    const files = collectCachedGeneratedFiles(chat.messages, workingDir);
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const file = files[index];
      if (file.source !== 'tool' || file.ready === false) continue;
      if (isBotPrimaryGeneratedFile(file, workingDir)) push({ path: file.path, name: file.name });
    }
  }
  return out;
}

function relativeTime(iso: string, language: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

// ─── 统一卡片 ───────────────────────────────────────────────────────

const ROW_BUTTON_CLASS =
  'group -mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50';

function Section({
  title,
  meta,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  meta?: string | null;
  collapsed?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <h3 className="min-w-0 flex-1 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{title}</h3>
        {meta ? <span className="max-w-[50%] shrink-0 truncate text-12 text-[var(--text-tertiary)]">{meta}</span> : null}
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-[var(--text-tertiary)] transition-transform', collapsed && '-rotate-90')}
        />
      </button>
      {collapsed ? null : <div className="px-4 pb-3">{children}</div>}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="pb-1 text-12 leading-[18px] text-[var(--text-tertiary)]">{children}</p>;
}

function StepRow({
  status,
  animated,
  children,
}: {
  status: 'pending' | 'in_progress' | 'completed';
  animated: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-start gap-2.5 py-1.5">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {status === 'completed' ? (
          <CircleCheck size={16} strokeWidth={1.6} className="text-[var(--text-tertiary)]" />
        ) : status === 'in_progress' ? (
          <Spinner icon={LoaderCircle} size={16} strokeWidth={1.6} spinning={animated} className="text-[var(--text-primary)]" />
        ) : (
          <Circle size={16} strokeWidth={1.6} className="text-[var(--text-tertiary)]" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 break-words text-13 leading-5',
          status === 'completed' && 'text-[var(--text-tertiary)]',
          status === 'in_progress' && 'font-medium text-[var(--text-primary)]',
          status === 'pending' && 'text-[var(--text-secondary)]',
        )}
      >
        {children}
      </span>
    </div>
  );
}

function formatDuration(t: (key: string, options?: Record<string, unknown>) => string, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return t('bots.collab.duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.collab.duration.minutes', { n: minutes });
  return t('bots.collab.duration.hoursMinutes', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function TaskRow({ task, now, onOpen }: { task: BotDelegationView; now: number; onOpen?: () => void }) {
  const { t } = useTranslation();
  const active = isActiveDelegationStatus(task.status);
  const startedAt = task.acceptedAt ?? task.createdAt;
  const endedAt = active ? now : task.completedAt ?? task.updatedAt;
  const failed = task.status === 'failed' || task.status === 'timed-out' || task.status === 'cancelled';
  const content = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {active ? (
          <Spinner icon={LoaderCircle} size={16} strokeWidth={1.6} className="text-[var(--text-primary)]" />
        ) : failed ? (
          <CircleX size={16} strokeWidth={1.6} className="text-[var(--text-tertiary)]" />
        ) : (
          <CircleCheck size={16} strokeWidth={1.6} className="text-[var(--text-tertiary)]" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-13 leading-5', active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
          {task.title}
        </span>
        <span className="truncate text-12 leading-4 text-[var(--text-tertiary)]">
          {t(`bots.collab.status.${task.status}`, { defaultValue: t('bots.collab.status.unknown') })}
          {' · '}
          {formatDuration(t, endedAt - startedAt)}
        </span>
      </span>
      {onOpen ? (
        <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100" />
      ) : null}
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className={cn(ROW_BUTTON_CLASS, 'items-start')} aria-label={`${task.title} · ${t('bots.collab.watchWork')}`}>
      {content}
    </button>
  ) : (
    <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5">{content}</div>
  );
}

function WorkCard({
  card,
  updatedAt,
  language,
  collapsed,
  onToggle,
  disabled,
  onAction,
}: {
  card: BotWorkbenchCard;
  updatedAt: string | null;
  language: string;
  collapsed?: boolean;
  onToggle: () => void;
  disabled: boolean;
  onAction: (message: string) => void;
}) {
  const when = updatedAt ? relativeTime(updatedAt, language) : null;
  const meta = [card.source, when].filter(Boolean).join(' · ');
  return (
    <Section title={card.title} meta={meta || null} collapsed={collapsed} onToggle={onToggle}>
      <div className="flex flex-col">
        {card.rows.map((row, index) => (
          <WorkRow key={`${row.title}-${index}`} row={row} disabled={disabled} onAction={onAction} />
        ))}
      </div>
    </Section>
  );
}

function WorkRow({
  row,
  disabled,
  onAction,
}: {
  row: BotWorkbenchRow;
  disabled: boolean;
  onAction: (message: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[var(--border-default)]">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {row.flag ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--warning-accent)]" />
          ) : null}
          <span className="truncate text-13 leading-5 text-[var(--text-primary)]" title={row.title}>
            {row.title}
          </span>
        </span>
        {row.detail ? (
          <span className="line-clamp-2 text-12 leading-4 text-[var(--text-tertiary)]" title={row.detail}>
            {row.detail}
          </span>
        ) : null}
      </div>
      {row.action ? (
        <Button
          variant="secondary"
          size="sm"
          compact
          type="button"
          disabled={disabled}
          className="shrink-0 px-3 text-12"
          onClick={() => onAction(row.action!.message)}
        >
          {row.action.label}
        </Button>
      ) : row.status ? (
        <span className="shrink-0 text-12 text-[var(--text-tertiary)]">{row.status}</span>
      ) : null}
    </div>
  );
}

function DirectoryRow({
  dir,
  language,
  onRemove,
}: {
  dir: BotWorkbenchDirectory;
  language: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const facts: string[] = [];
  if (!dir.exists) facts.push(t('bots.workbench.dirMissing'));
  else if (dir.git) {
    if (dir.git.branch) facts.push(dir.git.branch);
    facts.push(
      dir.git.changes > 0 ? t('bots.workbench.dirChanges', { count: dir.git.changes }) : t('bots.workbench.dirClean'),
    );
    const last = dir.git.lastCommit ? relativeTime(dir.git.lastCommit.at, language) : null;
    if (last) facts.push(t('bots.workbench.dirLastCommit', { time: last }));
  } else facts.push(t('bots.workbench.dirFolder'));
  return (
    <div className="group relative">
      <button
        type="button"
        title={dir.path}
        onClick={() => void window.electronAPI.openPath?.(dir.path)}
        className={cn(ROW_BUTTON_CLASS, 'w-[calc(100%+16px)] pr-8')}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          {dir.git ? <GitBranch size={14} strokeWidth={1.8} /> : <Folder size={14} strokeWidth={1.8} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-13 leading-5 text-[var(--text-primary)]">{dir.name}</span>
          <span className={cn('truncate text-12 leading-4', dir.exists ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-danger)]')}>
            {facts.join(' · ')}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('bots.workbench.removeDir', { name: dir.name })}
        className="absolute right-0 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--text-tertiary)] opacity-0 outline-none transition-opacity hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function SourceButton({
  icon: Icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: typeof Mail;
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={ROW_BUTTON_CLASS}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]">
        <Icon size={14} strokeWidth={1.8} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 leading-5 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{label}</span>
        <span className="truncate text-12 leading-4 text-[var(--text-tertiary)]">{hint}</span>
      </span>
      <Plus size={14} className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function FileGlyph({ name }: { name: string }) {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const Icon = /^(png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/.test(extension)
    ? FileImage
    : /^(csv|tsv|xlsx?|numbers|ods)$/.test(extension)
      ? FileSpreadsheet
      : /^(md|txt|pdf|docx?|pages|rtf|html?)$/.test(extension)
        ? FileText
        : File;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-secondary)]">
      <Icon size={14} strokeWidth={1.8} />
    </span>
  );
}
