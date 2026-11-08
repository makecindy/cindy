/** Partner glance: existing computer controls, attributed tasks and outputs.
 * Task attention and PR state are read-only projections of the ordinary task list stores.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, LayoutGrid, Monitor, MessageCircle, GitPullRequest } from 'lucide-react';
import type { Routine } from '@cindy/maker-scheduler';
import { REMOTE_RESOURCE_CHANGED_CHANNEL, parseRemoteResourceChangedPayload } from '@cindy/device-link';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import { usePrActions, usePrRefsForSessions, usePrStatuses } from '@/contexts/PrRefsContext';
import { prStatusKey, sessionPrUrl, type SessionPrRef } from '@cindy/maker-shared';
import { PR_STATUS_ICON, prStatusColor } from '@/features/cc-agent/gitContextPrVisuals';
import { sessionActivityMs } from '@/features/cc-agent/lib/dateSessionGrouping';
import { AutomationTimerIcon } from '@/features/cc-agent/sidebar/AutomationTimerIcon';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { matchesTaskCreators, useTaskCreatorIndex } from './botFollowScopes';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore, useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
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
import { useRemoteBots, useRemoteCindyIds } from './useRemoteBots';
import { invokeBotSettings } from './remoteBotSettingsClient';
import { TODO_CHECK_ROUTINE_PREFIX } from '../../../shared/botAutonomy';

/** 每块先列几条，其余收进「显示更多」。 */
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

/** 只读伙伴所在电脑的规则；打开近况才订阅，不等待第一次运行生成任务。 */
function useGlanceRoutines(botId: string, deviceId?: string) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    let request = 0;
    setRoutines([]);
    setFailed(false);
    const load = () => {
      const current = ++request;
      const owner = getDataOwnerGeneration();
      void (deviceId
        ? invokeBotSettings<Routine[]>(deviceId, 'routines.list', botId)
        : window.electronAPI.routines.list(botId))
        .then(items => {
          if (!alive || current !== request || !isDataOwnerGenerationCurrent(owner)) return;
          // 内置跟进、学习和每天查待办已有各自入口，不重复占近期任务。
          setRoutines(items.filter(item => !item.builtin && !item.id.startsWith(TODO_CHECK_ROUTINE_PREFIX)));
          setFailed(false);
        })
        .catch(() => {
          if (alive && current === request && isDataOwnerGenerationCurrent(owner)) setFailed(true);
        });
    };
    load();
    const off = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
          if (push.deviceId !== deviceId || push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL
            || !isDeviceLinkRemotePushCurrent(push, stamp)) return;
          if (parseRemoteResourceChangedPayload(push.payload)?.collectionId === 'routines') load();
        })
      : window.electronAPI.routines.onChanged(load);
    return () => { alive = false; off(); };
  }, [botId, deviceId, reload]);
  return { routines, failed, retry: () => setReload(value => value + 1) };
}

// ---------------------------------------------------------------- 近期任务（含未运行的例行任务）与 PR。
function Activity({ bot, onClose }: { bot: BotChatIdentity; onClose(): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { routines, failed, retry } = useGlanceRoutines(bot.id, bot.deviceId);
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
    .sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a)), [local, remote, creators, key, bot.sessionId]);
  // PR discovery keeps its original budget; activity groups all runs before applying its limit.
  const prTasks = useMemo(() => tasks.slice(0, OUTPUT_LIMIT), [tasks]);
  const ids = useMemo(() => prTasks.map(task => task.id), [prTasks]);
  const { registerPrConsumer } = usePrActions();
  useEffect(() => {
    const stops = prTasks.map(task => registerPrConsumer(task.id, task.deviceLinkDeviceId));
    return () => stops.forEach(stop => stop());
  }, [prTasks, registerPrConsumer]);
  const refs = usePrRefsForSessions(ids);
  const prs = useMemo(() => {
    const unique = new Map<string, SessionPrRef>();
    for (const ref of [...refs].sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
      if (!unique.has(prStatusKey(ref))) unique.set(prStatusKey(ref), ref);
    }
    return [...unique.values()];
  }, [refs]);
  const [allTasks, toggleTasks] = useToggle();
  const entries = useMemo(() => {
    const latest = new Map<string, Session>();
    const routineIds = new Set(routines.map(routine => routine.id));
    const ordinary = tasks.filter(task => {
      const companion = task.companion;
      if ((task.deviceLinkDeviceId ?? undefined) !== bot.deviceId || companion?.id !== bot.id
        || companion.role !== 'routine' || !companion.routineId || !routineIds.has(companion.routineId)) return true;
      if (!latest.has(companion.routineId)) latest.set(companion.routineId, task);
      return false;
    }).map(task => ({ key: `task:${task.deviceLinkDeviceId ?? ''}:${task.id}`, task, routine: null, at: sessionActivityMs(task) }));
    return [...ordinary, ...routines.map(routine => {
      const task = latest.get(routine.id);
      return { key: `routine:${routine.id}`, routine, task, at: task ? sessionActivityMs(task) : routine.createdAt };
    })].sort((a, b) => b.at - a.at).slice(0, OUTPUT_LIMIT);
  }, [tasks, routines, bot.id, bot.deviceId]);
  const openRoutines = () => {
    onClose();
    const base = bot.deviceId ? `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}` : `/bots/${encodeURIComponent(bot.id)}`;
    navigate(`${base}?settings=1&settingsPage=routines`);
  };
  const openTask = async (task: Session) => {
    if (task.deviceLinkDeviceId) remoteProjectsStore.pinSessionOrigin(task.deviceLinkDeviceId, task.id);
    onClose();
    navigate(await resolveSessionRoute(task.id));
  };
  return <>
    {entries.length > 0 || failed ? <Section label={t('bots.glance.recentTasks')}>
      {(allTasks ? entries : entries.slice(0, TASK_PREVIEW)).map(entry => entry.routine
        ? <RecentTask key={entry.key} task={entry.task} routine={entry.routine} onOpen={openRoutines} />
        : <RecentTask key={entry.key} task={entry.task!} onOpen={() => void openTask(entry.task!)} />)}
      {failed ? <Row testId="bot-glance-routines-retry" icon={<CircleAlert size={16} />} title={t('routines.title')} trailing={t('commonUi.retry')} onClick={retry} /> : null}
      {entries.length > TASK_PREVIEW ? <FoldRow indent open={allTasks} onClick={toggleTasks} label={t(allTasks ? 'bots.glance.showLess' : 'bots.glance.showMore')} /> : null}
    </Section> : null}
    <Outputs sessionId={bot.sessionId ?? ''} botId={bot.id} onClose={onClose} prs={prs} />
  </>;
}

function RecentTask({ task, routine, onOpen }: { task?: Session; routine?: Routine; onOpen(): void }) {
  const attention = useSessionAttentionKind(task?.id ?? '');
  const { t } = useTranslation();
  const automatic = routine || task?.companion?.role === 'routine' || task?.source === 'scheduler';
  return <Row testId="bot-glance-task" icon={automatic
    ? <span role="img" aria-label={t('routines.title')}>
        <AutomationTimerIcon size={16} className="size-5" paused={routine?.enabled === false} running={routine?.activity === 'running'} />
      </span>
    : <MessageCircle size={16} />} title={routine?.name ?? task?.title ?? ''}
    onClick={onOpen}
    trailing={routine?.enabled === false || attention === 'done' ? <>{routine?.enabled === false ? <span>{t('routines.paused')}</span> : null}
      {attention === 'done' ? <span className="flex items-center" role="img" aria-label={t('bots.glance.unread')}><AttentionDot tone="done" /></span> : null}</> : undefined} />;
}

function PrOutput({ pr }: { pr: SessionPrRef }) {
  const { statuses, successfulStatuses } = usePrStatuses(pr.sessionId);
  const result = statuses.get(prStatusKey(pr));
  const status = result?.ok ? result : successfulStatuses.get(prStatusKey(pr));
  const kind = status?.ok ? status.status : null;
  const Icon = kind ? PR_STATUS_ICON[kind] : GitPullRequest;
  return (
    <Row
      testId="bot-glance-pr"
      title={(status?.ok ? status.title?.trim() : undefined) || `${pr.owner}/${pr.repo}`}
      icon={
        <Icon
          size={16}
          style={{ color: prStatusColor(kind, status?.ok ? status.conflicts : null) }}
        />
      }
      onClick={() => void window.electronAPI.openExternal(sessionPrUrl(pr))}
    />
  );
}

// ---------------------------------------------------------------- 入口

export function BotGlanceButton({ bot, cloudHome }: { bot: BotChatIdentity; cloudHome: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const homeSwitch = useCompanionHomeSwitch({ id: bot.id, name: bot.name }, 'toast');
  const sessionId = bot.sessionId ?? '';
  if (!sessionId) return null;

  const label = t('bots.glance.open', { name: bot.name });
  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="bot-glance-button"
          aria-label={label}
          title={label}
          className={cn(
            'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            open && 'bg-[var(--surface-hover)] text-[var(--text-primary)]',
          )}
          style={WINDOW_NO_DRAG_STYLE}
        >
          <LayoutGrid size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={12}
        data-testid="bot-glance-popover"
        aria-label={label}
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
        <Activity bot={bot} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
    {cloudHome ? <HomeSwitchConfirm bot={{ id: bot.id, name: bot.name }} state={homeSwitch} /> : null}
    </>
  );
}
