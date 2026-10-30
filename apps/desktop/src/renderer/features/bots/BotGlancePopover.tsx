/** Partner glance: existing computer controls, nonempty owner todos, attributed tasks and outputs.
 * Task attention and PR state are read-only projections of the ordinary task list stores.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Check, ChevronDown, LayoutGrid, Monitor, ScanSearch, MessageCircle, GitPullRequest, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildTodoReferenceHref } from '@cindy/maker-shared/agent-input-projection';
import { todoDateLabel, todoDue, todoDueSoon, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import { usePrActions, usePrRefsForSessions, usePrStatuses } from '@/contexts/PrRefsContext';
import { prStatusKey, sessionPrUrl, type SessionPrRef } from '@cindy/maker-shared';
import { PR_STATUS_ICON, PR_STATUS_COLOR } from '@/features/cc-agent/gitContextPrVisuals';
import { sessionActivityMs } from '@/features/cc-agent/lib/dateSessionGrouping';
import { matchesTaskCreators, useTaskCreatorIndex } from './botFollowScopes';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { remoteProjectsStore, useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { insertTodoReferenceIntoComposer } from '@/lib/composerActionsBus';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { BotAvatar } from './BotAvatar';
import { isBotKnownOffline } from './BotConnectionStatus';
import { HomeSwitchConfirm, useCompanionHomeSwitch, type HomeSwitch } from './BotHomeComputerSetting';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { useBotDelegations } from './botDelegationLive';
import { isBotPrimaryGeneratedFile } from './botGeneratedArtifacts';
import { useBotProfiles, useBotUnreadCounts } from './botStore';
import { cloudRemoteBots, withoutCloudCompanions, withoutShadowedBots } from './companionCloudPresentation';
import { useCompanionCloud } from './companionCloudStore';
import { cindyDeviceKey, cindyDeviceOptions, isCindyDeviceBot, taskCreatorFilterKey } from './cindyDeviceRoster';
import {
  dueTodos,
  hasUnseenDue,
  markDueSeen,
  patchGlanceTodo,
  setGlanceDailyCheck,
  useGlanceTodos,
  type GlanceTodoHost,
} from './botGlanceTodos';
import { useRemoteBots, useRemoteCindyIds } from './useRemoteBots';

/** 每块先列几条，其余收进「显示更多」。 */
const TODO_PREVIEW = 2;
const TASK_PREVIEW = 5;
const OUTPUT_PREVIEW = 3;
const OUTPUT_LIMIT = 30;

function useToggle(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  return [open, () => setOpen((value) => !value)];
}

function Section({ label, children, divided = true, action }: { label: string; children: ReactNode; divided?: boolean; action?: ReactNode }) {
  return (
    <section className={cn('px-2 py-1.5', divided && 'border-t border-[var(--border-default)]')}>
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5"><h3 className="text-12 font-normal text-[var(--text-tertiary)]">{label}</h3>{action}</div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({
  icon,
  title,
  meta,
  inlineMeta = false,
  trailing,
  muted = false,
  onClick,
  onContextMenu,
  onKeyDown,
  testId,
}: {
  icon?: ReactNode;
  title: string;
  meta?: string;
  inlineMeta?: boolean;
  trailing?: ReactNode;
  muted?: boolean;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  testId?: string;
}) {
  const body = (
    <>
      {icon ? (
        <span className="flex w-5 shrink-0 justify-center text-[var(--text-secondary)]">{icon}</span>
      ) : null}
      <span className={cn('min-w-0 flex-1', inlineMeta && 'flex items-baseline gap-2')}>
        <span
          title={title}
          className={cn(
            'block min-w-0 truncate text-13 leading-5',
            inlineMeta && 'flex-1',
            muted ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
          )}
        >
          {title}
        </span>
        {meta ? <span title={meta} className={cn('block truncate text-12 leading-4 text-[var(--text-tertiary)]', inlineMeta && 'max-w-[40%] shrink-0')}>{meta}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-1.5 pl-2 text-12 text-[var(--text-secondary)]">{trailing}</span> : null}
    </>
  );
  const className = 'flex min-h-8 w-full items-center gap-3 rounded-lg px-2 py-1 text-left';
  if (!onClick)
    return (
      <div data-testid={testId} className={className}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      aria-haspopup={onContextMenu ? 'menu' : undefined}
      className={cn(className, 'select-none outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]')}
    >
      {body}
    </button>
  );
}

function FoldRow({ label, open, onClick, indent }: { label: string; open: boolean; onClick: () => void; indent: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className={cn(
        'flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-12 text-[var(--text-tertiary)] outline-none',
        'hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
        indent && 'pl-10',
      )}
    >
      <span>{label}</span>
      <ChevronDown size={12} className={cn('shrink-0 transition-transform duration-150', open && 'rotate-180')} />
    </button>
  );
}

/** 期限前的到期红点；入口按钮上同一种点（DESIGN.md「伙伴待办到期点」）。 */
export function TodoDueDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full bg-[var(--error-fg)]', className)} />;
}

// ---------------------------------------------------------------- 电脑

interface ComputerRowModel {
  key: string;
  name: string;
  current: boolean;
  online: boolean;
  unread?: boolean;
  onSelect?: () => void;
}

function ComputerRows({ rows }: { rows: ComputerRowModel[] }) {
  const { t } = useTranslation();
  const [showOffline, toggleOffline] = useToggle();
  const current = rows.filter((row) => row.current);
  const online = rows.filter((row) => !row.current && row.online);
  const offline = rows.filter((row) => !row.current && !row.online);
  const render = (row: ComputerRowModel) => (
    <Row
      key={row.key}
      testId="bot-glance-computer"
      icon={<Monitor size={16} />}
      title={row.name}
      muted={!row.current && !row.online}
      meta={row.current ? t('bots.glance.runningHere') : row.online ? t('bots.glance.online') : t('bots.glance.offline')}
      inlineMeta
      trailing={
        row.current ? (
          <Check size={14} className="text-[var(--text-primary)]" aria-label={t('bots.glance.current')} />
        ) : row.unread ? (
          <span aria-label={t('bots.devicePicker.unread')} className="size-1.5 rounded-full bg-[var(--bot-unread-bg)]" />
        ) : null
      }
      onClick={!row.current && row.online ? row.onSelect : undefined}
    />
  );
  return (
    <>
      {current.map(render)}
      {online.map(render)}
      {offline.length > 0 ? (
        <FoldRow
          indent
          open={showOffline}
          onClick={toggleOffline}
          label={t('bots.glance.offlineCount', { count: offline.length })}
        />
      ) : null}
      {showOffline ? offline.map(render) : null}
    </>
  );
}

/** 云端伙伴：主力电脑 + 可以换去的电脑（打开浮层时才读）。确认框挂在浮层外面，浮层收起也不丢。 */
function CloudComputers({
  bot,
  open,
  state,
  onClose,
}: {
  bot: BotChatIdentity;
  open: boolean;
  state: HomeSwitch;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const loaded = useRef(false);
  useEffect(() => {
    if (open && !loaded.current) {
      loaded.current = true;
      state.load();
    }
    if (!open) loaded.current = false;
    // 每次打开只读一次可以换去的电脑。
  }, [open]);
  const targets = state.choices && state.choices.mode !== 'unavailable' ? state.choices.targets : [];
  const rows: ComputerRowModel[] = [
    { key: `home:${state.home ?? ''}`, name: state.homeName, current: true, online: true },
    ...targets
      .filter((target) => target.deviceId !== state.home)
      .map((target) => ({
        key: target.deviceId,
        name: state.targetName(target),
        current: false,
        online: target.online,
        onSelect: () => {
          onClose();
          state.setError(null);
          state.setPending(target);
        },
      })),
  ];
  return (
    <>
      <ComputerRows rows={rows} />
      {state.choicesFailed ? (
        <p className="px-2 pb-1 text-12 text-[var(--text-tertiary)]">{t('bots.cloud.devicesFailed')}</p>
      ) : !state.movable ? (
        <p className="px-2 pb-1 text-12 text-[var(--text-tertiary)]">{t('bots.cloud.resumeToMove', { name: bot.name })}</p>
      ) : null}
    </>
  );
}

/** Cindy 在每台电脑上各有一份：列出各台，点另一台就打开那台上的她。 */
function useCindyComputerRows(bot: BotChatIdentity, enabled: boolean): ComputerRowModel[] | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const bots = withoutCloudCompanions(withoutShadowedBots(useBotProfiles(), cloud), cloud);
  const remoteBots = withoutCloudCompanions(cloudRemoteBots(cloud, useRemoteBots()), cloud);
  const devices = useDeviceLinkDeviceList();
  const unread = useBotUnreadCounts();
  if (!enabled) return null;
  const options = cindyDeviceOptions(bots, remoteBots, devices ?? [], unread, t('bots.cloud.thisComputer'));
  const currentKey = cindyDeviceKey(bot);
  if (options.length < 2 || !options.some((option) => option.key === currentKey)) return null;
  return options.map((option) => ({
    key: option.key,
    name: option.deviceName || option.label,
    current: option.key === currentKey,
    online: !isBotKnownOffline(option.online, 'deviceId' in option.bot ? option.bot.connectionKnown : undefined),
    unread: option.unread,
    onSelect: () => navigate(option.route),
  }));
}

function Computers({
  bot,
  open,
  cloudHome,
  homeSwitch,
  onClose,
}: {
  bot: BotChatIdentity;
  open: boolean;
  cloudHome: boolean;
  homeSwitch: HomeSwitch;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const cindyRows = useCindyComputerRows(bot, !cloudHome && isCindyDeviceBot(bot));
  if (cloudHome) return <CloudComputers bot={bot} open={open} state={homeSwitch} onClose={onClose} />;
  if (cindyRows) return <ComputerRows rows={cindyRows} />;
  const selfName = devices?.find((device) => device.isSelf)?.name?.trim();
  const name = bot.deviceId
    ? bot.deviceName?.trim() || t('bots.cloud.unknownDevice')
    : selfName || t('bots.cloud.thisComputer');
  return <ComputerRows rows={[{ key: bot.deviceId ?? 'local', name, current: true, online: true }]} />;
}

// ---------------------------------------------------------------- 待办

function sourceText(todo: TeammateTodo, t: (key: string) => string): string {
  const source = todo.sources[0];
  if (!source || source.kind === 'conversation') return t('bots.glance.source.conversation');
  const kind = t(`bots.glance.source.${source.kind}`);
  const label = source.label?.trim();
  // 来源名已含标签（「来自 GitHub」+「GitHub」）时不再重复。
  return label && !kind.toLowerCase().includes(label.toLowerCase()) ? `${kind} · ${label}` : kind;
}

function TodoRow({
  todo,
  onOpen,
  onMenu,
}: {
  todo: TeammateTodo;
  onOpen: (todo: TeammateTodo) => void;
  onMenu: (todo: TeammateTodo, x: number, y: number, origin: HTMLButtonElement) => void;
}) {
  const { t, i18n } = useTranslation();
  const due = todoDue(todo);
  const date = todoDateLabel(todo, i18n.language);
  return (
    <Row
      testId="bot-glance-todo"
      title={todo.title}
      meta={sourceText(todo, t)}
      trailing={
        date ? (
          <>
            {due ? <TodoDueDot /> : null}
            <span className={due ? 'text-[var(--text-primary)]' : undefined}>{date}</span>
          </>
        ) : null
      }
      onClick={() => onOpen(todo)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(todo, event.clientX, event.clientY, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onMenu(todo, rect.left + 10, rect.bottom, event.currentTarget);
      }}
    />
  );
}

/**
 * 「帮我查查」：以主人的一句话发进伙伴对话，和主人自己打字发送走同一条路径（远程伙伴同样带来源设备标记）。
 * 用的是伙伴对话当前的模型、思考档位与权限。
 */
async function sendToTeammate(sessionId: string, deviceId: string | undefined, text: string): Promise<boolean> {
  const owner = getDataOwnerGeneration();
  const row = deviceId
    ? (remoteProjectsStore.getDeviceSessions(deviceId).find((session) => session.id === sessionId) ??
      ((await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [sessionId])) as Session | null))
    : await sessionService.get(sessionId);
  if (!isDataOwnerGenerationCurrent(owner) || !row?.workingDir) return false;
  return makerChatStore.sendMessage(sessionId, text, row.model, row.effort, row.permissionMode, row.workingDir);
}

function DailyCheckSwitch({ host, todos }: { host: GlanceTodoHost; todos: ReturnType<typeof useGlanceTodos> }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const checked = todos.todos.dailyCheck;
  if (!checked) return null;
  const change = async (next: boolean) => {
    setBusy(true);
    try {
      todos.setDailyCheck(await setGlanceDailyCheck(host, next));
    } catch {
      toast.error(t('bots.glance.dailyCheckFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-testid="bot-glance-daily-check"
      className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-hover)]"
    >
      <span className="w-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-13 text-[var(--text-primary)]">{t('bots.glance.dailyCheck')}</span>
        <span className="block truncate text-12 text-[var(--text-tertiary)]">{t('bots.glance.dailyCheckMeta')}</span>
      </span>
      <button type="button" disabled={busy} aria-label={t('bots.glance.stopDailyCheck')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        onClick={() => void change(false)}><X size={16} /></button>
    </div>
  );
}

function Todos({
  host,
  sessionId,
  todos,
  onClose,
}: {
  host: GlanceTodoHost;
  sessionId: string;
  todos: ReturnType<typeof useGlanceTodos>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [showAll, toggleAll] = useToggle();
  const [menu, setMenu] = useState<{ todo: TeammateTodo; x: number; y: number } | null>(null);
  const menuOrigin = useRef<HTMLButtonElement | null>(null);
  const now = new Date();
  const open = todos.todos.open.filter(todo => todoDueSoon(todo, now));
  const openTotal = open.length;

  const check = () => {
    onClose();
    void sendToTeammate(sessionId, host.deviceId, t('bots.glance.checkPrompt'))
      .then((sent) => {
        if (!sent) toast.error(t('bots.glance.checkFailed'));
      })
      .catch(() => toast.error(t('bots.glance.checkFailed')));
  };

  const quote = (todo: TeammateTodo) => {
    onClose();
    // 浮层收起后再插入，焦点回到输入框而不是被浮层的关闭动画抢走。
    requestAnimationFrame(() =>
      insertTodoReferenceIntoComposer({
        targetSessionId: sessionId,
        href: buildTodoReferenceHref(host.botId, todo.id),
        title: todo.title,
      }),
    );
  };
  const remove = async (todo: TeammateTodo) => {
    try {
      const deleted = await patchGlanceTodo(host, { id: todo.id, expectedRevision: todo.revision, operation: 'delete' });
      void todos.refresh();
      toast.info(t('bots.glance.deleted'), {
        duration: 6000,
        action: {
          label: t('bots.glance.undo'),
          onClick: () =>
            void patchGlanceTodo(host, {
              id: todo.id,
              expectedRevision: deleted?.revision ?? todo.revision + 1,
              operation: 'restore',
            })
              .then(() => todos.refresh())
              .catch(() => toast.error(t('bots.glance.undoFailed'))),
        },
      });
    } catch {
      toast.error(t('bots.glance.deleteFailed'));
      void todos.refresh();
    }
  };

  if (!todos.loaded) return null;
  if (openTotal === 0) return todos.failed
    ? <Section label={t('bots.glance.todos')}><Row title={t('bots.glance.loadFailed')} onClick={() => void todos.refresh()} /></Section>
    : null;
  const visible = showAll ? open : open.slice(0, TODO_PREVIEW);
  const hiddenCount = Math.max(0, openTotal - TODO_PREVIEW);
  return (
    <Section label={t('bots.glance.todos')} action={<button type="button" data-testid="bot-glance-check"
      aria-label={t('bots.glance.check')} title={t('bots.glance.check')} onClick={check}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><ScanSearch size={16} /></button>}>
      <DailyCheckSwitch host={host} todos={todos} />
      {visible.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          onOpen={quote}
          onMenu={(target, x, y, origin) => {
            menuOrigin.current = origin;
            setMenu({ todo: target, x, y });
          }}
        />
      ))}
      {hiddenCount > 0 ? (
        <FoldRow indent={false} open={showAll} onClick={toggleAll} label={showAll ? t('bots.glance.showLess') : t('bots.glance.showMore')} />
      ) : null}
      <DropdownMenu open={menu !== null} onOpenChange={(next) => { if (!next) setMenu(null); }}>
        {/* 锚点挂到 body：浮层带入场变换，fixed 元素放在里面会按浮层而不是窗口定位。 */}
        {createPortal(
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden="true"
              className="pointer-events-none fixed h-0 w-0"
              style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
            />
          </DropdownMenuTrigger>,
          document.body,
        )}
        <DropdownMenuContent
          align="start"
          className="min-w-40"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menuOrigin.current?.focus({ preventScroll: true });
          }}
        >
          <DropdownMenuItem
            variant="danger"
            onSelect={() => {
              const target = menu?.todo;
              setMenu(null);
              if (target) void remove(target);
            }}
          >
            {t('bots.glance.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Section>
  );
}

// ---------------------------------------------------------------- 输出内容

interface OutputFile {
  key: string;
  name: string;
  absolutePath?: string;
  childSessionId: string | null;
  taskTitle: string;
  at: number;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function useOutputs(sessionId: string, botId: string): OutputFile[] {
  const delegations = useBotDelegations(sessionId);
  return useMemo(() => {
    const files: OutputFile[] = [];
    for (const delegation of delegations) {
      if (delegation.requestingBotId !== botId || delegation.status !== 'completed') continue;
      for (const artifact of delegation.artifacts) {
        if (artifact.status === 'deleted') continue;
        const name = basename(artifact.path);
        if (!isBotPrimaryGeneratedFile({ path: artifact.absolutePath ?? artifact.path, name, source: 'tool' })) continue;
        files.push({
          key: `${delegation.id}:${artifact.path}`,
          name,
          absolutePath: artifact.absolutePath,
          childSessionId: delegation.childSessionId,
          taskTitle: delegation.title,
          at: delegation.completedAt ?? delegation.updatedAt,
        });
      }
    }
    return files.sort((a, b) => b.at - a.at).slice(0, OUTPUT_LIMIT);
  }, [botId, delegations]);
}


function Outputs({ sessionId, botId, onClose, prs }: { sessionId: string; botId: string; onClose: () => void; prs: SessionPrRef[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showAll, toggleAll] = useToggle();
  const files = useOutputs(sessionId, botId);
  const outputs = [
    ...files.map(file => ({ kind: 'file' as const, key: `file:${file.key}`, at: file.at, file })),
    ...prs.map(pr => ({ kind: 'pr' as const, key: `pr:${prStatusKey(pr)}`, at: pr.lastSeenAt, pr })),
  ].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  if (outputs.length === 0) return null;
  const open = async (file: OutputFile) => {
    // 别的电脑上的伙伴：文件路径属于那台电脑，不在这台打开；改为打开那台上的来源任务。
    const deviceId = remoteProjectsStore.getSessionDeviceId(sessionId);
    if (file.absolutePath && !deviceId) {
      const result = await window.electronAPI.openPath(file.absolutePath);
      if (shouldShowOpenPathError(result)) toast.error(t('bots.glance.openFailed'));
      return;
    }
    const childId = file.childSessionId;
    if (!childId) return;
    if (deviceId) {
      // 子任务可能还没进远程列表（例如已归档）：先登记它属于伙伴那台电脑，路由与读取才不会落到本机。
      const origin = remoteProjectsStore.getSessionDeviceId(childId);
      if (origin && origin !== deviceId) return;
      remoteProjectsStore.pinSessionOrigin(deviceId, childId);
    }
    onClose();
    navigate(await resolveSessionRoute(childId));
  };
  const visible = showAll ? outputs : outputs.slice(0, OUTPUT_PREVIEW);
  return (
    <Section label={t('bots.glance.outputs')}>
      {visible.map(output => output.kind === 'pr' ? <PrOutput key={output.key} pr={output.pr} /> : (
        <Row
          key={output.key}
          testId="bot-glance-output"
          icon={<FileTypeIcon name={output.file.name} />}
          title={output.file.name}
          onClick={() => void open(output.file)}
        />
      ))}
      {outputs.length > OUTPUT_PREVIEW ? (
        <FoldRow indent={false} open={showAll} onClick={toggleAll} label={showAll ? t('bots.glance.showLess') : t('bots.glance.showMore')} />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------- 近期任务与 PR：只投影已有任务、归属及未读缓存。
function Activity({ bot, onClose }: { bot: BotChatIdentity; onClose(): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessions: local } = useCCSessions({ includeArchived: 'all' });
  const remote = useRemoteProjectSessions();
  const creators = useTaskCreatorIndex();
  const cloud = useCompanionCloud();
  const cindyIds = useRemoteCindyIds();
  const key = taskCreatorFilterKey(cindyIds.has(bot.id) ? { ...bot, templateId: 'cindy' } : bot, cloud);
  const remoteBots = useRemoteBots();
  const hostsKey = JSON.stringify([...new Map(remoteBots.filter(row => row.online &&
    taskCreatorFilterKey(cindyIds.has(row.id) ? { ...row, templateId: 'cindy' } : row, cloud) === key)
    .map(row => [row.deviceId, row.deviceName])).entries()]);
  useEffect(() => {
    // Archived remote tasks are lazily loaded by the sidebar; glance needs both buckets.
    for (const [id, name] of JSON.parse(hostsKey) as Array<[string, string]>) {
      for (const status of ['active', 'archived'] as const)
        void refreshRemoteDeviceSessions(id, name, { status, coalescingMode: 'weak' });
    }
  }, [hostsKey]);
  const tasks = useMemo(() => [...local, ...remote]
    .filter(task => task.id !== bot.sessionId && task.orcaRole !== 'worker'
      && (task.status === 'active' || task.status === 'archived')
      && matchesTaskCreators(task, [key], creators))
    .sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a)).slice(0, OUTPUT_LIMIT), [local, remote, creators, key, bot.sessionId]);
  const ids = useMemo(() => tasks.map(task => task.id), [tasks]);
  const { registerPrConsumer } = usePrActions();
  useEffect(() => {
    const stops = tasks.map(task => registerPrConsumer(task.id, task.deviceLinkDeviceId));
    return () => stops.forEach(stop => stop());
  }, [tasks, registerPrConsumer]);
  const refs = usePrRefsForSessions(ids);
  const prs = useMemo(() => {
    const unique = new Map<string, SessionPrRef>();
    for (const ref of [...refs].sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
      if (!unique.has(prStatusKey(ref))) unique.set(prStatusKey(ref), ref);
    }
    return [...unique.values()];
  }, [refs]);
  const [allTasks, toggleTasks] = useToggle();
  const openTask = async (task: Session) => {
    if (task.deviceLinkDeviceId) remoteProjectsStore.pinSessionOrigin(task.deviceLinkDeviceId, task.id);
    onClose();
    navigate(await resolveSessionRoute(task.id));
  };
  return <>
    {tasks.length > 0 ? <Section label={t('bots.glance.recentTasks')}>
      {(allTasks ? tasks : tasks.slice(0, TASK_PREVIEW)).map(task => <RecentTask key={task.id} task={task} onOpen={() => void openTask(task)} />)}
      {tasks.length > TASK_PREVIEW ? <FoldRow indent open={allTasks} onClick={toggleTasks} label={t(allTasks ? 'bots.glance.showLess' : 'bots.glance.showMore')} /> : null}
    </Section> : null}
    <Outputs sessionId={bot.sessionId ?? ''} botId={bot.id} onClose={onClose} prs={prs} />
  </>;
}

function RecentTask({ task, onOpen }: { task: Session; onOpen(): void }) {
  const attention = useSessionAttentionKind(task.id);
  const { t } = useTranslation();
  return <Row testId="bot-glance-task" icon={<MessageCircle size={16} />} title={task.title}
    onClick={onOpen}
    trailing={attention === 'done' ? <span className="flex items-center" role="img" aria-label={t('bots.glance.unread')}><AttentionDot tone="done" /></span> : undefined} />;
}

function PrOutput({ pr }: { pr: SessionPrRef }) {
  const { statuses, successfulStatuses } = usePrStatuses(pr.sessionId);
  const result = statuses.get(prStatusKey(pr));
  const status = result?.ok ? result : successfulStatuses.get(prStatusKey(pr));
  const kind = status?.ok ? status.status : null;
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  return <Row testId="bot-glance-pr" title={(status?.ok ? status.title?.trim() : undefined) || `${pr.owner}/${pr.repo}`}
    icon={<Icon size={16} style={{ color: kind ? PR_STATUS_COLOR[kind] : 'var(--text-tertiary)' }} />}
    onClick={() => void window.electronAPI.openExternal(sessionPrUrl(pr))} />;
}

// ---------------------------------------------------------------- 入口

export function BotGlanceButton({ bot, cloudHome }: { bot: BotChatIdentity; cloudHome: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const homeSwitch = useCompanionHomeSwitch({ id: bot.id, name: bot.name }, 'toast');
  const sessionId = bot.sessionId ?? '';
  const host = useMemo<GlanceTodoHost>(() => ({ botId: bot.id, deviceId: bot.deviceId }), [bot.deviceId, bot.id]);
  const todos = useGlanceTodos(host, Boolean(sessionId));
  const due = dueTodos(todos.todos);
  const [unseen, setUnseen] = useState(false);
  const dueSignature = due.map((todo) => `${todo.id}:${todo.revision}`).join('|');
  useEffect(() => {
    setUnseen(hasUnseenDue(bot.id, due));
    // 到期集合变化时重新判断入口红点。
  }, [bot.id, dueSignature]);
  if (!sessionId) return null;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      void todos.refresh();
      markDueSeen(bot.id, due);
      setUnseen(false);
    }
  };
  const label = unseen ? `${t('bots.glance.open', { name: bot.name })} · ${t('bots.glance.dueUnseen')}` : t('bots.glance.open', { name: bot.name });
  return (
    <>
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="bot-glance-button"
          aria-label={label}
          title={t('bots.glance.open', { name: bot.name })}
          className={cn(
            'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            open && 'bg-[var(--surface-hover)] text-[var(--text-primary)]',
          )}
          style={WINDOW_NO_DRAG_STYLE}
        >
          <LayoutGrid size={15} />
          {unseen ? <TodoDueDot className="absolute right-1 top-1" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={12}
        data-testid="bot-glance-popover"
        aria-label={t('bots.glance.open', { name: bot.name })}
        className="w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto p-0"
        style={{ maxHeight: 'var(--radix-popover-content-available-height, calc(100dvh - 24px))', ...WINDOW_NO_DRAG_STYLE }}
      >
        <div className="flex items-center gap-3 px-4 pb-1 pt-3">
          <BotAvatar bot={bot} size="md" />
          <span className="min-w-0 truncate text-15 font-medium text-[var(--text-primary)]">{bot.name}</span>
        </div>
        <Section label={t('bots.glance.computers')} divided={false}>
          <Computers
            bot={bot}
            open={open}
            cloudHome={cloudHome}
            homeSwitch={homeSwitch}
            onClose={() => setOpen(false)}
          />
        </Section>
        <Todos host={host} sessionId={sessionId} todos={todos} onClose={() => setOpen(false)} />
        <Activity bot={bot} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
    {cloudHome ? <HomeSwitchConfirm bot={{ id: bot.id, name: bot.name }} state={homeSwitch} /> : null}
    </>
  );
}
