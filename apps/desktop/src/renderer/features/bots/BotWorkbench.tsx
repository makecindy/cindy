import { BotTodoList } from './BotTodoList';
import { useWorkbenchSessionPages } from './useWorkbenchSessionPages';
import { useWorkbenchSessionActions } from './useWorkbenchSessionActions';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CirclePause,
  Clock3,
  FileText,
  Folder,
  FolderOpen,
  GitPullRequest,
  Lightbulb,
  Link2,
  MoreHorizontal,
  Plus,
  Square,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { useNavigate } from 'react-router-dom';
import type { Routine, RoutineRun } from '@cindy/maker-scheduler';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileTypeTile } from '@/components/ui/file-type-tile';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { collectCachedGeneratedFiles } from '@/components/chat/generatedFilesProjection';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { usePrActions, usePrRefsForSession, usePrStatuses } from '@/contexts/PrRefsContext';
import { useElementVisible } from '@/cindy-brain/ghostUnreadStore';
import type { Session } from '@/lib/ccAgent.types';
import type { PrStatusKind } from '@/lib/gitContext.types';
import { PR_STATUS_COLOR, PR_STATUS_ICON } from '@/features/cc-agent/gitContextPrVisuals';
import { useCCSessions } from '@/hooks/useCCSessions';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { useSessionAttentionKinds } from '@/lib/sessionAttentionStore';
import * as sessionService from '@/lib/sessionService';
import { emitRefresh } from '@/lib/sessionsBus';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { cronToHuman } from '@/features/scheduler/lib/cronToHuman';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { formatNextRun } from '@/features/scheduler/lib/formatters';
import { schedulesStore, useSchedulesSnapshot } from '@/features/scheduler/lib/schedulesStore';
import { openRoutinesTab } from '@/features/right-sidebar/lib/openRoutinesTab';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import {
  BOT_WORKBENCH_MAX_DIRECTORIES,
  isCaseInsensitivePlatform,
  parseWorkbenchTaskId,
  validateWorkbenchRef,
  type BotWorkbench as BotWorkbenchData,
  type WorkbenchTaskState,
  type WorkbenchTranscript,
} from '../../../shared/botWorkbench';
import { useBotDelegations } from './botDelegationLive';
import { isBotPrimaryGeneratedFile } from './botGeneratedArtifacts';
import { useBotProfiles } from './botStore';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import {
  buildWorkbenchProjectOptions,
  buildWorkbenchTiles,
  collectBotHiddenSessionIds,
  countUnjudgedCandidates,
  groupWorkbenchTiles,
  summarizeWorkbenchGroups,
  workbenchGroupHasFollowUp,
  tierWorkbenchProjectOptions,
  type ExternalSessionCandidate,
  type WorkbenchPathHints,
  type WorkbenchGroupKey,
  type WorkbenchProjectOption,
  type WorkbenchRoutineInput,
  type WorkbenchTile,
  type WorkbenchTileGroup,
} from './botWorkbenchProjection';

/**
 * 伙伴工作台(右侧栏的一个标签,只对本机伙伴主任务提供)。
 *
 * - 没接手项目时:从已有项目里选一个 →「交给<伙伴>」,两次点击完成接手。接手 = 理解:
 *   只记下目录、告诉伙伴一声,不批量导入;伙伴随后读候选、写判断,条目随之出现。
 * - 接手后一列到底:项目胶囊 → 一句汇总 → 任务列表 → 待办 → 产出。
 *   任务列表只有一套:伙伴负责的 Cindy 任务、PR / issue / 建议、项目自动化与伙伴的例行任务,
 *   按 等你 / 在做 / 待做 / 做完 分组(空组不出,做完默认折叠,已归档的负责任务按页接在做完最底部),
 *   每条两层:完整标题 + 伙伴的意见(末尾可带 PR 状态标)。
 * - 推进:待做 / 等你 两组的「跟进」以主人身份让伙伴在左边接着干;点一条在本标签内打开详情:
 *   伙伴的判断、正在做、产出、最近内容、补一句让伙伴接着做;任务操作收在条目的「…」里。
 */

/** 默认展示几格;「全部 N」展开其余。 */
const MAX_OUTPUTS = 4;

type ChatStore = typeof import('@/lib/makerChatStore').makerChatStore;
type ChatSnapshot = ReturnType<ChatStore['getSnapshot']>;
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 发送链路初始化较重;工作台挂载后再加载,不拖慢伙伴页首屏。 */
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

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function relativeTime(ms: number, language: string, now: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round((ms - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

function elapsed(startedAtMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}

function listFormat(items: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** 伙伴自己的例行任务(含导入来的自动化)及最近一次运行。 */
function useBotRoutines(botId: string): WorkbenchRoutineInput[] {
  const [routines, setRoutines] = useState<WorkbenchRoutineInput[]>([]);
  useEffect(() => {
    const api = window.electronAPI?.routines;
    if (!api) return;
    let alive = true;
    let request = 0;
    const owner = getDataOwnerGeneration();
    const load = () => {
      const current = ++request;
      void api
        .list(botId)
        .then((items: Routine[]) =>
          Promise.all(
            items.map(async (routine): Promise<WorkbenchRoutineInput> => {
              const history: RoutineRun[] = await api.history(botId, routine.id).catch(() => []);
              const last = history[0];
              return {
                id: routine.id,
                name: routine.name,
                enabled: routine.enabled,
                ...(routine.activity ? { activity: routine.activity } : {}),
                triggers: routine.triggers,
                updatedAt: routine.updatedAt,
                lastRun: last
                  ? {
                      status: last.status,
                      createdAt: last.createdAt,
                      ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}),
                      ...(last.resultText ? { resultText: last.resultText } : {}),
                      ...(last.error ? { error: last.error } : {}),
                    }
                  : null,
              };
            }),
          ),
        )
        .then((rows) => {
          if (alive && current === request && isDataOwnerGenerationCurrent(owner)) setRoutines(rows);
        })
        .catch(() => {});
    };
    load();
    const off = api.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [botId]);
  return routines;
}

const EMPTY_WORKBENCH: BotWorkbenchData = { directories: [], tasks: {} };

function useWorkbenchData(botId: string): BotWorkbenchData | null {
  const [data, setData] = useState<BotWorkbenchData | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.localDb?.bots?.workbench;
    if (!api) {
      setData(EMPTY_WORKBENCH);
      return;
    }
    let alive = true;
    let request = 0;
    const load = () => {
      const seq = ++request;
      const owner = getDataOwnerGeneration();
      void api
        .get(botId)
        .then((next) => {
          if (alive && seq === request && isDataOwnerGenerationCurrent(owner)) {
            setData(next ? { directories: next.directories ?? [], tasks: next.tasks ?? {}, responsibleSessionIds: next.responsibleSessionIds ?? [] } : EMPTY_WORKBENCH);
          }
        })
        .catch(() => {
          if (alive && seq === request && isDataOwnerGenerationCurrent(owner)) setData(EMPTY_WORKBENCH);
        });
    };
    setData(null);
    load();
    const off = window.electronAPI?.maker?.onBotWorkbenchChanged?.((payload) => {
      if (payload.botId !== botId) return;
      load();
      // 伙伴继续一条本机会话时会先把它导入;刷新任务列表,让新任务出现在格子里。
      emitRefresh();
    });
    const offDelegation = window.electronAPI?.maker?.onBotDelegationChanged?.(() => load());
    return () => {
      alive = false;
      off?.();
      offDelegation?.();
    };
  }, [botId]);
  return data;
}

/**
 * 已接手项目里近期的本机 Claude Code / Codex / Pi 会话(与伙伴工具同一份发现:按项目过滤、只看
 * 最近 30 天、只读头部找目录)。项目变化时读一次,不轮询,不导入。
 */
function useExternalCandidates(botId: string, projectKey: string): ExternalSessionCandidate[] {
  const [candidates, setCandidates] = useState<ExternalSessionCandidate[]>([]);
  useEffect(() => {
    const api = window.electronAPI?.localDb?.bots?.workbench;
    if (!projectKey || !api?.candidates) {
      setCandidates([]);
      return;
    }
    let alive = true;
    const owner = getDataOwnerGeneration();
    void api
      .candidates(botId)
      .then((result) => {
        if (alive && isDataOwnerGenerationCurrent(owner) && result.ok) setCandidates(result.candidates);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [botId, projectKey]);
  return candidates;
}

/** 以主人身份往伙伴主任务发一句话(交接、详情里的「补一句」都走这里)。 */
async function sendAsOwner(sessionId: string, text: string): Promise<boolean> {
  const owner = getDataOwnerGeneration();
  const [chatStore, row] = await Promise.all([
    import('@/lib/makerChatStore').then((module) => module.makerChatStore),
    sessionService.get(sessionId),
  ]);
  if (!isDataOwnerGenerationCurrent(owner) || !row.workingDir) return false;
  return chatStore.sendMessage(sessionId, text, row.model, row.effort, row.permissionMode, row.workingDir);
}

export function BotWorkbench({ botId, sessionId }: { botId: string; sessionId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const botName = profiles.find((profile) => profile.id === botId)?.name ?? '';
  const workbench = useWorkbenchData(botId);
  const { sessions } = useCCSessions({ includeArchived: 'active' });
  const delegations = useBotDelegations(sessionId);
  const activityMap = useAgentIslandActivityMap();
  const attentionKinds = useSessionAttentionKinds();
  const schedules = useSchedulesSnapshot();
  const routines = useBotRoutines(botId);
  const chatStore = useChatStore();
  const chat = useChatSnapshot(chatStore, sessionId);
  const caseInsensitive = isCaseInsensitivePlatform(window.electronAPI?.platform);
  const inSidebarWindow = isSidebarWindow();

  useEffect(() => {
    void schedulesStore.ensure().catch(() => {});
  }, []);

  const directories = useMemo(() => workbench?.directories ?? [], [workbench]);
  const judgments = useMemo(() => workbench?.tasks ?? {}, [workbench]);
  const projectDirs = useMemo(() => directories.map((dir) => dir.path), [directories]);
  const candidates = useExternalCandidates(botId, projectDirs.join('\n'));
  const [listRevision, setListRevision] = useState(0);
  const responsibleIds = useMemo(() => workbench?.responsibleSessionIds ?? [], [workbench]);
  const listScope = `${botId}:${projectDirs.join('\n')}:${listRevision}`;
  // 活跃与归档按同一责任 ID 集合分别有界读取;归档的接在「做完」最底部,按页加载。
  const activePages = useWorkbenchSessionPages(listScope, 'active', Boolean(workbench), responsibleIds);
  const archivedPages = useWorkbenchSessionPages(listScope, 'archived', Boolean(workbench), responsibleIds);
  const sessionRows = activePages.rows;
  const refreshList = useCallback(() => { setListRevision(value => value + 1); emitRefresh(); }, []);
  const actionRows = useMemo(() => [...activePages.rows, ...archivedPages.rows], [activePages.rows, archivedPages.rows]);
  const sessionActions = useWorkbenchSessionActions(actionRows, refreshList);

  const hiddenIds = useMemo(() => collectBotHiddenSessionIds(profiles), [profiles]);
  const erroredIds = useMemo(
    () => new Set([...attentionKinds].filter(([, kind]) => kind === 'error').map(([id]) => id)),
    [attentionKinds],
  );

  const tiles = useMemo(
    () =>
      buildWorkbenchTiles({
        sessions: sessionRows,
        archivedSessions: archivedPages.rows,
        responsibleSessionIds: responsibleIds,
        hiddenIds,
        projectDirs,
        caseInsensitive,
        delegations,
        activity: activityMap,
        erroredIds,
        schedules: schedules ?? [],
        routines,
        judgments,
        candidates,
      }),
    [
      sessionRows,
      archivedPages.rows,
      responsibleIds,
      hiddenIds,
      projectDirs,
      caseInsensitive,
      delegations,
      activityMap,
      erroredIds,
      schedules,
      routines,
      judgments,
      candidates,
    ],
  );

  // 伙伴正在读这些项目:还有本机外部会话没写判断,且伙伴主任务正在跑。
  const unjudged = useMemo(
    () => countUnjudgedCandidates({ projectDirs, caseInsensitive, candidates, judgments }),
    [projectDirs, caseInsensitive, candidates, judgments],
  );
  const understanding = unjudged > 0 && activityMap.get(sessionId)?.phase === 'running';
  // 打开详情时记下那一格;之后格子状态变了(甚至因为做完而不再上工作台)详情仍留在原处。
  const [detailOpened, setDetailOpened] = useState<WorkbenchTile | null>(null);
  const detailTile = detailOpened ? (tiles.find((tile) => tile.key === detailOpened.key) ?? detailOpened) : null;

  const [adding, setAdding] = useState(false);
  const picking = workbench !== null && (directories.length === 0 || adding);
  // 还没接手项目(或正在加项目)时,伙伴负责的任务与例行任务照常列出;项目来的条目等接手后再出。
  const listTiles = useMemo(
    () => (picking ? tiles.filter((tile) => tile.type === 'routine' || tile.type === 'session') : tiles),
    [picking, tiles],
  );
  const groups = useMemo(() => groupWorkbenchTiles(listTiles), [listTiles]);
  const now = useNow(tiles.some((tile) => tile.state === 'running' && tile.startedAtMs !== null));

  const openTile = useCallback(
    (tile: WorkbenchTile) => {
      if (tile.type === 'session' || tile.type === 'external' || tile.type === 'item') {
        // 任务在本标签内打开详情,不换路由、不跳任务页;归档的也只是看,不恢复。
        setDetailOpened(tile);
      } else if (tile.type === 'schedule') {
        if (!inSidebarWindow) navigate(scheduleFocusPath(tile.id));
      } else {
        void openRoutinesTab(sessionId, botId);
      }
    },
    [botId, inSidebarWindow, navigate, sessionId],
  );

  // 跟进:以主人身份往伙伴聊天发「跟进「<标题>」」,由伙伴在左边接着干。按钮转圈直到伙伴主任务
  // 开始运行(或已在运行、消息排进队列);条目怎么移动交给真实状态,不做乐观更新。
  const botPhase = activityMap.get(sessionId)?.phase ?? null;
  const [following, setFollowing] = useState<{ key: string; sentWhileRunning: boolean } | null>(null);
  const followingKey = following?.key ?? null;
  useEffect(() => {
    if (!following) return;
    if (botPhase === 'running' && !following.sentWhileRunning) setFollowing(null);
    if (botPhase !== 'running' && following.sentWhileRunning) setFollowing((value) => value && { ...value, sentWhileRunning: false });
  }, [botPhase, following]);
  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(() => setFollowing(null), 30_000);
    return () => clearTimeout(timer);
  }, [following?.key]);
  const followUp = useCallback(
    (tile: WorkbenchTile) => {
      if (following) return;
      const title = tile.title || t('bots.workbench.untitled');
      setFollowing({ key: tile.key, sentWhileRunning: botPhase === 'running' });
      void sendAsOwner(sessionId, t('bots.workbench.followUp.message', { title }))
        .then((sent) => {
          if (sent) return;
          setFollowing(null);
          toast.error(t('bots.workbench.sendFailed', { name: botName }));
        })
        .catch(() => {
          setFollowing(null);
          toast.error(t('bots.workbench.sendFailed', { name: botName }));
        });
    },
    [botName, botPhase, following, sessionId, t],
  );

  const [chatWorkingDir, setChatWorkingDir] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void sessionService
      .get(sessionId)
      .then((row) => {
        if (alive) setChatWorkingDir(row.workingDir ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // 产出:后台任务交回的文件在前(明确交付的成果),再补主任务对话里伙伴新建的文件。
  const outputs = useMemo(() => {
    const out: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();
    const push = (file: { path: string; name: string }) => {
      if (out.length >= MAX_OUTPUTS_LISTED || seen.has(file.path)) return;
      seen.add(file.path);
      out.push(file);
    };
    for (const task of [...delegations].sort((a, b) => b.createdAt - a.createdAt)) {
      for (const file of delegationOutputs(task)) push(file);
    }
    if (chat && chatWorkingDir && chat.messages.length > 0) {
      const files = collectCachedGeneratedFiles(chat.messages, chatWorkingDir);
      for (let index = files.length - 1; index >= 0; index -= 1) {
        const file = files[index];
        if (file.source !== 'tool' || file.ready === false) continue;
        if (isBotPrimaryGeneratedFile(file, chatWorkingDir)) push({ path: file.path, name: file.name });
      }
    }
    return out;
  }, [chat, chatWorkingDir, delegations]);

  if (workbench === null) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner size={16} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
      </div>
    );
  }

  if (detailTile && (detailTile.type === 'session' || detailTile.type === 'external' || detailTile.type === 'item')) {
    const delegation = detailTile.type === 'session'
      ? delegations.find((task) => task.childSessionId === detailTile.id) ?? null
      : null;
    return (
      <TaskDetail
        botId={botId}
        botName={botName}
        botSessionId={sessionId}
        tile={detailTile}
        now={now}
        canNavigate={!inSidebarWindow}
        projectDirs={projectDirs}
        caseInsensitive={caseInsensitive}
        outputs={delegation ? delegationOutputs(delegation) : []}
        onBack={() => setDetailOpened(null)}
      />
    );
  }

  // 最近交给伙伴的项目排在最前,正在了解的通常就是它。
  const understandingProject = understanding ? (directories[0]?.name ?? '') : '';
  const pageControl = (page: typeof activePages, showLoading: boolean) =>
    page.loading
      ? showLoading
        ? <Spinner size={14} className="my-2 ml-2" role="status" aria-label={t('ccAgent.common.loading')} />
        : null
      : page.error || page.hasMore
        ? (
            <Button variant="secondary" size="sm" tone="quiet" compact className="my-1" onClick={() => void page.load()}>
              {t(page.error ? 'commonUi.retry' : 'settings.contacts.list.loadMore')}
            </Button>
          )
        : null;
  const rowMenu = (tile: WorkbenchTile) => {
    const row = tile.type === 'session' ? sessionActions.byId.get(tile.id) : undefined;
    return row ? <SessionRowMenu row={row} canNavigate={!inSidebarWindow} actions={sessionActions} /> : null;
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden bg-[var(--surface)]">
      {picking ? (
        <ProjectPicker
          botId={botId}
          botName={botName}
          sessionId={sessionId}
          sessions={sessions}
          hiddenIds={hiddenIds}
          schedules={schedules ?? []}
          excludeDirs={projectDirs}
          onCancel={directories.length > 0 ? () => setAdding(false) : undefined}
          onHandedOver={() => setAdding(false)}
        />
      ) : (
        <>
          <ProjectCapsules
            botId={botId}
            botName={botName}
            directories={directories}
            onAdd={directories.length < BOT_WORKBENCH_MAX_DIRECTORIES ? () => setAdding(true) : undefined}
          />
          {understanding ? (
            <p className="flex items-center gap-1.5 px-5 pt-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
              <Spinner size={12} aria-hidden className="shrink-0" />
              <span className="min-w-0 truncate">
                {t('bots.workbench.understanding', { name: botName, project: understandingProject })}
              </span>
            </p>
          ) : null}
          <WorkbenchSummary groups={groups} />
        </>
      )}

      <TaskGroups
        groups={groups}
        now={now}
        language={i18n.language}
        followingKey={followingKey}
        onOpen={openTile}
        onFollowUp={followUp}
        rowMenu={rowMenu}
        archivedFooter={pageControl(archivedPages, true)}
      />
      {/* No「做完」group yet (nothing finished, no archived row loaded): a failed archived
          read still needs its retry somewhere, or it could never be reloaded. */}
      {archivedPages.error && !groups.some((group) => group.key === 'done') ? (
        <div className="px-5">{pageControl(archivedPages, false)}</div>
      ) : null}
      {activePages.error || (activePages.hasMore && !activePages.loading) ? (
        <div className="px-5">{pageControl(activePages, false)}</div>
      ) : null}

      <BotTodoList botId={botId} />

      {!picking ? <WorkbenchOutputs outputs={outputs} botName={botName} /> : null}
    </div>
  );
}

/** 产出区最多收集多少个文件(默认只显示前 4 个,「全部」展开其余)。 */
const MAX_OUTPUTS_LISTED = 60;

type DelegationLike = ReturnType<typeof useBotDelegations>[number];

/** 一件后台任务交回的主要文件(已删除的不算)。 */
function delegationOutputs(task: DelegationLike): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  for (const artifact of task.artifacts) {
    if (!artifact.absolutePath || artifact.status === 'deleted') continue;
    const name = artifact.absolutePath.split(/[\\/]/).pop() ?? artifact.path;
    if (isBotPrimaryGeneratedFile({ path: artifact.absolutePath, name, source: 'tool' })) {
      out.push({ path: artifact.absolutePath, name });
    }
  }
  return out;
}

/** 胶囊下面的一句汇总:「1 件等你 · 2 件在做 · 4 件待做」,为 0 的不说。 */
function WorkbenchSummary({ groups }: { groups: readonly WorkbenchTileGroup[] }) {
  const { t } = useTranslation();
  const counts = summarizeWorkbenchGroups(groups);
  const parts = (['waiting', 'running', 'todo'] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => t(`bots.workbench.summary.${key}`, { count: counts[key] }));
  if (parts.length === 0) return null;
  return <p className="px-5 pt-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]">{parts.join(' · ')}</p>;
}

function WorkbenchOutputs({ outputs, botName }: { outputs: ReadonlyArray<{ path: string; name: string }>; botName: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? outputs : outputs.slice(0, MAX_OUTPUTS);
  return (
    <section className="px-5 pb-5" aria-label={t('bots.workbench.outputs')}>
      <div className="mb-1.5 mt-3.5 flex min-h-[22px] items-center gap-1.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
        <h3>{t('bots.workbench.outputs')}</h3>
        {outputs.length > 0 ? <span className="tabular-nums text-[var(--text-tertiary)]">{outputs.length}</span> : null}
        {outputs.length > MAX_OUTPUTS ? (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
            className="ml-auto flex h-6 items-center rounded-lg px-1.5 text-12 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {t(all ? 'bots.workbench.outputsLess' : 'bots.workbench.outputsAll')}
          </button>
        ) : null}
      </div>
      {outputs.length === 0 ? (
        <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t('bots.workbench.outputsEmpty', { name: botName })}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {shown.map((file) => (
            <button
              key={file.path}
              type="button"
              title={file.path}
              onClick={() => void window.electronAPI.openPath?.(file.path)}
              className="group flex min-w-0 flex-col items-center gap-1.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <span className="flex h-[52px] w-full items-center justify-center rounded-xl border border-[var(--border-default)] transition-colors group-hover:bg-[var(--surface-hover)]">
                <FileTypeTile name={file.name} />
              </span>
              <span className="w-full truncate text-center text-12 leading-4 text-[var(--text-secondary)]">
                {file.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── 空状态:把一个项目交给伙伴 ─────────────────────────────────────

type ScanState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      candidates: ExternalSessionCandidate[];
      gitRepoDirs: string[];
      pathHints: WorkbenchPathHints | null;
    }
  | { kind: 'failed' };

type ProjectOptionsInput = Parameters<typeof buildWorkbenchProjectOptions>[0];

function ProjectPicker({
  botId,
  botName,
  sessionId,
  sessions,
  hiddenIds,
  schedules,
  excludeDirs,
  onCancel,
  onHandedOver,
}: {
  botId: string;
  botName: string;
  sessionId: string;
  sessions: ProjectOptionsInput['sessions'];
  hiddenIds: ReadonlySet<string>;
  schedules: ProjectOptionsInput['schedules'];
  excludeDirs: readonly string[];
  onCancel?: () => void;
  onHandedOver: () => void;
}) {
  const { t, i18n } = useTranslation();
  const platform = window.electronAPI?.platform ?? '';
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  const [scan, setScan] = useState<ScanState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFolded, setShowFolded] = useState(false);
  const [now] = useState(() => Date.now());

  // 本机 Claude Code / Codex 的候选只在打开空状态时扫描一次(主进程带缓存与并发去重),不轮询。
  useEffect(() => {
    const api = window.electronAPI?.localDb?.sessionImport;
    if (!api) {
      setScan({ kind: 'ready', candidates: [], gitRepoDirs: [], pathHints: null });
      return;
    }
    let alive = true;
    const owner = getDataOwnerGeneration();
    void api
      .scan()
      .then((result) => {
        if (!alive || !isDataOwnerGenerationCurrent(owner)) return;
        setScan({
          kind: 'ready',
          candidates: result.candidates
            .filter((item) => item.workspaceKind === 'project')
            .map((item) => ({
              source: item.source,
              id: item.id,
              projectDir: item.projectDir,
              updatedAt: item.updatedAt,
              archived: item.archived,
            })),
          gitRepoDirs: result.gitRepoDirs ?? [],
          pathHints: result.pathHints ?? null,
        });
      })
      .catch(() => {
        if (alive) setScan({ kind: 'failed' });
      });
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo(() => (scan.kind === 'ready' ? scan.candidates : []), [scan]);
  const gitRepoDirs = useMemo(() => (scan.kind === 'ready' ? scan.gitRepoDirs : []), [scan]);
  const pathHints = scan.kind === 'ready' ? scan.pathHints : null;
  const options = useMemo(
    () =>
      buildWorkbenchProjectOptions({
        sessions,
        hiddenIds,
        schedules,
        candidates,
        gitRepoDirs,
        localPlatform: platform,
        caseInsensitive,
        excludeDirs,
      }),
    [sessions, hiddenIds, schedules, candidates, gitRepoDirs, platform, caseInsensitive, excludeDirs],
  );
  // 不像用户项目的目录直接不列;像临时目录、只有零星会话的折叠到「还有 N 个」里。
  const tiers = useMemo(
    () => tierWorkbenchProjectOptions(options, { hints: pathHints, caseInsensitive, now }),
    [options, pathHints, caseInsensitive, now],
  );
  const visible = showFolded ? [...tiers.primary, ...tiers.folded] : tiers.primary;
  const listed = tiers.primary.length + tiers.folded.length;
  const chosen = options.find((option) => option.dir === selected) ?? null;

  const handOver = useCallback(
    async (dir: string, name: string) => {
      const api = window.electronAPI?.localDb?.bots?.workbench;
      if (busy || !api) return;
      setBusy(true);
      const owner = getDataOwnerGeneration();
      try {
        // 1. 记下这个项目:这一次点击就是主人对该项目任务的授权。不导入任何会话。
        const added = await api.addDirectory(botId, dir).catch(() => null);
        if (!added?.ok) {
          toast.error(
            added?.errorCode === 'TOO_MANY'
              ? t('bots.workbench.tooManyDirs', { name: botName, count: BOT_WORKBENCH_MAX_DIRECTORIES })
              : t('bots.workbench.dirUnavailable'),
          );
          return;
        }
        onHandedOver();
        if (!isDataOwnerGenerationCurrent(owner)) return;
        // 2. 以主人身份告诉伙伴一声;怎么接手写在伙伴的工具说明里,用户可见的消息只说人话。
        const sent = await sendAsOwner(sessionId, t('bots.workbench.handoverMessage', { project: name }));
        if (!sent) toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } catch {
        toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } finally {
        setBusy(false);
      }
    },
    [botId, botName, busy, onHandedOver, sessionId, t],
  );

  const pickFolder = useCallback(async () => {
    const picked = await window.electronAPI.dialog?.showOpenDirectory();
    const dirPath = picked?.success ? picked.path : null;
    if (!dirPath) return;
    const name = dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath;
    await handOver(dirPath, name);
  }, [handOver]);

  const grant = chosen ? grantText(chosen, botName, i18n.language, t) : null;

  return (
    <section className="px-5 pb-5 pt-3">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-18 font-medium leading-[1.44] text-[var(--text-primary)]">
          {t('bots.workbench.emptyTitle', { name: botName })}
        </h2>
        {onCancel ? (
          <Button variant="secondary" size="sm" tone="quiet" compact onClick={onCancel}>
            {t('bots.workbench.cancelAdd')}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-13 leading-5 text-[var(--text-tertiary)]">
        {t('bots.workbench.emptyDescription', { name: botName })}
      </p>
      <div
        className="mt-4 flex flex-col gap-2"
        role="radiogroup"
        aria-label={t('bots.workbench.emptyTitle', { name: botName })}
      >
        {visible.map((option) => (
          <button
            key={option.dir}
            type="button"
            role="radio"
            aria-checked={selected === option.dir}
            disabled={busy}
            title={option.dir}
            onClick={() => setSelected(option.dir)}
            className={cn(
              'flex h-[68px] w-full items-center gap-3 rounded-xl border px-3.5 text-left outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-60',
              selected === option.dir
                ? 'border-[var(--text-tertiary)] bg-[var(--surface-hover)]'
                : 'border-[var(--border-default)] enabled:hover:bg-[var(--surface-hover)]',
            )}
          >
            <Folder size={18} strokeWidth={1.8} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-14 font-medium leading-[1.57] text-[var(--text-primary)]">{option.name}</span>
              <span className="truncate text-12 leading-[1.5] text-[var(--text-tertiary)]">
                {projectCounts(option, t)}
              </span>
            </span>
            <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
              {relativeTime(option.latestActivityMs, i18n.language, now)}
            </span>
          </button>
        ))}
        {tiers.folded.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            tone="quiet"
            compact
            className="-ml-3 self-start"
            aria-expanded={showFolded}
            onClick={() => setShowFolded((value) => !value)}
          >
            {showFolded
              ? t('bots.workbench.hideMoreProjects')
              : t('bots.workbench.moreProjects', { count: tiers.folded.length })}
          </Button>
        ) : null}
        {scan.kind === 'loading' && listed === 0 ? (
          <div className="flex items-center gap-2 py-2 text-12 text-[var(--text-tertiary)]">
            <Spinner size={14} aria-hidden />
            {t('bots.workbench.scanning')}
          </div>
        ) : null}
        {scan.kind !== 'loading' && listed === 0 ? (
          <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {t('bots.workbench.noProjects', { name: botName })}
          </p>
        ) : null}
      </div>
      {chosen && grant ? (
        <div className="mt-4">
          <p className="text-13 leading-5 text-[var(--text-secondary)]">{grant}</p>
          <Button
            variant="cta"
            size="lg"
            className="mt-3"
            loading={busy}
            disabled={busy}
            onClick={() => void handOver(chosen.dir, chosen.name)}
          >
            {t('bots.workbench.handOver', { name: botName })}
          </Button>
        </div>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        tone="quiet"
        compact
        className="-ml-3 mt-2.5"
        disabled={busy}
        onClick={() => void pickFolder()}
      >
        <FolderOpen size={14} aria-hidden />
        {t('bots.workbench.pickFolder')}
      </Button>
    </section>
  );
}

function projectCounts(option: WorkbenchProjectOption, t: Translate): string {
  const external = option.claudeCount + option.codexCount > 0;
  const parts: string[] = external
    ? [
        option.taskCount > 0 ? t('bots.workbench.sourceCindy', { count: option.taskCount }) : '',
        option.claudeCount > 0 ? t('bots.workbench.sourceClaude', { count: option.claudeCount }) : '',
        option.codexCount > 0 ? t('bots.workbench.sourceCodex', { count: option.codexCount }) : '',
      ]
    : [t('bots.workbench.projectTasks', { count: option.taskCount })];
  if (option.automationCount > 0) parts.push(t('bots.workbench.projectAutomations', { count: option.automationCount }));
  return parts.filter(Boolean).join(' · ');
}

function grantText(option: WorkbenchProjectOption, botName: string, language: string, t: Translate): string {
  const claude = option.claudeCount;
  const codex = option.codexCount;
  const items = [
    option.taskCount > 0
      ? t(claude + codex > 0 ? 'bots.workbench.grantCindy' : 'bots.workbench.grantTasks', { count: option.taskCount })
      : '',
    claude > 0 ? t('bots.workbench.grantClaude', { count: claude }) : '',
    codex > 0 ? t('bots.workbench.grantCodex', { count: codex }) : '',
    option.automationCount > 0 ? t('bots.workbench.grantAutomations', { count: option.automationCount }) : '',
  ].filter(Boolean);
  const scope = items.length > 0 ? listFormat(items, language) : t('bots.workbench.grantEverything');
  return t('bots.workbench.grant', { name: botName, project: option.name, scope });
}

// ─── 已接手:项目胶囊 + 汇总 ─────────────────────────────────────────

const ICON_BUTTON_CLASS =
  'flex shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function ProjectCapsules({
  botId,
  botName,
  directories,
  onAdd,
}: {
  botId: string;
  botName: string;
  directories: BotWorkbenchData['directories'];
  onAdd?: () => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(
    (dirPath: string, deviceId?: string) => {
      void window.electronAPI?.localDb?.bots?.workbench?.removeDirectory(botId, dirPath, deviceId).catch(() => {});
    },
    [botId],
  );
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
      {directories.map((dir) => (
        <span
          key={`${dir.deviceId ?? ''}:${dir.path}`}
          title={dir.deviceId ? dir.path : dir.exists ? dir.path : t('bots.workbench.dirMissing')}
          className={cn(
            'inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[var(--surface-chip)] pl-3 pr-1 text-13',
            dir.deviceId ? 'text-[var(--text-secondary)]' : dir.exists ? 'text-[var(--text-primary)]' : 'text-[var(--text-danger)]',
          )}
        >
          <Folder size={14} strokeWidth={1.8} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">{dir.name}</span>
          {dir.deviceId ? <DirectoryElsewhere deviceId={dir.deviceId} /> : null}
          <Tip text={t('bots.workbench.removeProject', { name: botName, project: dir.name })}>
            <button
              type="button"
              onClick={() => remove(dir.path, dir.deviceId)}
              aria-label={t('bots.workbench.removeProject', { name: botName, project: dir.name })}
              className={cn(ICON_BUTTON_CLASS, 'size-6 text-[var(--text-tertiary)]')}
            >
              <X size={12} aria-hidden />
            </button>
          </Tip>
        </span>
      ))}
      {onAdd ? (
        <Tip text={t('bots.workbench.addProject', { name: botName })}>
          <button
            type="button"
            onClick={onAdd}
            aria-label={t('bots.workbench.addProject', { name: botName })}
            className={cn(ICON_BUTTON_CLASS, 'size-8 border border-dashed border-[var(--text-tertiary)] text-[var(--text-tertiary)]')}
          >
            <Plus size={14} aria-hidden />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

// ─── 任务列表:单列、按四组、每条两层 ─────────────────────────────────

/** 「等你」第二层:状态 + 等的是什么(权限 / 提问 / 方案…,有具体内容时带上)。 */
function waitingText(tile: WorkbenchTile, t: Translate): string {
  const line = tile.line;
  if (tile.state === 'waiting') {
    const interaction = line.kind === 'waiting' ? line.interaction : null;
    const label = t(
      interaction === 'permission'
        ? 'bots.workbench.line.waitingPermission'
        : interaction === 'ask_user_question'
          ? 'bots.workbench.line.waitingQuestion'
          : interaction === 'plan_review'
            ? 'bots.workbench.line.waitingPlan'
            : interaction === 'plugin_setup' || interaction === 'input_handoff'
              ? 'bots.workbench.line.waitingAction'
              : 'bots.workbench.line.waiting',
    );
    const text = line.kind === 'waiting' ? line.text : null;
    return text ? t('bots.workbench.line.waitingFor', { label, text }) : label;
  }
  if (line.kind === 'failed') {
    const label = t('bots.workbench.line.failed');
    return line.text ? t('bots.workbench.line.waitingFor', { label, text: line.text }) : label;
  }
  if (line.kind === 'interrupted' || line.kind === 'errored') return t(`bots.workbench.line.${line.kind}`);
  return t('bots.workbench.line.errored');
}

/** 自动化的第二层:周期 + 下次运行(或已暂停 / 已停用)。 */
function automationLine(tile: WorkbenchTile, t: Translate, language: string, now: number): string | null {
  if (tile.type !== 'schedule' && tile.type !== 'routine') return null;
  const cycle =
    (tile.type === 'schedule' ? scheduleCycle(tile.schedule, t, language) : routineCycle(tile.triggers, t, language))
    ?? t('bots.workbench.kind.automationPlain');
  const line = tile.line;
  const extra =
    line.kind === 'next'
      ? formatNextRun(line.at, now, t as Parameters<typeof formatNextRun>[2])
      : line.kind === 'paused' || line.kind === 'disabled'
        ? t(`bots.workbench.line.${line.kind}`)
        : null;
  return extra ? `${cycle} · ${extra}` : cycle;
}

type RowNote = { text: string; accent?: string | null } | null;

/**
 * 第二层只写「伙伴的意见」:
 * - 等你:状态 + 等的是什么(伙伴另写了下一步时接在后面);
 * - 在做:当前动作(运行色)+ 用时;没有动作时「在做 · 用时」;
 * - 待做:伙伴写的下一步;没有时「排队中」/「没做完」/「聊过没下文」;
 * - 做完:不写;自动化写周期与下次运行,已归档的写「已归档」。
 * 来源与相对时间都不显示(在详情里)。
 */
function rowNote(tile: WorkbenchTile, group: WorkbenchGroupKey, t: Translate, language: string, now: number): RowNote {
  const next = 'next' in tile && tile.next ? tile.next : null;
  const automation = automationLine(tile, t, language, now);
  if (group === 'waiting') {
    const waiting = waitingText(tile, t);
    return { text: next ? `${waiting} · ${next}` : waiting };
  }
  if (group === 'running') {
    const time = tile.startedAtMs ? elapsed(tile.startedAtMs, now) : null;
    if (tile.line.kind === 'action') return { accent: tile.line.text, text: time ?? '' };
    if (automation && !time) return { text: `${t('bots.workbench.state.running')} · ${automation}` };
    return { text: time ? `${t('bots.workbench.state.running')} · ${time}` : t('bots.workbench.state.running') };
  }
  if (group === 'todo') {
    if (next) return { text: next };
    if (tile.state === 'queued') return { text: t('bots.workbench.line.queued') };
    if ('verdict' in tile && tile.verdict) return { text: t(`bots.workbench.verdict.${tile.verdict}`) };
    return automation ? { text: automation } : null;
  }
  if (tile.type === 'session' && tile.archived) return { text: t('ccAgent.sidebar.filterStatus.archived') };
  return automation ? { text: automation } : null;
}

/** 行首 16px 的状态字形:在做转圈、等你蓝点、待做空心圈、做完勾(自动化为时钟)。 */
function LeadGlyph({ tile, group }: { tile: WorkbenchTile; group: WorkbenchGroupKey }) {
  const { t } = useTranslation();
  const label = t(`bots.workbench.group.${group}`);
  let glyph: ReactNode;
  if (group === 'running') {
    glyph = <Spinner size={14} strokeWidth={2} role="img" aria-label={label} className="text-[var(--text-secondary)]" />;
  } else if (group === 'waiting') {
    glyph = <span role="img" aria-label={label} className="size-2 rounded-full bg-[var(--card-status-awaiting)]" />;
  } else if (group === 'todo') {
    glyph = (
      <span
        role="img"
        aria-label={tile.state === 'queued' ? t('bots.workbench.state.queued') : label}
        className={cn(
          'size-3.5 rounded-full border-[1.5px] border-[var(--text-tertiary)]',
          tile.state === 'queued' && 'border-dashed',
        )}
      />
    );
  } else {
    const automation = tile.type === 'schedule' || tile.type === 'routine';
    const Icon = automation ? Clock3 : CircleCheck;
    glyph = (
      <span role="img" aria-label={label} className="flex">
        <Icon
          size={14}
          strokeWidth={1.8}
          aria-hidden
          className={
            automation || (tile.type === 'session' && tile.archived)
              ? 'text-[var(--text-tertiary)]'
              : 'text-[var(--card-status-done)]'
          }
        />
      </span>
    );
  }
  return <span className="flex h-5 w-4 shrink-0 items-center justify-center">{glyph}</span>;
}

function TaskRow({
  tile,
  group,
  now,
  language,
  following,
  onOpen,
  onFollowUp,
  menu,
}: {
  tile: WorkbenchTile;
  group: WorkbenchGroupKey;
  now: number;
  language: string;
  /** 这一条刚点了「跟进」,在等伙伴开始干活。 */
  following: boolean;
  onOpen: (tile: WorkbenchTile) => void;
  onFollowUp?: (tile: WorkbenchTile) => void;
  /** 悬停才出现的「…」(Cindy 任务的打开 / 置顶 / 归档 / 删除)。 */
  menu?: ReactNode;
}) {
  const { t } = useTranslation();
  const title = tile.title || t('bots.workbench.untitled');
  const note = rowNote(tile, group, t, language, now);
  const { ref: observe, visible } = useElementVisible();
  const pr = useTilePr(tile, visible);
  return (
    <li
      ref={observe}
      data-workbench-row={tile.key}
      className="group -mx-2 flex min-w-0 items-start gap-1 rounded-lg transition-colors hover:bg-[var(--surface-hover)]"
    >
      <button
        type="button"
        onClick={() => onOpen(tile)}
        aria-label={t('bots.workbench.openTask', { title, state: t(`bots.workbench.group.${group}`) })}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg py-2 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <LeadGlyph tile={tile} group={group} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-3 text-13 leading-5 text-[var(--text-primary)] [overflow-wrap:anywhere]">
            {title}
          </span>
          {note || pr ? (
            <span className="mt-0.5 flex min-w-0 items-start gap-1.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {note ? (
                <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {note.accent ? <span className="text-[var(--status-bar-accent)]">{note.accent}</span> : null}
                  {note.accent && note.text ? ' · ' : null}
                  {note.text}
                </span>
              ) : null}
              {pr ? <PrTag pr={pr} /> : null}
            </span>
          ) : null}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 pr-1.5 pt-1.5">
        {menu}
        {onFollowUp ? (
          <button
            type="button"
            onClick={() => onFollowUp(tile)}
            disabled={following}
            aria-label={t('bots.workbench.followUp.aria', { title })}
            className="flex h-6 items-center gap-1 rounded-full border border-[var(--border-default)] px-2.5 text-12 leading-4 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default"
          >
            {following ? <Spinner size={12} aria-hidden /> : null}
            {t('bots.workbench.followUp.label')}
          </button>
        ) : null}
      </span>
    </li>
  );
}

type SessionActions = ReturnType<typeof useWorkbenchSessionActions>;

/** Cindy 任务条目的「…」:与任务侧栏同一套操作与守卫;悬停或键盘聚焦时出现。 */
function SessionRowMenu({ row, canNavigate, actions }: { row: Session; canNavigate: boolean; actions: SessionActions }) {
  const { t } = useTranslation();
  const archived = row.status === 'archived';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('ccAgent.sidebar.sessionMenu.moreActions')}
          className="flex size-6 items-center justify-center rounded-lg text-[var(--text-tertiary)] opacity-0 outline-none transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canNavigate ? (
          <DropdownMenuItem onSelect={() => actions.open(row.id)}>{t('bots.workbench.detail.openInTasks')}</DropdownMenuItem>
        ) : null}
        {!archived ? (
          <DropdownMenuItem onSelect={() => void actions.togglePin(row.id)}>
            {t(row.pinnedAt ? 'ccAgent.sidebar.sessionMenu.unpin' : 'ccAgent.sidebar.sessionMenu.pin')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void actions.action(row.id, archived ? 'unarchive' : 'archive')}>
          {t(archived ? 'ccAgent.sidebar.sessionMenu.unarchive' : 'ccAgent.sidebar.sessionMenu.archived')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="danger" onSelect={() => void actions.action(row.id, 'delete')}>
          {t('ccAgent.sidebar.sessionMenu.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const GROUP_HEADING_CLASS = 'mb-0.5 mt-3.5 flex min-h-[22px] items-center gap-1.5 text-12 leading-[1.5] text-[var(--text-secondary)]';

function TaskGroups({
  groups,
  now,
  language,
  followingKey,
  onOpen,
  onFollowUp,
  rowMenu,
  archivedFooter,
}: {
  groups: readonly WorkbenchTileGroup[];
  now: number;
  language: string;
  followingKey: string | null;
  onOpen: (tile: WorkbenchTile) => void;
  onFollowUp?: (tile: WorkbenchTile) => void;
  rowMenu?: (tile: WorkbenchTile) => ReactNode;
  /** 「做完」展开后接在归档条目下面的加载更多 / 重试。 */
  archivedFooter?: ReactNode;
}) {
  const { t } = useTranslation();
  const [openDone, setOpenDone] = useState(false);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col px-5 pb-1">
      {groups.map((group) => {
        const open = !group.defaultCollapsed || openDone;
        const label = t(`bots.workbench.group.${group.key}`);
        const heading = (
          <>
            <span>{label}</span>
            <span className="tabular-nums text-[var(--text-tertiary)]">{group.total}</span>
          </>
        );
        const followUp = onFollowUp && workbenchGroupHasFollowUp(group.key) ? onFollowUp : undefined;
        const row = (tile: WorkbenchTile) => (
          <TaskRow
            key={tile.key}
            tile={tile}
            group={group.key}
            now={now}
            language={language}
            following={followingKey === tile.key}
            onOpen={onOpen}
            onFollowUp={followUp}
            menu={rowMenu?.(tile)}
          />
        );
        return (
          <section key={group.key} aria-label={label}>
            {group.defaultCollapsed ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenDone((value) => !value)}
                className={cn(
                  GROUP_HEADING_CLASS,
                  '-mx-1 rounded-lg px-1 outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <ChevronRight
                  size={13}
                  aria-hidden
                  className={cn('text-[var(--text-tertiary)] transition-transform', open && 'rotate-90')}
                />
                {heading}
              </button>
            ) : (
              <h3 className={GROUP_HEADING_CLASS}>{heading}</h3>
            )}
            {open ? (
              <ul className="flex flex-col">
                {group.tiles.map(row)}
                {group.hiddenCount > 0 ? (
                  <li className="py-1 pl-6 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                    {t('bots.workbench.olderCount', { count: group.hiddenCount })}
                  </li>
                ) : null}
                {group.archivedTiles.map(row)}
                {group.key === 'done' && archivedFooter ? <li className="pl-4">{archivedFooter}</li> : null}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

type TilePr = { number: number; kind: PrStatusKind | null; url: string };

/**
 * 条目关联的 PR 与状态:
 * - Cindy 任务:任务里出现过的 PR 引用(取最近一条),状态与刷新复用 PrRefsContext——条目可见时
 *   `registerPrConsumer`,跟侧栏 / 顶栏同一套周期与聚焦刷新,不另起轮询;
 * - `pr:` 条目:可见时用同一个 `gitContext.getPrStatuses` 查一次(main 侧 60 秒缓存与去重);
 *   拿不到(没有 gh 登录等)就只显示编号。
 */
function useTilePr(tile: WorkbenchTile, visible: boolean): TilePr | null {
  const sessionId = tile.type === 'session' ? tile.id : '';
  const { registerPrConsumer } = usePrActions();
  const refs = usePrRefsForSession(sessionId);
  const { statuses, successfulStatuses } = usePrStatuses(sessionId);
  useEffect(() => {
    if (!visible || !sessionId) return;
    return registerPrConsumer(sessionId);
  }, [visible, sessionId, registerPrConsumer]);

  const github = tile.type === 'item' && tile.itemKind === 'pr' ? parseWorkbenchTaskId(tile.id) : null;
  const itemRef = github?.kind === 'github' ? github : null;
  const [itemKind, setItemKind] = useState<PrStatusKind | null>(null);
  useEffect(() => {
    if (!visible || !itemRef) return;
    let alive = true;
    void window.electronAPI?.gitContext
      ?.getPrStatuses([{ owner: itemRef.owner, repo: itemRef.repo, prNumber: itemRef.number }])
      .then((results) => {
        const result = results?.[0];
        if (alive && result?.ok) setItemKind(result.status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // itemRef 由 tile.id 决定。
  }, [visible, tile.id]);

  if (itemRef) {
    return { number: itemRef.number, kind: itemKind, url: sessionPrUrl({ owner: itemRef.owner, repo: itemRef.repo, prNumber: itemRef.number }) };
  }
  if (refs.length === 0) return null;
  const latest = refs.reduce((best, ref) => (ref.lastSeenAt > best.lastSeenAt ? ref : best));
  const key = prStatusKey(latest);
  const result = statuses.get(key);
  const confirmed = result?.ok ? result : successfulStatuses.get(key);
  return { number: latest.prNumber, kind: confirmed?.ok ? confirmed.status : null, url: sessionPrUrl(latest) };
}

/** 小的 PR 状态标:图标 + 「#5292 · 已合并」,颜色与侧栏 / 顶栏同一套 PR_STATUS_*。 */
function PrTag({ pr }: { pr: TilePr }) {
  const { t } = useTranslation();
  const Icon = pr.kind ? PR_STATUS_ICON[pr.kind] : GitPullRequest;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-12 leading-5 text-[var(--text-tertiary)]">
      <Icon size={12} aria-hidden style={{ color: pr.kind ? PR_STATUS_COLOR[pr.kind] : 'var(--text-tertiary)' }} />
      <span className="tabular-nums">
        #{pr.number}
        {pr.kind ? ` · ${t(`ccAgent.gitContext.pr.status.${pr.kind}`)}` : ''}
      </span>
    </span>
  );
}

function StateIcon({ state, verdict }: { state: WorkbenchTaskState; verdict?: 'unfinished' | 'idea' | null }) {
  const { t } = useTranslation();
  const live = state === 'running' || state === 'waiting' || state === 'queued';
  if (!live && verdict) {
    // 没做完沿用「停着」的图标;聊过没下文用小灯泡。
    const VerdictIcon = verdict === 'idea' ? Lightbulb : CirclePause;
    return (
      <span role="img" aria-label={t(`bots.workbench.verdict.${verdict}`)} className="flex size-3 shrink-0 items-center justify-center">
        <VerdictIcon size={13} strokeWidth={1.8} aria-hidden className="text-[var(--text-tertiary)]" />
      </span>
    );
  }
  const label = t(`bots.workbench.state.${state}`);
  if (state === 'running') {
    return (
      <Spinner size={12} strokeWidth={2} role="img" aria-label={label} className="shrink-0 text-[var(--text-secondary)]" />
    );
  }
  if (state === 'waiting' || state === 'queued') {
    return (
      <span role="img" aria-label={label} className="flex size-3 shrink-0 items-center justify-center">
        <span
          aria-hidden
          className={
            state === 'waiting'
              ? 'size-2 rounded-full bg-[var(--card-status-awaiting)]'
              : 'size-2.5 rounded-full border border-dashed border-[var(--text-tertiary)]'
          }
        />
      </span>
    );
  }
  const Icon = state === 'stopped' ? CirclePause : state === 'automation' ? Clock3 : CircleCheck;
  return (
    <span role="img" aria-label={label} className="flex size-3 shrink-0 items-center justify-center">
      <Icon
        size={13}
        strokeWidth={1.8}
        aria-hidden
        className={state === 'done' ? 'text-[var(--card-status-done)]' : 'text-[var(--text-tertiary)]'}
      />
    </span>
  );
}

function scheduleCycle(
  schedule: { manual?: boolean; cronExpr?: string; intervalMs?: number },
  t: Translate,
  language: string,
): string | null {
  if (schedule.manual) return t('bots.workbench.cycle.manual');
  if (schedule.intervalMs) return t('routines.everyMinutes', { count: Math.round(schedule.intervalMs / 60_000) });
  if (schedule.cronExpr) {
    return schedule.cronExpr === '0 * * * *' ? t('routines.hourly') : cronToHuman(schedule.cronExpr, t, language);
  }
  return null;
}

function routineCycle(triggers: WorkbenchRoutineInput['triggers'], t: Translate, language: string): string | null {
  const first = triggers[0];
  if (!first) return null;
  if (first.kind === 'interval' && first.intervalMs) {
    return t('routines.everyMinutes', { count: Math.round(first.intervalMs / 60_000) });
  }
  if (first.kind === 'cron' && first.expression) {
    return first.expression === '0 * * * *' ? t('routines.hourly') : cronToHuman(first.expression, t, language);
  }
  if (first.kind === 'once') return t('bots.workbench.cycle.once');
  if (first.kind === 'event') return t('bots.workbench.cycle.event');
  return null;
}

function originLabel(origin: string, t: Translate): string {
  const key =
    origin === 'delegated'
      ? 'delegated'
      : origin === 'claude-code'
        ? 'claudeCode'
        : origin === 'codex' || origin === 'pi'
          ? origin
          : 'existing';
  return t(`bots.workbench.kind.${key}`);
}

type ItemTile = Extract<WorkbenchTile, { type: 'item' }>;

/** 「PR #5292」「Issue #5026」「建议」。 */
function itemLabel(tile: ItemTile, t: Translate): string {
  if (tile.itemKind === 'idea') return t('bots.workbench.kind.idea');
  return t(`bots.workbench.kind.${tile.itemKind}`, { number: tile.number });
}

function ItemIcon({ tile }: { tile: ItemTile }) {
  const Icon = tile.itemKind === 'pr' ? GitPullRequest : tile.itemKind === 'issue' ? CircleDot : Lightbulb;
  return (
    <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
      <Icon size={13} strokeWidth={1.8} className="text-[var(--text-tertiary)]" />
    </span>
  );
}

// ─── 详情:在工作台标签内看一件任务 ───────────────────────────────────

type DetailTile = Extract<WorkbenchTile, { type: 'session' | 'external' | 'item' }>;

type TranscriptState =
  | { kind: 'loading' }
  | { kind: 'ready'; transcript: WorkbenchTranscript }
  | { kind: 'failed' };

const DETAIL_ACTION_CLASS =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-12 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1.5 text-11 font-medium leading-[1.45] text-[var(--text-tertiary)]">{title}</h4>
      {children}
    </section>
  );
}

/**
 * 详情视图:不换路由、不跳任务页。面包屑「工作台 › 标题」,状态行(状态 · 用时 · 来源 · PR),
 * 伙伴的判断,正在做,到现在的产出,最近内容(同一份有界只读摘录);底部「补一句」以主人身份
 * 发给伙伴,由伙伴决定怎么继续——不绕过伙伴直接投给任务。已归档的任务只读,不给「补一句」。
 */
function TaskDetail({
  botId,
  botName,
  botSessionId,
  tile,
  now,
  canNavigate,
  projectDirs,
  caseInsensitive,
  outputs,
  onBack,
}: {
  botId: string;
  botName: string;
  botSessionId: string;
  tile: DetailTile;
  now: number;
  canNavigate: boolean;
  projectDirs: readonly string[];
  caseInsensitive: boolean;
  /** 这件任务(伙伴的后台任务)交回的文件。 */
  outputs: ReadonlyArray<{ path: string; name: string }>;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [transcript, setTranscript] = useState<TranscriptState>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const title = tile.title || t('bots.workbench.untitled');
  const archived = tile.type === 'session' && tile.archived === true;
  const live = tile.state === 'running' || tile.state === 'waiting' || tile.state === 'queued';
  const statusText = archived
    ? t('ccAgent.sidebar.filterStatus.archived')
    : live || !tile.verdict
      ? t(`bots.workbench.state.${tile.state}`)
      : t(`bots.workbench.verdict.${tile.verdict}`);
  const currentAction = tile.state === 'running' && tile.line.kind === 'action' ? tile.line.text : null;
  // 运行中的任务内容在变:状态变化时重读一次,不轮询。
  const reloadKey = `${tile.type}:${tile.id}:${tile.state}:${tile.lastActiveMs}`;

  useEffect(() => {
    // PR / issue / 建议没有对话记录,只显示判断与参考。
    if (tile.type === 'item') return;
    const api = window.electronAPI?.localDb?.bots?.workbench;
    if (!api?.readTask) {
      setTranscript({ kind: 'failed' });
      return;
    }
    let alive = true;
    const owner = getDataOwnerGeneration();
    setTranscript((previous) => (previous.kind === 'ready' ? previous : { kind: 'loading' }));
    void api
      .readTask(botId, tile.id)
      .then((result) => {
        if (!alive || !isDataOwnerGenerationCurrent(owner)) return;
        setTranscript(result.ok ? { kind: 'ready', transcript: result.transcript } : { kind: 'failed' });
      })
      .catch(() => {
        if (alive) setTranscript({ kind: 'failed' });
      });
    return () => {
      alive = false;
    };
    // reloadKey 已涵盖 tile.id 与 tile.type。
  }, [botId, reloadKey]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const sent = await sendAsOwner(botSessionId, t('bots.workbench.continueMessage', { title, text }));
      if (sent) {
        setDraft('');
        toast.success(t('bots.workbench.detail.sent', { name: botName }));
      } else {
        toast.error(t('bots.workbench.sendFailed', { name: botName }));
      }
    } catch {
      toast.error(t('bots.workbench.sendFailed', { name: botName }));
    } finally {
      setSending(false);
    }
  }, [botName, botSessionId, draft, sending, t, title]);

  const stop = useCallback(() => {
    if (tile.type !== 'session') return;
    void import('@/lib/makerChatStore').then((module) => module.makerChatStore.stopSession(tile.id));
  }, [tile]);

  // 参考只在点击时打开:https 交给系统浏览器,路径必须仍落在已接手的项目里。
  // 详情打开期间同样登记为 PR 消费者(可见即刷新)。参考就是这个 PR 链接时不重复列。
  const pr = useTilePr(tile, true);
  const reference = tile.type === 'item' && tile.ref && tile.ref !== pr?.url ? tile.ref : null;
  const openReference = useCallback(() => {
    if (!reference) return;
    if (/^https:\/\//i.test(reference)) {
      void window.electronAPI.openExternal?.(reference);
      return;
    }
    const checked = validateWorkbenchRef(reference, projectDirs, caseInsensitive);
    if (checked.ok) void window.electronAPI.openPath?.(checked.ref);
    else toast.error(t('bots.workbench.detail.refBlocked'));
  }, [caseInsensitive, projectDirs, reference, t]);

  const openInTasks = useCallback(() => {
    if (tile.type !== 'session') return;
    void resolveSessionRoute(tile.id).then((target) => navigate(target));
  }, [navigate, tile]);

  const transcriptBody =
    transcript.kind === 'loading' ? (
      <div className="flex justify-center py-6">
        <Spinner size={16} className="text-[var(--text-tertiary)]" role="status" aria-label={t('ccAgent.common.loading')} />
      </div>
    ) : transcript.kind === 'failed' ? (
      <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('bots.workbench.detail.loadFailed')}</p>
    ) : transcript.transcript.items.length === 0 ? (
      <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('bots.workbench.detail.empty')}</p>
    ) : (
      <div className="flex flex-col gap-3">
        {transcript.transcript.truncated ? (
          <p className="text-center text-11 text-[var(--text-tertiary)]">{t('bots.workbench.detail.truncated')}</p>
        ) : null}
        {transcript.transcript.items.map((item, index) =>
          item.role === 'user' ? (
            <div
              key={`${item.at}-${index}`}
              className="max-w-[90%] self-end whitespace-pre-wrap break-words rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2.5 text-13 leading-5 text-[var(--text-primary)] [overflow-wrap:anywhere]"
            >
              {item.text}
            </div>
          ) : (
            <div
              key={`${item.at}-${index}`}
              className="whitespace-pre-wrap break-words text-13 leading-[1.69] text-[var(--text-primary)] [overflow-wrap:anywhere]"
            >
              {item.text}
            </div>
          ),
        )}
        <p className="text-11 text-[var(--text-tertiary)]">
          {relativeTime(transcript.transcript.items.at(-1)?.at ?? 0, i18n.language, now)}
        </p>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-[var(--border-default)] py-2 pl-1.5 pr-2.5">
        <Tip text={t('bots.workbench.detail.back')}>
          <button
            type="button"
            onClick={onBack}
            aria-label={t('bots.workbench.detail.back')}
            className={cn(ICON_BUTTON_CLASS, 'size-7 text-[var(--text-secondary)]')}
          >
            <ArrowLeft size={15} aria-hidden />
          </button>
        </Tip>
        <nav aria-label={t('bots.workbench.title')} className="flex min-w-0 flex-1 items-center gap-1 text-12 text-[var(--text-secondary)]">
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-lg px-1 outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {t('bots.workbench.title')}
          </button>
          <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
          <h3 title={title} aria-current="page" className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
            {title}
          </h3>
        </nav>
        {tile.type === 'session' && canNavigate ? (
          <button type="button" onClick={openInTasks} className={DETAIL_ACTION_CLASS}>
            <SquareArrowOutUpRight size={13} aria-hidden />
            {t('bots.workbench.detail.openInTasks')}
          </button>
        ) : null}
        {tile.type === 'session' && tile.state === 'running' ? (
          <button type="button" onClick={stop} aria-label={t('bots.workbench.detail.stop')} className={DETAIL_ACTION_CLASS}>
            <Square size={10} fill="currentColor" aria-hidden />
            {t('bots.workbench.detail.stopLabel')}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <div className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {tile.type === 'item' ? <ItemIcon tile={tile} /> : <StateIcon state={tile.state} verdict={tile.verdict} />}
          <span className="text-[var(--text-secondary)]">
            {statusText}
            {tile.state === 'running' && tile.startedAtMs ? ` · ${elapsed(tile.startedAtMs, now)}` : ''}
          </span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{tile.type === 'item' ? itemLabel(tile, t) : originLabel(tile.origin, t)}</span>
          {pr ? (
            <button
              type="button"
              onClick={() => void window.electronAPI.openExternal?.(pr.url)}
              aria-label={t('bots.workbench.detail.openPr', { number: pr.number })}
              className="inline-flex h-6 items-center rounded-full border border-[var(--border-default)] px-2 outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <PrTag pr={pr} />
            </button>
          ) : null}
        </div>
        {tile.next ? (
          <DetailSection title={t('bots.workbench.detail.judgment', { name: botName })}>
            <p className="border-l-2 border-[var(--border-default)] py-1 pl-2.5 text-13 leading-[1.65] text-[var(--text-primary)] [overflow-wrap:anywhere]">
              {tile.next}
            </p>
          </DetailSection>
        ) : null}
        {currentAction ? (
          <DetailSection title={t('bots.workbench.detail.doing')}>
            <p className="flex min-w-0 items-start gap-2 text-12 leading-[1.5]">
              <span className="flex h-[18px] shrink-0 items-center">
                <Spinner size={12} aria-hidden className="text-[var(--text-secondary)]" />
              </span>
              <span className="min-w-0 text-[var(--status-bar-accent)] [overflow-wrap:anywhere]">{currentAction}</span>
            </p>
          </DetailSection>
        ) : null}
        {outputs.length > 0 ? (
          <DetailSection title={t('bots.workbench.detail.outputs')}>
            <div className="flex flex-wrap gap-1.5">
              {outputs.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  title={file.path}
                  onClick={() => void window.electronAPI.openPath?.(file.path)}
                  className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 text-12 text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <FileText size={12} aria-hidden className="shrink-0" />
                  <span className="min-w-0 truncate">{file.name}</span>
                </button>
              ))}
            </div>
          </DetailSection>
        ) : null}
        {tile.type === 'item' ? (
          reference ? (
            <DetailSection title={t('bots.workbench.detail.ref')}>
              <button
                type="button"
                onClick={openReference}
                className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-[var(--border-default)] px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {/^https:\/\//i.test(reference) ? (
                  <Link2 size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                ) : (
                  <FileText size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-13 leading-5 text-[var(--text-primary)]">{reference}</span>
              </button>
            </DetailSection>
          ) : pr ? null : (
            <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('bots.workbench.detail.noRef')}</p>
          )
        ) : (
          <DetailSection title={t('bots.workbench.detail.recent')}>{transcriptBody}</DetailSection>
        )}
      </div>
      {archived ? null : (
        <form
          className="flex shrink-0 items-center gap-2 border-t border-[var(--border-default)] px-3 pb-3 pt-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Input
            value={draft}
            onChange={setDraft}
            size="md"
            className="min-w-0 flex-1"
            placeholder={t('bots.workbench.detail.placeholder', { name: botName })}
            ariaLabel={t('bots.workbench.detail.placeholder', { name: botName })}
            disabled={sending}
            onKeyDown={(event) => {
              // 输入法组字时回车只确认候选,不发送。
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
          />
          <Tip text={t('bots.workbench.detail.send')}>
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              aria-label={t('bots.workbench.detail.send')}
              className={cn(
                ICON_BUTTON_CLASS,
                'size-8 border border-[var(--border-default)] text-[var(--text-secondary)] disabled:opacity-50',
              )}
            >
              {sending ? <Spinner size={12} aria-hidden /> : <ArrowUp size={14} aria-hidden />}
            </button>
          </Tip>
        </form>
      )}
    </div>
  );
}

/** A folder that stayed on the companion's previous computer: reachable there, not here. */
function DirectoryElsewhere({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const device = devices?.find((candidate) => candidate.deviceId === deviceId)?.name?.trim() || t('bots.cloud.unknownDevice');
  return <span className="shrink-0 text-12 text-[var(--text-tertiary)]">{t('bots.workbench.dirElsewhere', { device })}</span>;
}

