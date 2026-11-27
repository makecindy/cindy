import { pluginSourceTooltip } from '@cindy/maker-shared/mcp-apps';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import { isHostUiPosition, isInlineComposerAction, isDynamicComposerContribution, type GhostHostUiContribution, type GhostHostUiPosition } from '@cindy/plugin-protocol';
import { getApprovedGhostHostUi, ghostInstallApprovalToken, GHOST_PIPE_CALL_MAX_TOTAL_MS, type InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { useInstalledGhosts, readInstalledGhostsSnapshot } from './useInstalledGhosts';
import { usePluginUiControl, usePluginUiControlStates } from './pluginUiControls';
import { PLUGIN_UI_INTEREST_LIMIT, type PluginUiControlItem, type PluginUiControlState } from '../../shared/pluginUi';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Select } from '@/components/ui/select';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { ChevronDown, ChevronRight, FolderOpen, Puzzle, Sparkles } from 'lucide-react';
import { SidebarIconButton } from '@/components/sidebar/SidebarIconButton';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { MAIN_VIEW_ICONS } from './mainViewIcons';
import { isPluginUiElementVisible, subscribePluginUiRegions } from './pluginUiVisibility';
import { registerPluginUiComposerAction, type ComposerActionOutcome } from './pluginUiContext';
const PluginUiView = lazy(() => import('./PluginUiView').then(module => ({ default: module.PluginUiView })));
const openPluginUiView = async (instanceId: string, viewId: string, sessionId: string | null, input?: Record<string, unknown>, workingDir?: string) =>
  (await import('@/features/right-sidebar/lib/openPluginUiView')).openPluginUiView(instanceId, viewId, sessionId, input, workingDir);
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type PluginUiEntry = { ghost: InstalledGhost; instanceId: string; contribution: GhostHostUiContribution; inlineComposerAction?: true;
  item?: PluginUiControlItem; itemState?: PluginUiControlState };
type Directory = ReadonlyMap<GhostHostUiPosition, readonly PluginUiEntry[]>;
const EMPTY: Directory = new Map();
const NO_ENTRIES: readonly PluginUiEntry[] = [];
const NO_SETTINGS: readonly InstalledGhost[] = [];
const DirectoryContext = createContext<Directory>(EMPTY);
type SlotVisibility = { element: Element; intersecting: boolean; listeners: Set<(visible: boolean) => void> };
const observedSlots = new Map<Element, SlotVisibility>();
let slotObserver: IntersectionObserver | undefined;
const notifySlotVisibility = (slot: SlotVisibility) => {
  for (const changed of slot.listeners) changed(slot.intersecting && document.visibilityState !== 'hidden' && isPluginUiElementVisible(slot.element));
};
const updateSlotVisibility = () => { for (const slot of observedSlots.values()) notifySlotVisibility(slot); };
let stopRegionObservation: (() => void) | undefined;

/** One browser observer per window; offscreen history does not hold native-state demand. */
function observeSlotVisibility(element: Element, changed: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { changed(true); return () => {}; }
  if (!slotObserver) {
    slotObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const slot = observedSlots.get(entry.target);
        if (slot) { slot.intersecting = entry.isIntersecting; notifySlotVisibility(slot); }
      }
    }, { rootMargin: '80px 0px' });
    document.addEventListener('visibilitychange', updateSlotVisibility);
    stopRegionObservation = subscribePluginUiRegions(updateSlotVisibility);
  }
  let slot = observedSlots.get(element);
  if (!slot) { slot = { element, intersecting: false, listeners: new Set() }; observedSlots.set(element, slot); slotObserver.observe(element); }
  slot.listeners.add(changed); notifySlotVisibility(slot);
  return () => {
    slot.listeners.delete(changed);
    if (!slot.listeners.size) { observedSlots.delete(element); slotObserver?.unobserve(element); }
    if (!observedSlots.size) {
      slotObserver?.disconnect(); slotObserver = undefined;
      document.removeEventListener('visibilitychange', updateSlotVisibility);
      stopRegionObservation?.(); stopRegionObservation = undefined;
    }
  };
}
export interface PluginUiLauncher {
  ghost: InstalledGhost; instanceId: string; id: string; title: string;
  kind: 'view' | 'command'; view?: string; scope?: string; shortcut?: string;
  input?: Record<string, unknown>;
}
const LauncherContext = createContext<readonly PluginUiLauncher[]>([]);
export const usePluginUiLaunchers = () => useContext(LauncherContext);
export const usePluginUiHas = (position: GhostHostUiPosition) => !!useContext(DirectoryContext).get(position)?.length;

export interface PluginUiMessageCandidates {
  messageBody: boolean;
  toolBody: boolean;
  messageActions: boolean;
  turnFooter: boolean;
  userMenu: readonly PluginUiEntry[];
  assistantMenu: readonly PluginUiEntry[];
}
export const EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES: PluginUiMessageCandidates = {
  messageBody: false, toolBody: false, messageActions: false, turnFooter: false,
  userMenu: NO_ENTRIES, assistantMenu: NO_ENTRIES,
};

/** One list owner reads the directory; dormant message rows do not consume Context. */
export function usePluginUiMessageCandidates(sessionId?: string | null): PluginUiMessageCandidates {
  const directory = useContext(DirectoryContext);
  const messageBody = !!directory.get('message.body')?.length;
  const toolBody = !!directory.get('tool.body')?.length;
  const messageActions = !!directory.get('message.actions')?.length;
  const turnFooter = !!directory.get('turn.footer')?.length;
  const menu = directory.get('message.menu') ?? NO_ENTRIES;
  const disabled = !!sessionId && !!getStickySessionDeviceId(sessionId);
  return useMemo(() => {
    if (disabled || !messageBody && !toolBody && !messageActions && !turnFooter && !menu.length) {
      return EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES;
    }
    const forRole = (role: 'user' | 'assistant') => {
      const entries = menu.filter(({ contribution: { match } }) => !match?.tools && !match?.plugins &&
        (!match?.roles || match.roles.includes(role)));
      return entries.length ? entries : NO_ENTRIES;
    };
    return { messageBody, toolBody, messageActions, turnFooter,
      userMenu: forRole('user'), assistantMenu: forRole('assistant') };
  }, [messageBody, toolBody, messageActions, turnFooter, menu, disabled]);
}

const compiledDirectories = new WeakMap<readonly InstalledGhost[], ReturnType<typeof compileDirectory>>();
function compileDirectory(ghosts: readonly InstalledGhost[]) {
    const entries = new Map<GhostHostUiPosition, PluginUiEntry[]>();
    const launchers: PluginUiLauncher[] = [];
    const settings: InstalledGhost[] = [];
    let active = false;
    for (const ghost of ghosts) {
      if (!ghost.enabled) continue;
      const host = getApprovedGhostHostUi(ghost);
      if (host?.settings?.length || host?.contributions?.some(item => item.position === 'settings.section')) settings.push(ghost);
      if (host) active = true;
      const instanceId = installedGhostStoragePart(ghost);
      for (const view of host?.views ?? []) launchers.push({ ghost, instanceId, id: view.id, title: view.title,
        kind: 'view', view: view.id, scope: view.scope ?? 'global' });
      for (const command of host?.commands ?? []) launchers.push({ ghost, instanceId, id: command.id, title: command.title,
        kind: 'command', view: command.view, input: command.arguments,
        scope: host?.views?.find(view => view.id === command.view)?.scope, shortcut: command.shortcut });
      for (const contribution of host?.contributions ?? []) {
        if (!isHostUiPosition(contribution.position)) continue;
        let values = entries.get(contribution.position);
        if (!values) { values = []; entries.set(contribution.position, values); }
        values.push({ ghost, instanceId, contribution,
          ...(isInlineComposerAction(contribution, host?.views) ? { inlineComposerAction: true } : {}) });
      }
    }
    return { entries: entries.size ? entries : EMPTY, launchers, settings: settings.length ? settings : NO_SETTINGS, active };
}
function compiledDirectory(ghosts: readonly InstalledGhost[]) {
  let value = compiledDirectories.get(ghosts);
  if (!value) { value = compileDirectory(ghosts); compiledDirectories.set(ghosts, value); }
  return value;
}
/** Read the existing owner projection; never subscribe once more at a placement. */
export const readPluginUiEntries = (position: GhostHostUiPosition) => compiledDirectory(readInstalledGhostsSnapshot()).entries.get(position) ?? NO_ENTRIES;
function windowCandidates(ghosts: readonly InstalledGhost[]) {
  const { entries, settings } = compiledDirectory(ghosts);
  return { settings, sidebarSections: entries.get('sidebar.section') ?? NO_ENTRIES,
    titlebarEntries: entries.get('window.titlebar') ?? NO_ENTRIES };
}
/** The existing panel owner feeds changes; the window root adds no subscription. */
export function usePluginUiWindowCandidates() {
  const [candidates, setCandidates] = useState(() => windowCandidates(readInstalledGhostsSnapshot()));
  const current = useRef(candidates);
  const onGhostsChanged = useCallback((ghosts: readonly InstalledGhost[]) => {
    const next = windowCandidates(ghosts), previous = current.current;
    if (previous.settings === next.settings && previous.sidebarSections === next.sidebarSections &&
        previous.titlebarEntries === next.titlebarEntries) return;
    // Broadcasts deserialize the entire roster. Compare only actual window
    // candidates, so an unrelated plugin cannot invalidate the routed shell.
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    current.current = next;
    setCandidates(next);
  }, []);
  return { ...candidates, onGhostsChanged };
}
export function usePluginUiComposerCandidates(allowInline = false) {
  const directory = useContext(DirectoryContext);
  const hasControls = (position: 'composer.header' | 'composer.toolbar') =>
    directory.get(position)?.some(entry => allowInline || !entry.inlineComposerAction && !isDynamicComposerContribution(entry.contribution)) === true;
  const toolbarEntries = directory.get('composer.toolbar') ?? NO_ENTRIES;
  return { header: hasControls('composer.header'),
    toolbar: toolbarEntries.some(entry => !entry.inlineComposerAction),
    inlineToolbar: allowInline && toolbarEntries.some(entry => entry.inlineComposerAction),
    completion: directory.get('composer.completion') ?? NO_ENTRIES };
}

/** One window subscription, compiled only when the original installed projection changes. */
export function PluginUiProvider({ children, host: hostNode, enabled = true }: { children: ReactNode; host?: ReactNode; enabled?: boolean }) {
  const ghosts = useInstalledGhosts(enabled);
  const directory = compiledDirectory(ghosts);
  return <DirectoryContext.Provider value={directory.entries}><LauncherContext.Provider value={directory.launchers}>{directory.active && hostNode}{children}</LauncherContext.Provider></DirectoryContext.Provider>;
}

interface Target {
  disabled?: boolean;
  sessionId?: string | null;
  clientId?: string;
  role?: 'user' | 'assistant';
  tool?: string;
  plugin?: string;
  context?: Record<string, unknown> | (() => Record<string, unknown>);
}
function useEntries(position: GhostHostUiPosition, target: Target): readonly PluginUiEntry[] {
  const directory = useContext(DirectoryContext);
  const entries = directory.get(position);
  const disabled = !!target.disabled || !!target.sessionId && !!getStickySessionDeviceId(target.sessionId);
  const { role, tool, plugin } = target;
  return useMemo(() => !entries || disabled ? NO_ENTRIES : entries.filter(({ contribution: { match } }) =>
    (!match?.roles || !!role && match.roles.includes(role)) &&
    (!match?.tools || !!tool && match.tools.includes(tool)) &&
    (!match?.plugins || !!plugin && match.plugins.includes(plugin))), [entries, disabled, role, tool, plugin]);
}

export const usePluginUiMessageMenuEntries = (target: Target) => useEntries('message.menu', target);

/** Mounted by the existing menu only while it is open; closed history rows have no consumers. */
export function PluginUiMessageMenuItem({ entry, sessionId, clientId, disabled, className, onSelect }: {
  entry: PluginUiEntry; sessionId: string | null; clientId?: string; disabled?: boolean;
  className?: string; onSelect(): void;
}) {
  const interest = useMemo(() => ({ instanceId: entry.instanceId, id: entry.contribution.id, sessionId,
    ...(clientId ? { clientId } : {}) }), [entry.instanceId, entry.contribution.id, sessionId, clientId]);
  const state = usePluginUiControl(interest, entry.ghost);
  if (state?.visible === false) return null;
  return <DropdownMenuItem className={className} disabled={disabled || state?.disabled}
    onSelect={event => { event.stopPropagation(); onSelect(); }}>
    <Puzzle size={14} strokeWidth={2} className="shrink-0" />
    {state?.title ?? entry.contribution.title} · {entry.ghost.manifest.name}
  </DropdownMenuItem>;
}

export async function runPluginUiEntry(entry: PluginUiEntry, sessionId: string | null, value?: string, workingDir?: string): Promise<void> {
  const action = entry.contribution;
  value ??= entry.item?.id;
  if (action.view) return openPluginUiView(entry.instanceId, action.view, sessionId,
    { ...action.arguments, ...(value === undefined ? {} : { value }) }, workingDir);
  if (!action.tool) return;
  const result = await window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action',
    instanceId: entry.instanceId, id: action.id, value });
  if (result && typeof result === 'object' && 'isError' in result && result.isError) throw new Error('MCP_APP_ACTION_FAILED');
}

export async function runPluginUiLauncher(entry: PluginUiLauncher, sessionId: string | null): Promise<void> {
  if (entry.view) return openPluginUiView(entry.instanceId, entry.view, sessionId, entry.input);
  const result = await window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action',
    instanceId: entry.instanceId, id: entry.id, kind: 'command' });
  if (result && typeof result === 'object' && 'isError' in result && result.isError) throw new Error('MCP_APP_ACTION_FAILED');
}

export function PluginUiMenu({ sessionId, ghostId }: { sessionId?: string | null; ghostId?: string }) {
  const launchers = usePluginUiLaunchers().filter(entry => (!ghostId || entry.instanceId === ghostId) && (sessionId || entry.scope !== 'task'));
  const { t } = useTranslation();
  if (!launchers.length || sessionId && getStickySessionDeviceId(sessionId)) return null;
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary" tone="quiet" size="sm" style={WINDOW_NO_DRAG_STYLE}>{t('pluginUi.menu')}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">{launchers.map(entry => <DropdownMenuItem key={`${entry.instanceId}:${entry.kind}:${entry.id}`}
      onSelect={() => void runPluginUiLauncher(entry, sessionId ?? null).catch(() => toast.error(t('pluginUi.actionFailed')))}>
      {entry.title} · {entry.ghost.manifest.name}
    </DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
}

/** Only an open menu with actual candidates mounts this live directory consumer. */
export function PluginUiSessionMenuItems({ sessionId, disabled, className }: { sessionId: string; disabled: boolean; className?: string }) {
  const entries = useEntries('session.menu', { sessionId });
  const { t } = useTranslation();
  if (!entries.length) return null;
  return <><DropdownMenuSeparator />{entries.map(entry => <PluginUiMessageMenuItem
    key={`${entry.instanceId}:${entry.contribution.id}`} entry={entry} sessionId={sessionId}
    disabled={disabled} className={className} onSelect={() => void runPluginUiEntry(entry, sessionId)
      .catch(() => toast.error(t('pluginUi.actionFailed')))} />)}</>;
}

function workdirPageKey(entry: PluginUiEntry) {
  return JSON.stringify([entry.instanceId, ghostInstallApprovalToken(entry.ghost.approval), entry.contribution.id,
    ...(entry.item ? [entry.item.id] : [])]);
}

type ComposerRun = NonNullable<ReturnType<typeof registerPluginUiComposerAction>> & {
  editor: Editor; sessionId: string; entry: PluginUiEntry; key: string; title: string; viewId: string;
  trigger: HTMLButtonElement;
  startedAt: number;
};
type ComposerNotice = ComposerActionOutcome & { sessionId: string; editor: Editor };
type ComposerActionScope = {
  sessionId: string; editor: Editor; disabled: boolean; running: ComposerRun | null; notice: ComposerNotice | null;
  queued: readonly string[];
  open(entry: PluginUiEntry, key: string, title: string, trigger: HTMLButtonElement): void;
  close(key?: string): void;
  finish(run: ComposerRun, outcome: ComposerActionOutcome): void;
  retain(key: string): () => void;
};
const ComposerActionContext = createContext<ComposerActionScope | null>(null);
type ControlAppearance = 'navigation' | 'rail' | 'titlebar' | 'composer-header' | 'composer-toolbar';
const HEADER_BUTTON = 'w-full min-w-0 px-2.5 text-12 font-normal';
const HEADER_ICON_BUTTON = 'w-full min-w-0 px-0';
const HEADER_OVERFLOW_MAX_WIDTH = 416;
const HEADER_TOOLTIP_CLASS = 'max-w-[min(20rem,calc(100vw-1rem))]';

function ComposerHeaderLabel({ title, icon }: { title: string; icon?: string }) {
  const Icon = icon === 'sparkles' ? Sparkles : MAIN_VIEW_ICONS[icon as keyof typeof MAIN_VIEW_ICONS] ?? Puzzle;
  return icon ? <Icon size={14} aria-hidden="true" /> : <span className="min-w-0 truncate">{title}</span>;
}

/** The two native positions share one action owner, scoped to this editor. */
export function PluginUiComposerActionScope({ sessionId, editor, disabled, children }: {
  sessionId: string | null; editor: Editor | null; disabled: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const current = useRef<ComposerRun | null>(null);
  const pending = useRef<ComposerRun[]>([]);
  const presenters = useRef(new Map<string, number>());
  const alive = useRef(true);
  const [running, setRunning] = useState<ComposerRun | null>(null);
  const [queued, setQueued] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  const advance = useCallback(() => {
    if (!alive.current || current.current) return;
    const next = pending.current.shift() ?? null;
    if (next) next.startedAt = performance.now();
    current.current = next;
    setRunning(next);
    setQueued(pending.current.map(run => run.key));
  }, []);
  const close = useCallback((key?: string) => {
    if (!current.current && !pending.current.length || key !== undefined &&
        current.current?.key !== key && !pending.current.some(run => run.key === key)) return;
    const remaining: ComposerRun[] = [];
    for (const item of pending.current) {
      if (key === undefined || item.key === key) item.release();
      else remaining.push(item);
    }
    pending.current = remaining;
    setQueued(remaining.map(run => run.key));
    const run = current.current;
    if (run && (key === undefined || run.key === key)) {
      run.release();
      current.current = null;
      setRunning(null);
    }
    if (key !== undefined) advance();
  }, [advance]);
  const retain = useCallback((key: string) => {
    presenters.current.set(key, (presenters.current.get(key) ?? 0) + 1);
    return () => {
      const count = (presenters.current.get(key) ?? 1) - 1;
      if (count) presenters.current.set(key, count);
      else { presenters.current.delete(key); close(key); }
    };
  }, [close]);
  const finish = useCallback((run: ComposerRun, outcome: ComposerActionOutcome) => {
    if (current.current !== run) return;
    run.release();
    current.current = null;
    advance();
    setNotice({ ...outcome, sessionId: run.sessionId, editor: run.editor });
    if (outcome.status === 'error') toast.error(outcome.message || t('pluginUi.actionFailed'));
    const focused = document.activeElement;
    if (!current.current && focused === run.trigger) {
      if (outcome.status === 'success' && !run.editor.isDestroyed && run.editor.isEditable) run.editor.view.focus();
      else if (run.trigger.isConnected) run.trigger.focus();
    }
  }, [advance, t]);
  const open = useCallback((entry: PluginUiEntry, key: string, title: string, trigger: HTMLButtonElement) => {
    const { id: contributionId, view: viewId } = entry.contribution;
    if (!sessionId || !editor || !viewId || disabled || current.current?.key === key || pending.current.some(run => run.key === key)) return;
    const queue = entry.contribution.concurrency === 'queue';
    if (!queue || current.current?.entry.contribution.concurrency !== 'queue') close();
    if (pending.current.length >= PLUGIN_UI_INTEREST_LIMIT) { toast.error(t('pluginUi.actionFailed')); return; }
    setNotice(null);
    const registration = registerPluginUiComposerAction(sessionId, editor, { instanceId: entry.instanceId, contributionId },
      outcome => finish(run, outcome));
    if (!registration) return;
    const run = { ...registration, editor, sessionId, entry, key, title, viewId, trigger, startedAt: 0 };
    pending.current.push(run);
    setQueued(pending.current.map(item => item.key));
    advance();
  }, [sessionId, editor, disabled, close, finish, advance, t]);
  useLayoutEffect(() => {
    if (disabled || running && (running.sessionId !== sessionId || running.editor !== editor)) close();
  }, [sessionId, editor, disabled, close, running]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      current.current?.release();
      current.current = null;
      for (const run of pending.current) run.release();
      pending.current = [];
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    const remaining = Math.max(0, GHOST_PIPE_CALL_MAX_TOTAL_MS - (performance.now() - running.startedAt));
    const timer = setTimeout(() => finish(running, { status: 'error' }), remaining);
    return () => clearTimeout(timer);
  }, [running, finish]);
  const scope = useMemo(() => sessionId && editor ? {
    sessionId, editor, disabled, open, close, finish, retain, queued,
    running: !disabled && running?.sessionId === sessionId && running.editor === editor ? running : null,
    notice: notice?.sessionId === sessionId && notice.editor === editor ? notice : null,
  } : null, [sessionId, editor, disabled, open, close, finish, retain, queued, running, notice]);
  return <ComposerActionContext.Provider value={scope}>{children}</ComposerActionContext.Provider>;
}

export function PluginUiComposerActionStatus() {
  const scope = useContext(ComposerActionContext);
  const { t } = useTranslation();
  const run = scope?.running, notice = scope?.notice;
  if (!scope || !run && !notice) return null;
  return <>
    <span role="status" className="sr-only">
      {run ? `${run.title} · ${t('chat.ghostHook.processing')}`
        : notice?.message || t(notice?.status === 'error' ? 'pluginUi.actionFailed' : 'newChat.permissionPrompt.mcpComplete')}
    </span>
    {run && <div className="sr-only" aria-hidden="true" inert>
      <Suspense><PluginUiView key={run.id} ghost={run.entry.ghost} viewId={run.viewId} sessionId={run.sessionId}
        chrome="panel" composerAction={{ id: run.id, contributionId: run.entry.contribution.id }}
        input={{ ...run.entry.contribution.arguments, ...(run.entry.item ? { value: run.entry.item.id } : {}) }}
        onUnavailable={() => scope.finish(run, { status: 'error' })} /></Suspense>
    </div>}
  </>;
}

function InlineComposerActionButton({ entry, active, disabled, title, controlTitle }: {
  entry: PluginUiEntry; active: boolean; disabled: boolean; title: string; controlTitle: string;
}) {
  const scope = useContext(ComposerActionContext);
  const key = workdirPageKey(entry);
  const close = scope?.close;
  const retain = scope?.retain;
  const unavailable = !active || disabled || scope?.disabled;
  useLayoutEffect(() => {
    if (unavailable) { close?.(key); return; }
    return retain?.(key);
  }, [close, retain, key, unavailable]);
  if (!scope) return null;
  const { position, icon } = entry.contribution;
  const header = position === 'composer.header';
  const iconOnly = header && Boolean(icon);
  const running = scope.running?.key === key || scope.queued.includes(key);
  const Icon = icon === 'sparkles' ? Sparkles : MAIN_VIEW_ICONS[icon as keyof typeof MAIN_VIEW_ICONS] ?? Puzzle;
  const label = header ? <ComposerHeaderLabel title={title} icon={icon} />
    : <Icon size={16} />;
  const button = <Button variant="secondary" tone={header && !iconOnly ? 'default' : 'quiet'} size={header ? 'xs' : 'sm'}
    compact={header} type="button" disabled={unavailable}
    className={header ? (iconOnly ? HEADER_ICON_BUTTON : HEADER_BUTTON) : 'w-7 shrink-0 px-0'}
    aria-label={!header || iconOnly ? title : undefined}
    aria-busy={running}
    onMouseDown={event => { if (event.button === 0 && scope.editor.isFocused) event.preventDefault(); }}
    onClick={event => scope.open(entry, key, title, event.currentTarget)}>
    {running && (!header || iconOnly) ? <Spinner size={header ? 14 : 16} /> : label}
  </Button>;
  return <Tip text={header ? controlTitle : title} contentClassName={header ? HEADER_TOOLTIP_CLASS : undefined}>{button}</Tip>;
}

function WorkdirPopoverPage({ entry, sessionId, path, close }: {
  entry: PluginUiEntry; sessionId: string; path: string; close(): void;
}) {
  const { id, view, arguments: input } = entry.contribution;
  const context = useMemo(() => ({ workingDir: path }), [path]);
  const interest = useMemo(() => ({ instanceId: entry.instanceId, id, sessionId }), [entry.instanceId, id, sessionId]);
  const state = usePluginUiControl(interest, entry.ghost);
  const unavailable = !view || state?.disabled || state?.visible === false;
  useEffect(() => { if (unavailable) close(); }, [unavailable, close]);
  if (unavailable) return null;
  return <Suspense fallback={<Spinner size={16} />}><PluginUiView chrome="panel" ghost={entry.ghost} viewId={view}
    sessionId={sessionId} composerPlacement={JSON.stringify([id])} input={input} context={context} onUnavailable={close} /></Suspense>;
}

/** Keep the native directory action as the only click target until a plugin contributes. */
export function PluginUiWorkdirButton({ sessionId, path, children, onOpenDirectory }: {
  sessionId: string; path: string; children: ReactNode; onOpenDirectory(): void;
}) {
  const entries = useEntries('workdir.menu', { sessionId });
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openLabel = t('ccAgent.layout.openWorkingDirAria');
  const buttonClass = 'flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-opacity active:opacity-60';
  const close = useCallback(() => setSelected(null), []);
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const anchor = trigger.current;
    if (anchor) return observeSlotVisibility(anchor, visible => { if (!visible) close(); });
  }, [hasEntries, close]);
  const page = selected ? entries.find(entry => workdirPageKey(entry) === selected) : undefined;
  useEffect(() => { if (selected && !page) close(); }, [selected, page, close]);
  if (!hasEntries) return <Tip text={path} mono side="top"><button type="button" className={buttonClass}
    onClick={onOpenDirectory} aria-label={openLabel}>{children}</button></Tip>;
  return <Popover open={!!page} onOpenChange={open => { if (!open) close(); }}>
    <DropdownMenu><PopoverAnchor asChild><DropdownMenuTrigger asChild>
      <Tip text={path} mono side="top"><button ref={trigger} type="button" className={buttonClass}>
        {children}<ChevronDown size={12} className="shrink-0 text-[var(--workingdir-icon)]" />
      </button></Tip>
    </DropdownMenuTrigger></PopoverAnchor>
    <DropdownMenuContent side="top" align="start" onCloseAutoFocus={event => { if (page) event.preventDefault(); }}>
      <DropdownMenuItem className="gap-2" onSelect={onOpenDirectory}><FolderOpen size={14} />{openLabel}</DropdownMenuItem>
      <DropdownMenuSeparator />
      {entries.map(entry => <PluginUiMessageMenuItem key={workdirPageKey(entry)} className="gap-2"
        entry={entry} sessionId={sessionId} onSelect={() => {
          if (entry.contribution.presentation === 'popover' && entry.contribution.view) setSelected(workdirPageKey(entry));
          else void runPluginUiEntry(entry, sessionId, undefined, path).catch(() => toast.error(t('pluginUi.actionFailed')));
        }} />)}
    </DropdownMenuContent></DropdownMenu>
    {page && page.contribution.view && <PopoverContent align="start" side="top" aria-label={page.contribution.title}
      className="w-[min(26rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2"
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
      <WorkdirPopoverPage entry={page} sessionId={sessionId} path={path} close={close} />
    </PopoverContent>}
  </Popover>;
}

function EntryControl({ entry, sessionId, clientId, active, appearance }: { entry: PluginUiEntry; sessionId: string | null; clientId?: string; active: boolean; appearance?: ControlAppearance }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const action = entry.contribution;
  const interest = useMemo(() => ({ instanceId: entry.instanceId, id: action.id, sessionId,
    ...(clientId ? { clientId } : {}) }), [entry.instanceId, action.id, sessionId, clientId]);
  const observedState = usePluginUiControl(interest, entry.ghost, active && !entry.item);
  const state = entry.itemState ?? observedState;
  const visible = state?.visible ?? action.visible ?? !entry.inlineComposerAction;
  useEffect(() => { if (!active || state?.disabled || !visible) setOpen(false); }, [active, state?.disabled, visible]);
  const run = async (next?: string) => {
    if (pending || state?.disabled) return;
    setPending(true);
    try { await runPluginUiEntry(entry, sessionId, next); if (next !== undefined) setValue(next); }
    catch { toast.error(t('pluginUi.actionFailed')); }
    finally { setPending(false); }
  };
  if (!visible) return null;
  const title = state?.title ?? action.title;
  const header = appearance === 'composer-header';
  const iconOnly = header && Boolean(action.icon);
  const sourceTitle = pluginSourceTooltip(entry.ghost.manifest.name, entry.ghost.installationSource, t);
  const controlTitle = header ? `${title} · ${sourceTitle}` : sourceTitle;
  const buttonClass = header ? (iconOnly ? HEADER_ICON_BUTTON : HEADER_BUTTON) : action.position === 'statusbar'
    ? (action.fontSize === 14 ? 'text-14' : action.fontSize === 13 ? 'text-13' : 'text-12') : undefined;
  const label = header ? <ComposerHeaderLabel title={title} icon={action.icon} /> : title;
  const Icon = MAIN_VIEW_ICONS[action.icon as keyof typeof MAIN_VIEW_ICONS] ?? Puzzle;
  if (entry.inlineComposerAction) {
    return <InlineComposerActionButton entry={entry} active={active} disabled={state?.disabled === true}
      title={title} controlTitle={controlTitle} />;
  }
  if (appearance === 'titlebar') {
    const view = action.view && getApprovedGhostHostUi(entry.ghost)?.views?.find(view => view.id === action.view);
    const unavailable = !!sessionId && !!getStickySessionDeviceId(sessionId) || !!view && view.scope === 'task' && !sessionId;
    return <ChromeIconButton aria-label={`${title} · ${entry.ghost.manifest.name}`} tooltipSide="bottom"
      disabled={pending || state?.disabled || unavailable} onClick={() => void run()} className="shrink-0">
      <Icon size={14} />
    </ChromeIconButton>;
  }
  if (appearance === 'rail') return <SidebarIconButton icon={Icon} label={`${title} · ${entry.ghost.manifest.name}`}
    disabled={pending || state?.disabled} onClick={() => void run()} />;
  if (appearance === 'navigation') return <button type="button" disabled={pending || state?.disabled} onClick={() => void run()}
    aria-label={`${title} · ${entry.ghost.manifest.name}`} title={sourceTitle}
    className="flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover disabled:opacity-40">
    <Icon size={15} strokeWidth={1.8} className="shrink-0" /><span className="truncate">{title}</span>
  </button>;
  if (action.kind === 'status') return <span role="status" className={`text-12 text-[var(--text-secondary)] ${header ? 'w-full truncate text-center' : ''}`}
    title={controlTitle}>{title}</span>;
  if (action.kind === 'select') return <Select label={title} value={state?.value ?? value} options={action.options ?? []}
    disabled={pending || state?.disabled} onValueChange={next => void run(next)} size="inline" width={header ? 'full' : undefined}
    className="max-w-48 text-12" />;
  if (action.presentation === 'popover' && action.view) return <Popover open={open && active} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Tip text={header ? controlTitle : null} contentClassName={HEADER_TOOLTIP_CLASS}>
      <Button variant="secondary" tone={header && !iconOnly ? 'default' : 'quiet'} size={header ? 'xs' : 'sm'} compact={header} disabled={state?.disabled}
        className={buttonClass} aria-label={iconOnly ? title : undefined} title={header ? undefined : controlTitle}>{label}</Button>
    </Tip></PopoverTrigger>
    <PopoverContent align="start" side={action.position === 'composer.header' || action.position === 'composer.toolbar' || action.position === 'statusbar' ? 'top' : 'bottom'}
      aria-label={title} className="w-[min(26rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2">
      {open && active && <Suspense fallback={<Spinner size={16} />}><PluginUiView chrome="panel" ghost={entry.ghost} viewId={action.view}
        sessionId={sessionId} composerPlacement={JSON.stringify([action.id, clientId])}
        input={{ ...action.arguments, ...(entry.item ? { value: entry.item.id } : {}) }} onUnavailable={() => setOpen(false)} /></Suspense>}
    </PopoverContent>
  </Popover>;
  const button = <Button variant="secondary" tone={header && !iconOnly ? 'default' : 'quiet'} size={header ? 'xs' : 'sm'} compact={header}
    disabled={pending || state?.disabled} title={header ? undefined : controlTitle} aria-label={iconOnly ? title : undefined}
    className={buttonClass} onClick={() => void run()}>{pending && iconOnly ? <Spinner size={14} /> : label}</Button>;
  return header ? <Tip text={controlTitle} contentClassName={HEADER_TOOLTIP_CLASS}>{button}</Tip> : button;
}

/** No candidate means no View, effect, IPC, SQL or plugin callback. */
export function PluginUiSlot({ position, toolbarGroup, ...target }: Target & {
  position: GhostHostUiPosition; toolbarGroup?: 'inline' | 'legacy';
}) {
  const candidates = useEntries(position, target);
  const entries = toolbarGroup === undefined ? candidates
    : candidates.filter(entry => Boolean(entry.inlineComposerAction) === (toolbarGroup === 'inline'));
  if (!entries.length) return null;
  const appearance = position === 'composer.header' ? 'composer-header' : position === 'composer.toolbar' ? 'composer-toolbar' : undefined;
  const props = { entries, sessionId: target.sessionId ?? null, clientId: target.clientId, appearance } as const;
  return appearance ? <ComposerSlotControls {...props} /> : <PluginUiSlotControls {...props} />;
}

function ComposerSlotControls(props: Parameters<typeof PluginUiSlotControls>[0]) {
  const composer = useContext(ComposerActionContext);
  const entries = composer && composer.sessionId === props.sessionId
    ? props.entries : props.entries.filter(entry => !entry.inlineComposerAction && !isDynamicComposerContribution(entry.contribution));
  return entries.length ? <PluginUiSlotControls {...props} entries={entries} /> : null;
}

function ComposerHeaderControls({ entries, sessionId, clientId }: Parameters<typeof PluginUiSlotControls>[0]) {
  const { t } = useTranslation();
  const row = useRef<HTMLSpanElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState(false);
  const [overflow, setOverflow] = useState<{ keys: string[]; width: number; offset: number }>({ keys: [], width: 0, offset: 0 });
  const [open, setOpen] = useState(false);
  const templates = useMemo(() => entries.filter(entry => isDynamicComposerContribution(entry.contribution)), [entries]);
  const interests = useMemo(() => templates.map(entry => ({ instanceId: entry.instanceId, id: entry.contribution.id,
    sessionId: sessionId ?? null, ...(clientId ? { clientId } : {}) })), [templates, sessionId, clientId]);
  const states = usePluginUiControlStates(interests, active);
  const controls = useMemo(() => {
    const collections = new Map(templates.map((entry, index) => [entry, states[index]]));
    return entries.flatMap(entry => {
      if (!isDynamicComposerContribution(entry.contribution)) return [entry];
      const state = collections.get(entry);
      if ((state?.visible ?? entry.contribution.visible) !== true) return [];
      return (state?.items ?? []).filter(item => item.visible !== false).map(item => ({ ...entry, item,
        contribution: { ...entry.contribution, title: item.title, icon: item.icon ?? entry.contribution.icon },
        itemState: { ...state, title: item.title, visible: true, disabled: state?.disabled || item.disabled },
      }));
    });
  }, [entries, templates, states]);
  const entryKey = (entry: PluginUiEntry) => `${entry.instanceId}:${entry.contribution.id}${entry.item ? `:${JSON.stringify(entry.item.id)}` : ''}`;
  useEffect(() => {
    const element = row.current;
    if (element) return observeSlotVisibility(element.closest('[data-chat-input-root], [data-plugin-ui-task]')
      ?? element.parentElement ?? element, setActive);
  }, []);
  useLayoutEffect(() => {
    const element = row.current;
    const trigger = more.current;
    if (!element || !trigger || typeof ResizeObserver === 'undefined') return;
    const boundary = element.closest('[data-composer-status-row]') ?? element;
    const items = Array.from(element.querySelectorAll<HTMLElement>(':scope > [data-header-control]'));
    const measure = () => {
      const lane = element.getBoundingClientRect();
      const available = lane.width;
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
      const widths = items.map(item => ({ key: item.dataset.headerControl!, width: item.getBoundingClientRect().width }))
        .filter(item => item.width > 0);
      const total = widths.reduce((sum, item) => sum + item.width, 0) + Math.max(0, widths.length - 1) * gap;
      const keys: string[] = [];
      let used = trigger.getBoundingClientRect().width;
      if (available && total > available) {
        for (const item of widths) {
          const needed = used + gap + item.width;
          if (needed <= available) used = needed;
          else keys.push(item.key);
        }
      }
      const bounds = boundary === element ? lane : boundary.getBoundingClientRect();
      const hidden = new Set(keys);
      const hiddenWidths = widths.filter(item => hidden.has(item.key));
      const contentWidth = hiddenWidths.reduce((sum, item) => sum + item.width, 0) + Math.max(0, keys.length - 1) * gap;
      // Content-sized shelf; only wrap once its bounded width is exhausted.
      const width = keys.length ? Math.min(HEADER_OVERFLOW_MAX_WIDTH, bounds.width, Math.ceil(contentWidth + 10)) : 0;
      const triggerLeft = lane.right - used;
      const offset = keys.length ? Math.max(bounds.left, Math.min(triggerLeft, bounds.right - width)) - triggerLeft : 0;
      setOverflow(previous => previous.width === width && previous.offset === offset &&
        previous.keys.length === keys.length && keys.every((key, index) => previous.keys[index] === key)
        ? previous : { keys, width, offset });
      if (!keys.length) setOpen(false);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (boundary !== element) observer.observe(boundary);
    observer.observe(trigger);
    items.forEach(item => observer.observe(item));
    measure();
    return () => observer.disconnect();
  }, [controls]);
  const hiddenKeys = new Set(overflow.keys);
  const hiddenEntries = controls.filter(entry => hiddenKeys.has(entryKey(entry)));
  const moreLabel = t('sidebar.navigation.more');
  const controlWidth = (entry: PluginUiEntry) => entry.contribution.icon && (entry.contribution.kind ?? 'button') === 'button'
    ? 'w-6' : 'w-max min-w-16 max-w-36';
  const control = (entry: PluginUiEntry) => <EntryControl entry={entry} sessionId={sessionId ?? null}
    clientId={clientId} active={active} appearance="composer-header" />;
  return <span ref={row} data-plugin-composer-header=""
    className="relative hidden h-8 w-full min-w-0 flex-row-reverse items-center gap-1.5 [container-type:inline-size] [-webkit-app-region:no-drag] [&:has([data-header-control]:not(:empty))]:flex">
    {controls.map(entry => {
      const key = entryKey(entry);
      const hidden = hiddenKeys.has(key);
      return <span key={key} data-header-control={key} inert={hidden}
        className={`inline-flex ${controlWidth(entry)} shrink-0 empty:hidden ${hidden ? 'invisible absolute right-0' : ''}`}>
        {control(entry)}
      </span>;
    })}
    <Popover open={open && hiddenEntries.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button ref={more} variant="secondary" size="xs" compact type="button" tabIndex={hiddenEntries.length ? undefined : -1}
          aria-hidden={hiddenEntries.length ? undefined : true} aria-label={moreLabel} title={moreLabel}
          className={`max-w-full text-12 font-normal [@container(max-width:72px)]:gap-0.5 [@container(max-width:72px)]:px-1 ${hiddenEntries.length ? 'shrink-0' : 'invisible absolute right-0'}`}>
          <span className="min-w-0 truncate">{moreLabel}</span><ChevronDown size={12} className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" alignOffset={overflow.offset} avoidCollisions={false}
        style={{ width: overflow.width }}
        aria-label={moreLabel}
        className="flex max-h-[min(10rem,var(--radix-popover-content-available-height))] flex-row-reverse flex-wrap items-center justify-start gap-1.5 overflow-y-auto p-1">
        {hiddenEntries.map(entry => <div key={entryKey(entry)} className={`inline-flex ${controlWidth(entry)} shrink-0`}>{control(entry)}</div>)}
      </PopoverContent>
    </Popover>
  </span>;
}

export function PluginUiSlotControls({ entries, sessionId = null, clientId, appearance }: {
  entries: readonly PluginUiEntry[]; sessionId?: string | null; clientId?: string;
  appearance?: ControlAppearance;
}) {
  if (appearance === 'composer-header') return <ComposerHeaderControls entries={entries} sessionId={sessionId} clientId={clientId} />;
  return <ObservedPluginUiSlotControls entries={entries} sessionId={sessionId} clientId={clientId} appearance={appearance} />;
}

function ObservedPluginUiSlotControls({ entries, sessionId = null, clientId, appearance }: {
  entries: readonly PluginUiEntry[]; sessionId?: string | null; clientId?: string; appearance?: ControlAppearance;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  const hasInline = entries.some(entry => entry.inlineComposerAction);
  useEffect(() => {
    const element = root.current;
    // Observe the original message row, whose size is independent of a plugin hiding its control.
    if (element) return observeSlotVisibility(
      element.closest(hasInline ? '[data-chat-input-root]' : '[data-message-client-id]') ?? element.parentElement ?? element, setActive);
  }, [hasInline]);
  return <span ref={root}
    data-plugin-composer-toolbar={appearance === 'composer-toolbar' ? '' : undefined}
    className={appearance === 'navigation'
    ? 'flex min-w-0 flex-col gap-0.5 [-webkit-app-region:no-drag]'
    : appearance === 'titlebar' ? 'inline-flex min-w-0 max-w-[min(16rem,30vw)] flex-nowrap items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]'
      : `inline-flex min-w-0 flex-wrap items-center gap-1 [-webkit-app-region:no-drag] ${appearance === 'composer-toolbar' ? 'empty:hidden' : ''}`}>
    {entries.map(entry => <EntryControl key={`${entry.instanceId}:${entry.contribution.id}`} entry={entry}
      sessionId={sessionId} clientId={clientId} active={active} appearance={appearance} />)}
  </span>;
}

export function PluginUiSidebarSections({ entries, sessionId }: { entries: readonly PluginUiEntry[]; sessionId: string | null }) {
  return <div className="max-h-[45%] shrink-0 overflow-y-auto px-3 pb-2">
    {entries.map(entry => <PluginUiSidebarSection key={`${entry.instanceId}:${entry.contribution.id}`} entry={entry} sessionId={sessionId} />)}
  </div>;
}
function PluginUiSidebarSection({ entry, sessionId }: { entry: PluginUiEntry; sessionId: string | null }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (element) return observeSlotVisibility(element.closest('aside') ?? element.parentElement ?? element, setVisible);
  }, []);
  const state = usePluginUiControl(useMemo(() => ({ instanceId: entry.instanceId, id: entry.contribution.id,
    sessionId }), [entry.instanceId, entry.contribution.id, sessionId]), entry.ghost, visible);
  const view = getApprovedGhostHostUi(entry.ghost)?.views?.find(view => view.id === entry.contribution.view);
  const available = !!view && (view.scope !== 'task' || sessionId && !getStickySessionDeviceId(sessionId));
  const title = `${state?.title ?? entry.contribution.title} · ${entry.ghost.manifest.name}`;
  if (state?.visible === false) return null;
  return <div ref={root} className="min-w-0">
    {/* Ordinary action hover frame: DESIGN §5 Step 2 pill; the chevron is an intrinsic icon. */}
    <button type="button" aria-expanded={expanded} disabled={!available || state?.disabled}
      onClick={() => setExpanded(value => !value)} title={pluginSourceTooltip(entry.ghost.manifest.name, entry.ghost.installationSource, t)}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-full px-2 text-left text-12 text-[var(--text-secondary)] hover:bg-sidebar-item-hover disabled:opacity-40">
      {expanded ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
      <span className="truncate">{title}</span>
    </button>
    <SectionCollapse collapsed={!expanded} inert={!expanded}>
      {visible && available && <Suspense fallback={<Spinner size={16} />}><PluginUiView chrome="panel" sizing="sidebar-section" ghost={entry.ghost}
        viewId={view!.id} composerPlacement={JSON.stringify([entry.contribution.id])} sessionId={view!.scope === 'task' ? sessionId : null} input={entry.contribution.arguments} /></Suspense>}
    </SectionCollapse>
  </div>;
}

/** One explicit selection owns the body; the original stays the default and fallback. */
export function PluginUiBody({ children, position, ...target }: Target & { children: ReactNode; position: 'message.body' | 'tool.body' }) {
  const entries = useEntries(position, target);
  if (!entries.length || !target.sessionId) return <>{children}</>;
  return <PluginUiBodyChoice entries={entries} sessionId={target.sessionId} clientId={target.clientId} context={target.context}>{children}</PluginUiBodyChoice>;
}

/** Return the original element itself when the list has no candidate for this body. */
export function renderPluginUiBody(options: (Target & { position: 'message.body' | 'tool.body' }) | undefined, children: ReactNode): ReactNode {
  return options ? <PluginUiBody {...options}>{children}</PluginUiBody> : children;
}

function PluginUiBodyChoice({ children, entries, sessionId, clientId, context }: {
  children: ReactNode; entries: readonly PluginUiEntry[]; sessionId: string; clientId?: string; context?: Target['context'];
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('original');
  const entry = entries.find(entry => `${entry.instanceId}:${entry.contribution.id}` === selected);
  return <>
    <div className="mb-1 flex min-w-0 items-center gap-1">
      <Select label={t('pluginUi.display')} value={entry ? selected : 'original'} size="inline" className="max-w-56 text-12"
        options={[{ value: 'original', label: t('pluginUi.original') }, ...entries.map(entry => ({
          value: `${entry.instanceId}:${entry.contribution.id}`, label: `${entry.contribution.title} · ${entry.ghost.manifest.name}`,
        }))]} onValueChange={setSelected} />
    </div>
    {entry?.contribution.view ? <Suspense fallback={children}><PluginUiView ghost={entry.ghost} viewId={entry.contribution.view}
      sessionId={sessionId} composerPlacement={JSON.stringify([entry.contribution.id, clientId])} input={entry.contribution.arguments} context={context} onUnavailable={() => setSelected('original')} /></Suspense> : children}
  </>;
}
