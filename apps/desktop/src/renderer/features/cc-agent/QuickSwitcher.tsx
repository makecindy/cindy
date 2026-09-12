import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Folder, MessageSquare, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAppShortcut } from '@/hooks/useAppShortcut';
import { isAppInteractionLocked } from '@/lib/appInteractionLock';
import { useSwitcherDevices } from '@/features/device-link/useMachineSwitcher';
import {
  remoteProjectsStore,
  useRemoteProjectSessions,
} from '@/features/device-link/remoteProjectsStore';
import {
  MACHINE_LOCAL,
  setSelectedMachineIdTransient,
} from '@/features/device-link/selectedMachineStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useCCSessions } from '@/hooks/useCCSessions';
import { readQuickSwitcherCatalog } from '@/lib/quickSwitcherService';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { onPatch, onRefresh } from '@/lib/sessionsBus';
import type { Session } from '@/lib/ccAgent.types';
import type { QuickSwitcherCatalogPage } from '../../../shared/quickSwitcher';
import { patchDraft } from '@/state/newMakerDraft';
import { extractIpcError } from '@/utils/ipcError';
import {
  clearQuickSwitcherFocus,
  clearQuickSwitcherFocusOutsideRoute,
  patchQuickSwitcherFocusSession,
  requestQuickSwitcherFocus,
} from '@/state/quickSwitcherFocus';
import { useProjectAliases } from './hooks/useProjectAliases';
import { useHiddenProjects } from './hooks/useHiddenProjects';
import { isProjectHidden } from './lib/sidebarProjectVisibility';
import {
  projectIdentityKey,
  projectIdentityKeyForSession,
  projectKeyComparisonKey,
} from './lib/projectGrouping';
import {
  catalogSessionForGrouping,
  projectSwitchTarget,
  quickSwitcherProjects,
  searchQuickSwitcher,
  type QuickSwitcherResult,
} from './lib/quickSwitcher';

/** Main-window entry; its directory and query state are independent of sidebar search. */
export function QuickSwitcher({ revealSidebar }: { revealSidebar: () => void }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useLayoutEffect(() => {
    clearQuickSwitcherFocusOutsideRoute(location.pathname);
  }, [location.pathname]);
  useEffect(() => () => clearQuickSwitcherFocus(), []);
  useEffect(
    () =>
      window.electronAPI.onRsbBrowserCommand?.(({ command }) => {
        if (
          command === 'open-quick-switcher' &&
          document.body.dataset.appShortcutRecording !== '1' &&
          !isAppInteractionLocked()
        ) {
          // Guest keys cannot reach useAppShortcut; repeated signals must not close the dialog.
          setOpen(true);
        }
      }),
    [],
  );
  useEffect(() => {
    const offLocal = window.electronAPI.localDb.sessionsPush?.onPatched(
      ({ sessionId, patch }, stamp) => {
        if (isDataOwnerPushCurrent(stamp))
          patchQuickSwitcherFocusSession(undefined, sessionId, patch);
      },
    );
    const offPatch = onPatch((id, patch) => patchQuickSwitcherFocusSession(undefined, id, patch));
    const offRemote = window.electronAPI.deviceLink?.onRemotePush?.((push, stamp) => {
      if (
        !isDeviceLinkRemotePushCurrent(push, stamp) ||
        push.channel !== 'local-db:sessions:patched' ||
        !push.payload ||
        typeof push.payload !== 'object'
      )
        return;
      if (
        'sessionId' in push.payload &&
        typeof push.payload.sessionId === 'string' &&
        'patch' in push.payload &&
        push.payload.patch &&
        typeof push.payload.patch === 'object'
      ) {
        patchQuickSwitcherFocusSession(push.deviceId, push.payload.sessionId, push.payload.patch);
      }
    });
    return () => {
      offLocal?.();
      offRemote?.();
      offPatch();
    };
  }, []);
  useAppShortcut(
    'open-quick-switcher',
    () => {
      setOpen((value) => !value);
      return true;
    },
    { stopImmediate: true },
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {open && <QuickSwitcherBody close={() => setOpen(false)} revealSidebar={revealSidebar} />}
    </Dialog.Root>
  );
}

function QuickSwitcherBody({
  close,
  revealSidebar,
}: {
  close: () => void;
  revealSidebar: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const priorFocus = useRef(document.activeElement);
  const selectedOnClose = useRef(false);
  const composing = useRef(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const alive = useRef(true);
  const [owner] = useState(getDataOwnerGeneration);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Keyboard events can arrive before React paints the preceding selection.
  // Event handlers consume this synchronous cursor; state renders the same key.
  const selectedKeyRef = useRef<string | null>(null);
  const queryRef = useRef('');
  const chooseKey = useCallback((key: string | null) => {
    selectedKeyRef.current = key;
    setSelectedKey(key);
  }, []);
  const [catalog, setCatalog] = useState<Session[]>([]);
  const [recent, setRecent] = useState<
    Array<{ path: string; lastUsedAt: string; exists: boolean }>
  >([]);
  const [incomplete, setIncomplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const devices = useSwitcherDevices();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const remote = useRemoteProjectSessions();
  const { sessions: knownLocal } = useCCSessions({ includeArchived: 'all' });
  const knownRef = useRef({ local: knownLocal, remote });
  knownRef.current = { local: knownLocal, remote };
  const { aliases } = useProjectAliases();
  const { hiddenProjectKeys } = useHiddenProjects();
  const hiddenRef = useRef(hiddenProjectKeys);
  hiddenRef.current = hiddenProjectKeys;
  const platform = window.electronAPI.platform;
  const deviceSignature = JSON.stringify(devices);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const revision = ++generation.current;
      const current = () =>
        alive.current && generation.current === revision && isDataOwnerGenerationCurrent(owner);
      setLoading(true);
      const local = readQuickSwitcherCatalog(
        (cursor) => window.electronAPI.localDb.conversations.catalog(cursor),
        current,
      )
        .then((rows) => ({
          rows: rows?.map(catalogSessionForGrouping) ?? [],
          complete: rows !== null,
        }))
        .catch(() => ({ rows: knownRef.current.local, complete: false }));
      const origins = devicesRef.current
        .filter((d) => d.status !== 'rejected')
        .map(async (device) => {
          try {
            if (device.status !== 'connected') throw new Error('offline');
            const rows = await readQuickSwitcherCatalog(
              async (cursor) =>
                (await window.electronAPI.deviceLink.invoke(
                  device.deviceId,
                  'local-db:conversations:catalog',
                  [cursor],
                )) as QuickSwitcherCatalogPage,
              current,
            );
            return {
              rows:
                rows?.map((row) =>
                  catalogSessionForGrouping({
                    ...row,
                    deviceLinkDeviceId: device.deviceId,
                    deviceLinkDeviceName: device.name,
                  }),
                ) ?? [],
              complete: rows !== null,
            };
          } catch {
            return {
              rows: knownRef.current.remote.filter((s) => s.deviceLinkDeviceId === device.deviceId),
              complete: false,
            };
          }
        });
      const pages = new Map<number, { rows: Session[]; complete: boolean }>();
      let pending = origins.length + 2;
      let dirsFailed = false;
      const publish = () => {
        if (!current()) return;
        setCatalog([...pages.values()].flatMap((page) => page.rows));
        setIncomplete(
          pending > 0 || [...pages.values()].some((page) => !page.complete) || dirsFailed,
        );
        setLoading(pending > 0);
      };
      // A slow/offline peer must not hold back already available local results.
      await Promise.all([
        ...[local, ...origins].map(async (request, index) => {
          pages.set(index, await request);
          --pending;
          publish();
        }),
        window.electronAPI.localDb.recentWorkdirs
          .list()
          .catch(() => null)
          .then((dirs) => {
            dirsFailed = dirs === null;
            --pending;
            if (current()) setRecent(dirs ?? []);
            publish();
          }),
      ]);
    };
    const scheduleRefresh = () => {
      ++generation.current; // stale reads lose authority immediately, before the debounce.
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    };
    void refresh();
    const offRefresh = onRefresh(scheduleRefresh);
    const metadataChanged = (id: string, patch: Partial<Session>, deviceId?: string) => {
      if (
        [
          'title',
          'status',
          'workingDir',
          'workspaceKind',
          'remoteHostId',
          'pinnedAt',
          'userSendAt',
        ].some((key) => key in patch)
      )
        scheduleRefresh();
      else if ('updatedAt' in patch && isDataOwnerGenerationCurrent(owner)) {
        // Streaming activity does not require rereading every title. Keep the
        // visible activity field fresh without merging any message payload.
        setCatalog((rows) =>
          rows.map((row) =>
            row.id === id && row.deviceLinkDeviceId === deviceId
              ? { ...row, updatedAt: patch.updatedAt ?? row.updatedAt }
              : row,
          ),
        );
      }
    };
    const offPatch = onPatch((id, patch) => metadataChanged(id, patch));
    const offCreated = window.electronAPI.localDb.sessionsPush?.onCreated((_payload, stamp) => {
      if (isDataOwnerPushCurrent(stamp)) scheduleRefresh();
    });
    const offPatched = window.electronAPI.localDb.sessionsPush?.onPatched(
      ({ sessionId, patch }, stamp) => {
        if (isDataOwnerPushCurrent(stamp)) metadataChanged(sessionId, patch);
      },
    );
    // Reuse the existing sessions subscription; opening this panel does not
    // subscribe to new devices or broaden remote permissions.
    const offRemote = window.electronAPI.deviceLink?.onRemotePush?.((push, stamp) => {
      if (
        !isDeviceLinkRemotePushCurrent(push, stamp) ||
        !devicesRef.current.some((d) => d.deviceId === push.deviceId && d.status === 'connected')
      )
        return;
      if (push.channel === 'local-db:sessions:created') scheduleRefresh();
      if (
        push.channel === 'local-db:sessions:patched' &&
        push.payload &&
        typeof push.payload === 'object' &&
        'patch' in push.payload
      ) {
        const patch = push.payload.patch;
        if (
          patch &&
          typeof patch === 'object' &&
          'sessionId' in push.payload &&
          typeof push.payload.sessionId === 'string'
        )
          metadataChanged(push.payload.sessionId, patch, push.deviceId);
      }
    });
    return () => {
      alive.current = false;
      ++generation.current;
      clearTimeout(timer);
      offRefresh();
      offPatch();
      offCreated?.();
      offPatched?.();
      offRemote?.();
    };
  }, [deviceSignature, owner]);

  const visibleCatalog = useMemo(
    () =>
      catalog.filter(
        (s) =>
          !s.deviceLinkDeviceId ||
          devices.some((d) => d.deviceId === s.deviceLinkDeviceId && d.status !== 'rejected'),
      ),
    [catalog, devices],
  );
  const projects = useMemo(
    () => quickSwitcherProjects(visibleCatalog, aliases, recent, platform),
    [visibleCatalog, aliases, recent, platform],
  );
  const { results, total } = useMemo(
    () =>
      searchQuickSwitcher({
        query,
        sessions: visibleCatalog,
        projects,
        hiddenProjectKeys,
        platform,
        unnamedLabel: t('ccAgent.common.unnamedSession'),
      }),
    [query, visibleCatalog, projects, hiddenProjectKeys, platform, t],
  );
  const active =
    results.find((result) => result.key === selectedKey) ??
    (selectedKey === null ? results[0] : undefined);
  useEffect(() => {
    // A passive default must not overwrite a newer query or keyboard choice.
    if (queryRef.current === query && selectedKeyRef.current === null && results[0])
      chooseKey(results[0].key);
  }, [chooseKey, query, results, selectedKey]);
  const listId = useId();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (active) rowRefs.current.get(active.key)?.scrollIntoView({ block: 'nearest' });
  }, [active?.key]);

  async function select(result: QuickSwitcherResult) {
    if (openingRef.current || !isDataOwnerGenerationCurrent(owner)) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    const revision = generation.current;
    const selection = ++selectionGeneration.current;
    const current = () =>
      alive.current &&
      revision === generation.current &&
      selection === selectionGeneration.current &&
      isDataOwnerGenerationCurrent(owner);
    try {
      const currentId = /^\/cc-agent\/(?:files\/)?([^/]+)$/.exec(location.pathname)?.[1];
      const currentKey = currentId
        ? `${remoteProjectsStore.getSessionDeviceId(currentId) ?? 'local'}:${currentId}`
        : null;
      const candidate =
        result.kind === 'session'
          ? result.session
          : projectSwitchTarget(result.project, currentKey);
      let session: Session | null = null;
      if (candidate) {
        const deviceId = candidate.deviceLinkDeviceId;
        if (
          deviceId &&
          !devicesRef.current.some((d) => d.deviceId === deviceId && d.status === 'connected')
        )
          throw new Error('offline');
        // Read from the explicitly selected origin, never the ambiguous bare-id router.
        session = deviceId
          ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [
              candidate.id,
            ])) as Session)
          : await window.electronAPI.localDb.sessions.get(candidate.id);
        if (!current()) return;
        if (
          deviceId &&
          !devicesRef.current.some((d) => d.deviceId === deviceId && d.status === 'connected')
        )
          throw new Error('offline');
        if (!session || session.id !== candidate.id || session.status === 'deleted')
          throw new Error('missing');
        session = {
          ...session,
          deviceLinkDeviceId: deviceId,
          deviceLinkDeviceName: candidate.deviceLinkDeviceName,
        };
        if (
          result.kind === 'project' &&
          projectKeyComparisonKey(projectIdentityKeyForSession(session), platform) !==
            projectKeyComparisonKey(result.project.projectKey, platform)
        )
          throw new Error('changed');
        const routedOrigin = remoteProjectsStore.getSessionDeviceId(session.id);
        if (routedOrigin && routedOrigin !== deviceId) throw new Error('ambiguous origin');
      }
      const project =
        result.kind === 'project'
          ? result.project
          : (projects.find(
              (p) => p.projectKey === projectIdentityKeyForSession(session ?? result.session),
            ) ?? null);
      if (
        project &&
        isProjectHidden(project.projectKey, hiddenRef.current, platform) &&
        result.kind === 'project'
      )
        throw new Error('changed');
      const route = session ? await resolveSessionRoute(session.id, session) : '/cc-agent/new';
      if (!current()) return;
      if (!session && project) {
        const currentDirs = await window.electronAPI.localDb.recentWorkdirs.list();
        if (!current()) return;
        if (
          !currentDirs.some(
            (dir) =>
              dir.exists &&
              projectKeyComparisonKey(projectIdentityKey('local', dir.path, null), platform) ===
                projectKeyComparisonKey(project.projectKey, platform),
          )
        )
          throw new Error('missing');
        patchDraft({
          workingDir: project.workingDir,
          remoteHostId: project.remoteHostId,
          deviceLinkDeviceId: project.deviceLinkDeviceId,
          deviceLinkDeviceName: project.deviceLinkDeviceName,
        });
      }
      if (session?.deviceLinkDeviceId) {
        remoteProjectsStore.mergeDeviceSessions(
          session.deviceLinkDeviceId,
          session.deviceLinkDeviceName ?? '',
          [session],
          session.status === 'archived' ? 'archived' : 'active',
        );
        remoteProjectsStore.pinSessionOrigin(session.deviceLinkDeviceId, session.id);
      }
      setSelectedMachineIdTransient([
        session?.deviceLinkDeviceId ?? project?.deviceLinkDeviceId ?? MACHINE_LOCAL,
      ]);
      selectedOnClose.current = true;
      revealSidebar();
      close();
      navigate(route);
      requestQuickSwitcherFocus({ kind: result.kind, route, session, project });
    } catch (cause) {
      const code = extractIpcError(cause)?.code;
      const reason =
        code === 'NOT_FOUND'
          ? 'missing'
          : code === 'PERMISSION_DENIED'
            ? 'access'
            : cause instanceof Error && ['offline', 'missing', 'changed'].includes(cause.message)
              ? cause.message
              : 'unavailable';
      if (current()) setError(t(`ccAgent.quickSwitcher.${reason}`));
    } finally {
      openingRef.current = false;
      if (alive.current) setOpening(false);
    }
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
      <Dialog.Content
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,85vh)] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)] shadow-[var(--cmd-palette-shadow)] outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            !selectedOnClose.current &&
            priorFocus.current instanceof HTMLElement &&
            priorFocus.current.isConnected
          )
            priorFocus.current.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (composing.current || event.isComposing) event.preventDefault();
        }}
      >
        <Dialog.Title className="mb-3 select-none text-14 font-medium">
          {t('ccAgent.quickSwitcher.title')}
        </Dialog.Title>
        <Dialog.Description className="sr-only">
          {t('ccAgent.quickSwitcher.hint')}
        </Dialog.Description>
        <div className="flex items-center gap-2 rounded-full border border-[var(--border-default)] px-3 py-2 focus-within:ring-1 focus-within:ring-[var(--focus-ring-soft)]">
          <Search size={16} className="shrink-0 text-[var(--text-secondary)]" />
          {/* The wrapper owns the pill shape; rounding this unpadded input clips its caret. */}
          <input
            ref={input}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${listId}-${results.indexOf(active)}` : undefined}
            aria-label={t('ccAgent.quickSwitcher.title')}
            placeholder={t('ccAgent.quickSwitcher.placeholder')}
            value={query}
            className="min-w-0 flex-1 bg-transparent text-14 outline-none placeholder:text-[var(--text-placeholder)]"
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => {
              ++selectionGeneration.current;
              queryRef.current = event.target.value;
              setQuery(event.target.value);
              chooseKey(null);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (queryRef.current !== query) return;
              const currentChoice =
                results.find((result) => result.key === selectedKeyRef.current) ??
                (selectedKeyRef.current === null ? results[0] : undefined);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const index = currentChoice ? results.indexOf(currentChoice) : -1;
                const next =
                  index < 0
                    ? event.key === 'ArrowDown'
                      ? 0
                      : results.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                      results.length;
                chooseKey(results[next]?.key ?? null);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (currentChoice) void select(currentChoice);
              }
            }}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={t('ccAgent.quickSwitcher.title')}
          aria-busy={loading || opening}
          className="my-3 min-h-0 overflow-y-auto"
        >
          {results.map((result, index) => {
            const Icon = result.kind === 'project' ? Folder : MessageSquare;
            const item = result.kind === 'project' ? result.project : result.session;
            const hiddenProject =
              result.kind === 'session' &&
              isProjectHidden(
                projectIdentityKeyForSession(result.session) ?? '',
                hiddenProjectKeys,
                platform,
              );
            return (
              <div
                key={result.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={result.key === active?.key}
                ref={(node) => {
                  if (node) rowRefs.current.set(result.key, node);
                  else rowRefs.current.delete(result.key);
                }}
                onMouseMove={() => chooseKey(result.key)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void select(result)}
                className={`flex cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2 ${result.key === active?.key ? 'bg-[var(--surface-hover)]' : ''}`}
              >
                <Icon size={16} className="shrink-0 text-[var(--text-secondary)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-14">{result.title}</div>
                  <div className="truncate text-12 text-[var(--text-secondary)]">
                    {[
                      t(
                        result.kind === 'project'
                          ? 'ccAgent.quickSwitcher.project'
                          : 'ccAgent.quickSwitcher.session',
                      ),
                      item.deviceLinkDeviceName ?? item.remoteHostId,
                      hiddenProject ||
                      (result.kind === 'session' && result.session.workspaceKind === 'dialogue')
                        ? t('ccAgent.sidebar.dialogues')
                        : item.workingDir,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              </div>
            );
          })}
          {results.length === 0 && (
            <p className="px-3 py-4 text-center text-13 text-[var(--text-secondary)]">
              {t(
                query.trim()
                  ? loading
                    ? 'ccAgent.quickSwitcher.loading'
                    : 'ccAgent.quickSwitcher.noResults'
                  : 'ccAgent.quickSwitcher.hint',
              )}
            </p>
          )}
        </div>
        <div role="status" className="text-12 text-[var(--text-secondary)]">
          {error ??
            (incomplete
              ? t('ccAgent.quickSwitcher.incomplete')
              : total > 24
                ? t('ccAgent.quickSwitcher.refine')
                : '')}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 select-none text-12 text-[var(--text-secondary)]">
          <span>{t('ccAgent.quickSwitcher.keys')}</span>
          <Dialog.Close className="rounded-full border border-[var(--border-default)] px-4 py-2 text-13 text-[var(--text-primary)]">
            {t('ccAgent.quickSwitcher.cancel')}
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
