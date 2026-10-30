import type * as React from 'react';
import type { Session } from '@/lib/ccAgent.types';
import {
  filterPresentationPinnedEntries,
  includeCollectedPinnedTasks,
  partitionSidebarTaskInput,
  sidebarTaskKind,
  type PresentationPinnedEntry,
  type SidebarDelegationScope,
  type SidebarTaskInput,
} from '../lib/sidebarTaskPresentation';

const messages = {
  'zh-CN': {
    internal: '内部任务',
    hint: '诊断与委派任务默认收起，展开后仍按原工作目录查看',
    ordinary: '普通任务',
    delegated: '委派任务',
    unknown: '任务',
    parent: '父任务',
    missing: '父任务不可用',
    unlinked: '未记录父任务',
    loading: '读取父任务…',
    updates: '项有更新',
    running: '项运行中',
  },
  'zh-TW': {
    internal: '內部任務',
    hint: '診斷與委派任務預設收起，展開後仍按原工作目錄查看',
    ordinary: '一般任務',
    delegated: '委派任務',
    unknown: '任務',
    parent: '父任務',
    missing: '父任務無法使用',
    unlinked: '未記錄父任務',
    loading: '讀取父任務…',
    updates: '項有更新',
    running: '項執行中',
  },
  en: {
    internal: 'Internal tasks',
    hint: 'Diagnostics and delegated tasks stay folded; expand to browse their original working directories',
    ordinary: 'Ordinary task',
    delegated: 'Delegated task',
    unknown: 'Task',
    parent: 'Parent task',
    missing: 'Parent unavailable',
    unlinked: 'Parent not recorded',
    loading: 'Loading parent…',
    updates: 'updated',
    running: 'running',
  },
  ja: {
    internal: '内部タスク',
    hint: '診断・委任タスクは折りたたみ、展開すると元の作業ディレクトリで表示します',
    ordinary: '通常タスク',
    delegated: '委任タスク',
    unknown: 'タスク',
    parent: '親タスク',
    missing: '親タスクを利用できません',
    unlinked: '親タスク未記録',
    loading: '親タスクを読み込み中…',
    updates: '件の更新',
    running: '件実行中',
  },
  ko: {
    internal: '내부 작업',
    hint: '진단 및 위임 작업은 접어 두며 펼치면 원래 작업 디렉터리별로 표시합니다',
    ordinary: '일반 작업',
    delegated: '위임 작업',
    unknown: '작업',
    parent: '상위 작업',
    missing: '상위 작업을 사용할 수 없음',
    unlinked: '상위 작업이 기록되지 않음',
    loading: '상위 작업 읽는 중…',
    updates: '개 업데이트',
    running: '개 실행 중',
  },
};

interface Owner {
  dataOwnerId: string | null;
  generation: number;
}
interface Profile {
  id: string;
  name: string;
  sessions?: readonly { id: string; role?: string }[];
}
export interface SidebarPresentationSnapshot {
  scopes: readonly SidebarDelegationScope[];
  profiles: readonly Profile[];
  owner: Owner;
}
interface Runtime {
  useSnapshot(): SidebarPresentationSnapshot;
  isOwnerCurrent(owner: Owner): boolean;
  useLanguage(): string;
  readSession(id: string): Promise<Session | null | undefined>;
  subscribeSession?(
    id: string,
    listener: (patch: Partial<Session>, row: Session | null) => void,
  ): () => void;
}

interface TaskRowProps {
  session: Session;
  navigate?: (route: string) => void;
  onClick?: (id: string) => void;
}

type SectionProps = SidebarTaskInput &
  Record<string, unknown> & {
    Original: React.ElementType;
    pinnedEntries?: readonly PresentationPinnedEntry[];
    notifications?: ReadonlySet<string>;
    runningSessionIds?: ReadonlySet<string>;
    filter?: { projects: unknown };
  };

type PinnedProps = Record<string, unknown> & {
  Original: React.ElementType;
  entries?: readonly PresentationPinnedEntry[];
};

// The factory uses the host's React instance in a packaged local build. It also
// keeps the production source usable with normal React imports and UI harnesses.
export function createSidebarTaskPresentation(R: typeof React, runtime: Runtime) {
  const Internal = R.createContext(false);
  const ownerKey = (owner: Owner) => `${owner.dataOwnerId ?? ''}:${owner.generation}`;
  const useLabels = () => {
    const language = runtime.useLanguage();
    return (
      messages[language as keyof typeof messages] ??
      messages[language.split('-')[0] as keyof typeof messages] ??
      messages.en
    );
  };
  // Share only reads that are still in flight. A reopened row must observe the
  // actual parent again, and mounted rows receive its rename/delete patches.
  const parentReads = new WeakMap<Owner, Map<string, Promise<Session | null | undefined>>>();

  function Row({ original, rowProps }: { original: React.ReactNode; rowProps: TaskRowProps }) {
    const snapshot = runtime.useSnapshot();
    const text = useLabels();
    const internal = R.useContext(Internal);
    const session = rowProps.session as Session;
    const kind = sidebarTaskKind(session, snapshot.scopes);
    const parentId = kind === 'delegated' ? session.parentSessionId : null;
    const owner = ownerKey(snapshot.owner);
    const bot = parentId
      ? snapshot.profiles.find((profile) =>
          profile.sessions?.some((link) => link.id === parentId && link.role === 'canonical'),
        )
      : undefined;
    const [parent, setParent] = R.useState<{
      owner: string;
      id: string;
      row: Session | null | undefined;
    } | null>(null);
    R.useEffect(() => {
      if (!parentId || bot) return;
      let active = true;
      let revision = 0;
      let reads = parentReads.get(snapshot.owner);
      if (!reads) {
        reads = new Map();
        parentReads.set(snapshot.owner, reads);
      }
      const current = () => active && runtime.isOwnerCurrent(snapshot.owner);
      const apply = (row: Session | null | undefined) => {
        if (current())
          setParent({ owner, id: parentId, row: row?.status === 'deleted' ? null : row });
      };
      const read = () => {
        const requestRevision = ++revision;
        let pending = reads.get(parentId);
        if (!pending) {
          pending = runtime.readSession(parentId).catch(() => null);
          reads.set(parentId, pending);
          const request = pending;
          void request.then(() => {
            if (reads.get(parentId) === request) reads.delete(parentId);
          });
        }
        void pending.then((row) => {
          if (requestRevision === revision) apply(row);
        });
      };
      const unsubscribe = runtime.subscribeSession?.(parentId, (patch, row) => {
        if (!current() || (!('title' in patch) && !('status' in patch))) return;
        ++revision;
        // Every committed parent update invalidates the shared in-flight read,
        // including for sibling rows mounted after this patch.
        reads.delete(parentId);
        if (patch.status === 'deleted') apply(null);
        else if (row) apply(row);
        else {
          // The parent may be outside all loaded list buckets. Do not reuse a
          // read started before this committed update.
          read();
        }
      });
      read();
      return () => {
        active = false;
        ++revision;
        unsubscribe?.();
      };
    }, [parentId, bot, snapshot.owner, owner]);
    const loaded = parent?.owner === owner && parent.id === parentId ? parent : null;
    const parentTitle = bot?.name ?? loaded?.row?.title;
    const available = !!bot || (!!loaded?.row && loaded.row.status !== 'deleted');
    const onParent = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!parentId || !available || !runtime.isOwnerCurrent(snapshot.owner)) return;
      if (rowProps.navigate) {
        rowProps.navigate(
          bot
            ? `/bots/${encodeURIComponent(bot.id)}/session/${encodeURIComponent(parentId)}`
            : `/cc-agent/${encodeURIComponent(parentId)}`,
        );
      } else rowProps.onClick?.(parentId);
    };
    const relation =
      kind === 'delegated'
        ? R.createElement(
            'div',
            {
              className:
                'cindy-sidebar-task-relation ml-5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pt-1 text-[11px] leading-4 text-[var(--text-secondary)]',
              'data-task-parent-id': parentId ?? undefined,
            },
            R.createElement('span', { className: 'shrink-0' }, `↳ ${text.delegated}`),
            parentId
              ? R.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: onParent,
                    disabled: !available,
                    'aria-label': parentTitle
                      ? `${text.parent}: ${parentTitle}`
                      : loaded
                        ? text.missing
                        : text.loading,
                    title: parentTitle ?? (loaded ? text.missing : text.loading),
                    className:
                      'min-w-0 max-w-full truncate rounded-full px-1 text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 disabled:no-underline',
                  },
                  parentTitle
                    ? `${text.parent}: ${parentTitle}`
                    : loaded
                      ? text.missing
                      : text.loading,
                )
              : R.createElement('span', null, text.unlinked),
          )
        : internal
          ? R.createElement(
              'div',
              {
                className:
                  'cindy-sidebar-task-kind-label ml-7 px-2 pt-1 text-[11px] leading-4 text-[var(--text-tertiary)]',
              },
              kind === 'ordinary' ? text.ordinary : text.unknown,
            )
          : null;
    return R.createElement(
      'div',
      { 'data-sidebar-task-kind': kind, 'data-sidebar-task-id': session.id, className: 'min-w-0' },
      relation,
      original,
    );
  }

  function Section({ Original, ...props }: SectionProps) {
    const snapshot = runtime.useSnapshot();
    const text = useLabels();
    const key = ownerKey(snapshot.owner);
    const [expanded, setExpanded] = R.useState<{ owner: string; open: boolean }>({
      owner: key,
      open: false,
    });
    const open = expanded.owner === key && expanded.open;
    const [innerCollapsed, setInnerCollapsed] = R.useState<ReadonlySet<string>>(new Set());
    const enriched = includeCollectedPinnedTasks(props, props.pinnedEntries ?? [], snapshot.scopes);
    const partition = partitionSidebarTaskInput(enriched, snapshot.scopes);
    // Normal pinned data is not reintroduced into the main list.
    const normal = partitionSidebarTaskInput(props, snapshot.scopes).normal;
    const count = partition.collected.length;
    const updated = partition.collected.filter((session) =>
      props.notifications?.has(session.id),
    ).length;
    const running = partition.collected.filter((session) =>
      props.runningSessionIds?.has(session.id),
    ).length;
    const pinnedIds = new Set(
      (props.pinnedEntries ?? []).flatMap((entry) =>
        entry.session
          ? [entry.session.id]
          : (entry.displaySessions ?? entry.project?.sessions ?? []).map((session) => session.id),
      ),
    );
    const internalProps = {
      ...partition.internal,
      // Preserve project filtering for ordinary unclassified tasks, while
      // keeping the original pinned-section reachability of collected pins.
      unclassified:
        props.filter && props.filter.projects !== 'all'
          ? partition.internal.unclassified.filter((session) => pinnedIds.has(session.id))
          : partition.internal.unclassified,
      showUnclassified: true,
      collapsed: innerCollapsed,
      onToggleProject: (id: string) =>
        setInnerCollapsed((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      onCollapseAll: () =>
        setInnerCollapsed(
          new Set(partition.internal.projects.map((project) => project.projectKey)),
        ),
      onExpandAll: () => setInnerCollapsed(new Set()),
      pinnedEntries: [],
      onCreateProject: undefined,
    };
    return R.createElement(
      R.Fragment,
      null,
      R.createElement(Original, normal),
      count > 0 &&
        R.createElement(
          'section',
          {
            className: 'mt-2 min-w-0 border-t border-[var(--border-default)] pt-1',
            'data-sidebar-internal-tasks': true,
          },
          R.createElement(
            'button',
            {
              type: 'button',
              title: text.hint,
              'aria-expanded': open,
              'aria-label': `${text.internal} · ${count}`,
              onClick: () => setExpanded({ owner: key, open: !open }),
              className:
                'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-full px-3 text-left text-xs text-[var(--text-secondary)] hover:bg-sidebar-item-hover focus-visible:outline focus-visible:outline-1',
            },
            R.createElement('span', { 'aria-hidden': true }, open ? '⌄' : '›'),
            R.createElement('span', { className: 'truncate' }, text.internal),
            R.createElement(
              'span',
              { className: 'tabular-nums text-[var(--text-tertiary)]' },
              String(count),
            ),
            R.createElement(
              'span',
              {
                className: 'ml-auto min-w-0 truncate text-[11px]',
                role: updated ? 'status' : undefined,
              },
              [
                running ? `${running} ${text.running}` : '',
                updated ? `${updated} ${text.updates}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          ),
          open &&
            R.createElement(
              Internal.Provider,
              { value: true },
              R.createElement(
                'div',
                { className: 'min-w-0 pl-2', 'data-sidebar-internal-content': true },
                R.createElement(Original, internalProps),
              ),
            ),
        ),
    );
  }

  function Pinned({ Original, ...props }: PinnedProps) {
    const snapshot = runtime.useSnapshot();
    const entries = filterPresentationPinnedEntries(props.entries ?? [], snapshot.scopes);
    return R.createElement(Original, { ...props, entries });
  }

  return {
    Section,
    Pinned,
    wrapRow: (original: React.ReactNode, rowProps: TaskRowProps) =>
      R.createElement(Row, { original, rowProps }),
  };
}
