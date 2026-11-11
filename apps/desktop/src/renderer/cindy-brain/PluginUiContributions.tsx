import { createContext, useContext, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isHostUiPosition, type GhostHostUiContribution, type GhostHostUiPosition } from '@cindy/plugin-protocol';
import { getApprovedGhostHostUi, type InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { useInstalledGhosts } from './useInstalledGhosts';
import { usePluginUiControl } from './pluginUiControls';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { Puzzle } from 'lucide-react';
import { isPluginUiElementVisible, subscribePluginUiRegions } from './pluginUiVisibility';
const PluginUiView = lazy(() => import('./PluginUiView').then(module => ({ default: module.PluginUiView })));
const openPluginUiView = async (instanceId: string, viewId: string, sessionId: string | null, input?: Record<string, unknown>) =>
  (await import('@/features/right-sidebar/lib/openPluginUiView')).openPluginUiView(instanceId, viewId, sessionId, input);
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type PluginUiEntry = { ghost: InstalledGhost; instanceId: string; contribution: GhostHostUiContribution };
type Directory = ReadonlyMap<GhostHostUiPosition, readonly PluginUiEntry[]>;
const EMPTY: Directory = new Map();
const NO_ENTRIES: readonly PluginUiEntry[] = [];
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

/** One window subscription, compiled only when the original installed projection changes. */
export function PluginUiProvider({ children, host: hostNode, enabled = true }: { children: ReactNode; host?: ReactNode; enabled?: boolean }) {
  const ghosts = useInstalledGhosts(enabled);
  const directory = useMemo(() => {
    const entries = new Map<GhostHostUiPosition, PluginUiEntry[]>();
    const launchers: PluginUiLauncher[] = [];
    let active = false;
    for (const ghost of ghosts) {
      if (!ghost.enabled || ghost.uiCapabilityApproved !== true) continue;
      const host = getApprovedGhostHostUi(ghost);
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
    return { entries: entries.size ? entries : EMPTY, launchers, active };
  }, [ghosts]);
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

export async function runPluginUiEntry(entry: PluginUiEntry, sessionId: string | null, value?: string): Promise<void> {
  const action = entry.contribution;
  if (action.view) return openPluginUiView(entry.instanceId, action.view, sessionId,
    { ...action.arguments, ...(value === undefined ? {} : { value }) });
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

function EntryControl({ entry, sessionId, clientId, active }: { entry: PluginUiEntry; sessionId: string | null; clientId?: string; active: boolean }) {
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
  if (action.kind === 'status') return <span className="text-12 text-[var(--text-secondary)]" title={entry.ghost.manifest.name}>{title}</span>;
  if (action.kind === 'select') return <Select label={title} value={state?.value ?? value} options={action.options ?? []}
    disabled={pending || state?.disabled} onValueChange={next => void run(next)} className="h-7 max-w-48 text-12" />;
  if (action.presentation === 'popover' && action.view) return <Popover open={open && active} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="secondary" tone="quiet" size="sm" disabled={state?.disabled}
      title={entry.ghost.manifest.name}>{title}</Button></PopoverTrigger>
    <PopoverContent align="start" side={action.position === 'composer.toolbar' || action.position === 'statusbar' ? 'top' : 'bottom'}
      aria-label={title} className="w-[min(26rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2">
      {open && active && <Suspense fallback={<Spinner size={16} />}><PluginUiView ghost={entry.ghost} viewId={action.view}
        sessionId={sessionId} input={action.arguments} onUnavailable={() => setOpen(false)} /></Suspense>}
    </PopoverContent>
  </Popover>;
  return <Button variant="secondary" tone="quiet" size="sm" disabled={pending || state?.disabled} title={entry.ghost.manifest.name}
    onClick={() => void run()}>{title}</Button>;
}

/** No candidate means no View, effect, IPC, SQL or plugin callback. */
export function PluginUiSlot({ position, ...target }: Target & { position: GhostHostUiPosition }) {
  const entries = useEntries(position, target);
  if (!entries.length) return null;
  return <PluginUiSlotControls entries={entries} sessionId={target.sessionId ?? null} clientId={target.clientId} />;
}

function PluginUiSlotControls({ entries, sessionId, clientId }: {
  entries: readonly PluginUiEntry[]; sessionId: string | null; clientId?: string;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = root.current;
    // Observe the original message row, whose size is independent of a plugin hiding its control.
    if (element) return observeSlotVisibility(element.closest('[data-message-client-id]') ?? element.parentElement ?? element, setActive);
  }, []);
  return <span ref={root} className="inline-flex min-w-0 flex-wrap items-center gap-1 [-webkit-app-region:no-drag]">
    {entries.map(entry => <EntryControl key={`${entry.instanceId}:${entry.contribution.id}`} entry={entry}
      sessionId={sessionId} clientId={clientId} active={active} />)}
  </span>;
}

/** One explicit selection owns the body; the original stays the default and fallback. */
export function PluginUiBody({ children, position, ...target }: Target & { children: ReactNode; position: 'message.body' | 'tool.body' }) {
  const entries = useEntries(position, target);
  if (!entries.length || !target.sessionId) return <>{children}</>;
  return <PluginUiBodyChoice entries={entries} sessionId={target.sessionId} context={target.context}>{children}</PluginUiBodyChoice>;
}

/** Return the original element itself when the list has no candidate for this body. */
export function renderPluginUiBody(options: (Target & { position: 'message.body' | 'tool.body' }) | undefined, children: ReactNode): ReactNode {
  return options ? <PluginUiBody {...options}>{children}</PluginUiBody> : children;
}

function PluginUiBodyChoice({ children, entries, sessionId, context }: {
  children: ReactNode; entries: readonly PluginUiEntry[]; sessionId: string; context?: Target['context'];
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('original');
  const entry = entries.find(entry => `${entry.instanceId}:${entry.contribution.id}` === selected);
  return <>
    <div className="mb-1 flex min-w-0 items-center gap-1">
      <Select label={t('pluginUi.display')} value={entry ? selected : 'original'} className="h-7 max-w-56 text-12"
        options={[{ value: 'original', label: t('pluginUi.original') }, ...entries.map(entry => ({
          value: `${entry.instanceId}:${entry.contribution.id}`, label: `${entry.contribution.title} · ${entry.ghost.manifest.name}`,
        }))]} onValueChange={setSelected} />
    </div>
    {entry?.contribution.view ? <Suspense fallback={children}><PluginUiView ghost={entry.ghost} viewId={entry.contribution.view}
      sessionId={sessionId} input={entry.contribution.arguments} context={context} onUnavailable={() => setSelected('original')} /></Suspense> : children}
  </>;
}
