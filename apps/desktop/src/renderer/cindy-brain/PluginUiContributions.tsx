import { pluginSourceTooltip } from '@cindy/maker-shared/mcp-apps';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isHostUiPosition, type GhostHostUiContribution, type GhostHostUiPosition } from '@cindy/plugin-protocol';
import { getApprovedGhostHostUi, ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { useInstalledGhosts, readInstalledGhostsSnapshot } from './useInstalledGhosts';
import { usePluginUiControl } from './pluginUiControls';
import { useWorkdirDisabledGhostIds } from './ghostWorkdirFilter';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { ChevronDown, ChevronRight, FolderOpen, Puzzle } from 'lucide-react';
import { SidebarIconButton } from '@/components/sidebar/SidebarIconButton';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { MAIN_VIEW_ICONS } from './mainViewIcons';
import { isPluginUiElementVisible, subscribePluginUiRegions } from './pluginUiVisibility';
const PluginUiView = lazy(() => import('./PluginUiView').then(module => ({ default: module.PluginUiView })));
const openPluginUiView = async (instanceId: string, viewId: string, sessionId: string | null, input?: Record<string, unknown>, workingDir?: string) =>
  (await import('@/features/right-sidebar/lib/openPluginUiView')).openPluginUiView(instanceId, viewId, sessionId, input, workingDir);
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type PluginUiEntry = { ghost: InstalledGhost; instanceId: string; contribution: GhostHostUiContribution };
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
        values.push({ ghost, instanceId: installedGhostStoragePart(ghost), contribution });
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
export function usePluginUiComposerCandidates() {
  const directory = useContext(DirectoryContext);
  return { header: !!directory.get('composer.header')?.length,
    toolbar: !!directory.get('composer.toolbar')?.length, completion: directory.get('composer.completion') ?? NO_ENTRIES };
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
  if (!entries || target.disabled || target.sessionId && getStickySessionDeviceId(target.sessionId)) return NO_ENTRIES;
  return entries.filter(({ contribution: { match } }) =>
    (!match?.roles || !!target.role && match.roles.includes(target.role)) &&
    (!match?.tools || !!target.tool && match.tools.includes(target.tool)) &&
    (!match?.plugins || !!target.plugin && match.plugins.includes(target.plugin)));
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
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary" tone="quiet" size="sm">{t('pluginUi.menu')}</Button></DropdownMenuTrigger>
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
  return JSON.stringify([entry.instanceId, ghostInstallApprovalToken(entry.ghost.approval), entry.contribution.id]);
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

function EntryControl({ entry, sessionId, clientId, active, appearance }: { entry: PluginUiEntry; sessionId: string | null; clientId?: string; active: boolean; appearance?: 'navigation' | 'rail' | 'titlebar' | 'composer-header' }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const action = entry.contribution;
  const interest = useMemo(() => ({ instanceId: entry.instanceId, id: action.id, sessionId,
    ...(clientId ? { clientId } : {}) }), [entry.instanceId, action.id, sessionId, clientId]);
  const state = usePluginUiControl(interest, entry.ghost, active);
  useEffect(() => { if (!active || state?.disabled || state?.visible === false) setOpen(false); }, [active, state?.disabled, state?.visible]);
  const run = async (next?: string) => {
    if (pending || state?.disabled) return;
    setPending(true);
    try { await runPluginUiEntry(entry, sessionId, next); if (next !== undefined) setValue(next); }
    catch { toast.error(t('pluginUi.actionFailed')); }
    finally { setPending(false); }
  };
  if (state?.visible === false) return null;
  const title = state?.title ?? action.title;
  const header = appearance === 'composer-header';
  const sourceTitle = pluginSourceTooltip(entry.ghost.manifest.name, entry.ghost.installationSource, t);
  const controlTitle = header ? `${title} · ${sourceTitle}` : sourceTitle;
  const buttonClass = header ? 'max-w-48' : action.position === 'statusbar'
    ? (action.fontSize === 14 ? 'text-14' : action.fontSize === 13 ? 'text-13' : 'text-12') : undefined;
  const label = header ? <span className="min-w-0 truncate">{title}</span> : title;
  const Icon = MAIN_VIEW_ICONS[action.icon as keyof typeof MAIN_VIEW_ICONS] ?? Puzzle;
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
  if (action.kind === 'status') return <span className={header ? 'max-w-48 shrink-0 truncate text-12 text-[var(--text-secondary)]' : 'text-12 text-[var(--text-secondary)]'} title={controlTitle}>{title}</span>;
  if (action.kind === 'select') return <Select label={title} value={state?.value ?? value} options={action.options ?? []}
    disabled={pending || state?.disabled} onValueChange={next => void run(next)} size="inline" className="max-w-48 text-12" />;
  if (action.presentation === 'popover' && action.view) return <Popover open={open && active} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="secondary" tone="quiet" size="sm" disabled={state?.disabled}
      className={buttonClass} title={controlTitle}>{label}</Button></PopoverTrigger>
    <PopoverContent align="start" side={action.position === 'composer.header' || action.position === 'composer.toolbar' || action.position === 'statusbar' ? 'top' : 'bottom'}
      aria-label={title} className="w-[min(26rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2">
      {open && active && <Suspense fallback={<Spinner size={16} />}><PluginUiView chrome="panel" ghost={entry.ghost} viewId={action.view}
        sessionId={sessionId} composerPlacement={JSON.stringify([action.id, clientId])} input={action.arguments} onUnavailable={() => setOpen(false)} /></Suspense>}
    </PopoverContent>
  </Popover>;
  return <Button variant="secondary" tone="quiet" size="sm" disabled={pending || state?.disabled} title={controlTitle}
    className={buttonClass} onClick={() => void run()}>{label}</Button>;
}

/** No candidate means no View, effect, IPC, SQL or plugin callback. */
export function PluginUiSlot({ position, ...target }: Target & { position: GhostHostUiPosition }) {
  const entries = useEntries(position, target);
  if (!entries.length) return null;
  return <PluginUiSlotControls entries={entries} sessionId={target.sessionId ?? null} clientId={target.clientId}
    appearance={position === 'composer.header' ? 'composer-header' : undefined} />;
}

export function PluginUiSlotControls({ entries, sessionId = null, clientId, appearance }: {
  entries: readonly PluginUiEntry[]; sessionId?: string | null; clientId?: string; appearance?: 'navigation' | 'rail' | 'titlebar' | 'composer-header';
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = root.current;
    // Observe the original message row, whose size is independent of a plugin hiding its control.
    if (element) return observeSlotVisibility(element.closest('[data-message-client-id]') ?? element.parentElement ?? element, setActive);
  }, []);
  return <span ref={root} data-plugin-composer-header={appearance === 'composer-header' ? '' : undefined} className={appearance === 'navigation'
    ? 'flex min-w-0 flex-col gap-0.5 [-webkit-app-region:no-drag]'
    : appearance === 'composer-header' ? '-mb-2 flex h-8 w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&:empty]:hidden'
    : appearance === 'titlebar' ? 'inline-flex min-w-0 max-w-[min(16rem,30vw)] flex-nowrap items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]'
      : 'inline-flex min-w-0 flex-wrap items-center gap-1 [-webkit-app-region:no-drag]'}>
    {entries.map(entry => <EntryControl key={`${entry.instanceId}:${entry.contribution.id}`} entry={entry}
      sessionId={sessionId} clientId={clientId} active={active} appearance={appearance} />)}
  </span>;
}

/** Only a user's choice in the owning task can replace its chat surface. No persisted route or plugin command. */
export function usePluginUiTaskMain(sessionId: string | null, workdir: string | null | undefined) {
  const directory = useContext(DirectoryContext);
  const entries = sessionId && workdir?.trim() ? directory.get('session.main') ?? NO_ENTRIES : NO_ENTRIES;
  const ghosts = useMemo(() => entries.map(entry => entry.ghost), [entries]);
  const disabled = useWorkdirDisabledGhostIds(workdir, ghosts);
  const choices = useMemo(() => !disabled ? [] : entries.filter(entry => !disabled.has(entry.instanceId)).map(entry => ({
    entry, key: JSON.stringify([sessionId, workdir, entry.instanceId, entry.contribution.id,
      entry.ghost.approval.state === 'approved' && entry.ghost.approval.revision]),
  })), [disabled, entries, sessionId, workdir]);
  const [selection, select] = useState<string | null>(null);
  const chosen = choices.find(choice => choice.key === selection);
  useEffect(() => { if (selection && !chosen) select(null); }, [selection, chosen]);
  const close = useCallback(() => select(null), []);
  const trigger = useMemo(() => choices.length ? <span className="inline-flex shrink-0 [-webkit-app-region:no-drag]">
    {choices.map(({ entry, key }) => {
      const title = `${entry.contribution.title} · ${entry.ghost.manifest.name}`;
      const Icon = MAIN_VIEW_ICONS[entry.contribution.icon as keyof typeof MAIN_VIEW_ICONS] ?? Puzzle;
      return <ChromeIconButton key={key} aria-label={title} aria-pressed={chosen?.key === key} tooltipSide="bottom"
        className="aria-pressed:bg-sidebar-item-hover aria-pressed:text-foreground" onClick={() => select(current => current === key ? null : key)}>
        <Icon size={14} />
      </ChromeIconButton>;
    })}
  </span> : null, [choices, chosen]);
  const entry = chosen?.entry;
  return { trigger, page: chosen && entry?.contribution.view && sessionId ?
    <section key={chosen.key} className="flex h-full min-h-0 flex-col bg-content-area" aria-label={entry.contribution.title}>
      <Suspense fallback={<Spinner size={16} />}><PluginUiView chrome="panel" sizing="fill" ghost={entry.ghost}
        viewId={entry.contribution.view} taskMainContribution={entry.contribution.id} sessionId={sessionId} input={entry.contribution.arguments} onUnavailable={close} /></Suspense>
    </section> : null };
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
