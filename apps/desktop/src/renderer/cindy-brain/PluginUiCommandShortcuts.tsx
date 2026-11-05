import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginUiView } from '@cindy/maker-shared';
import {
  getEffectivePluginShortcuts,
  matchesKeyboardEvent,
  type AppShortcutCombo,
  type AppShortcutOverrides,
  type PluginShortcutDefinition,
} from '../../shared/appShortcuts';
import { useAppShortcutEvents } from '@/hooks/useAppShortcut';
import { getAppShortcutOverrides, getAppShortcutPlatform } from '@/lib/appShortcutStore';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { voiceInputShortcutToAppShortcutCombo } from '@/voice-input/appShortcutConflict';
import { usePluginShortcutDefinitions } from './usePluginShortcutDefinitions';
import { usePluginUiContributions } from './usePluginUiContributions';

type Entry = 'session' | 'message' | 'turn';
type SelectionInput = {
  event: KeyboardEvent;
  root: Element;
  focusMessageId?: string;
  entry: Entry;
  definitions: readonly PluginShortcutDefinition[];
  views: readonly PluginUiView[];
  overrides: AppShortcutOverrides;
  platform: string;
  voiceCombo?: AppShortcutCombo | null;
  pending: ReadonlySet<string>;
  disabled: boolean;
};

function acceptsEntry(definition: PluginShortcutDefinition, entry: Entry): boolean {
  if (entry === 'session') return definition.scope === 'session';
  if (definition.scope !== 'message') return false;
  const points = definition.points;
  if (entry === 'message') return !points?.length || points.includes('message.actions');
  // A command declared at both positions uses the focused message once.
  return !!points?.includes('turn.footer') && !points.includes('message.actions');
}

function elementFor(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function focusedElement(event: KeyboardEvent): Element | null {
  if (!(event.target instanceof Element)) return null;
  if (event.target !== document.body && event.target !== document.documentElement) return event.target;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const start = elementFor(selection.anchorNode);
  const end = elementFor(selection.focusNode);
  const message = start?.closest('[data-message-client-id]');
  return message && message === end?.closest('[data-message-client-id]') ? start : null;
}

/** Select only a live command belonging to this actual session and message. */
export function selectPluginShortcutView(input: SelectionInput): PluginUiView | undefined {
  const { event, root } = input;
  if (!event.isTrusted || input.disabled) return undefined;
  const focused = focusedElement(event);
  if (!focused || focused.closest('[data-plugin-ui-session]') !== root) return undefined;
  if (input.focusMessageId && focused.closest('[data-message-client-id]')?.getAttribute('data-message-client-id') !== input.focusMessageId)
    return undefined;
  const editable = focused.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  if (editable && !editable.closest('[data-chat-input-root]')) return undefined;
  // Preserve native editing commands in the composer and copy for selected message text.
  const editingKey = /^(KeyA|KeyC|KeyV|KeyX|KeyZ|KeyY|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Backspace|Delete)$/.test(event.code);
  if ((event.ctrlKey || event.metaKey) && !event.altKey &&
      ((editable && editingKey) || (event.code === 'KeyC' && !window.getSelection()?.isCollapsed))) return undefined;
  const effective = getEffectivePluginShortcuts(input.definitions, input.overrides, input.platform,
    input.voiceCombo ? [input.voiceCombo] : []);
  for (const view of input.views) {
    const definition = input.definitions.find(item => item.id === view.command?.shortcutId);
    if (!definition || !acceptsEntry(definition, input.entry) || input.pending.has(view.viewId) ||
        !view.actions.some(action => action.id === 'run' && !action.disabled) ||
        !view.controls.some(control => control.kind === 'button' && control.actionId === 'run' && !control.disabled)) continue;
    if (effective.get(definition.id)?.some(combo => matchesKeyboardEvent(event, combo))) return view;
  }
  return undefined;
}

type Props = {
  sessionId: string;
  deviceId?: string;
  active?: boolean;
  connected?: boolean;
  readOnly?: boolean;
} & ({ entry: 'session' } | { entry: 'message' | 'turn'; targetId: string; focusMessageId: string });

export function PluginUiCommandShortcuts(props: Props) {
  const definitions = usePluginShortcutDefinitions();
  if (props.deviceId || !definitions.some(definition => acceptsEntry(definition, props.entry))) return null;
  return <BoundCommandShortcuts {...props} definitions={definitions} />;
}

function BoundCommandShortcuts(props: Props & { definitions: PluginShortcutDefinition[] }) {
  const { t } = useTranslation();
  const marker = useRef<HTMLSpanElement>(null);
  const selected = useRef<PluginUiView | undefined>(undefined);
  const state = usePluginUiContributions({
    sessionId: props.sessionId,
    deviceId: props.deviceId,
    point: props.entry === 'session' ? 'session.shortcuts' : 'message.shortcuts',
    ...(props.entry === 'session' ? {} : { target: { kind: 'message', id: props.targetId } }),
    active: props.active, connected: props.connected, readOnly: props.readOnly,
  });
  useAppShortcutEvents(event => {
    selected.current = undefined;
    const root = marker.current?.closest('[data-plugin-ui-session]');
    if (!root) return false;
    const voice = getVoiceInputSettings().shortcut;
    selected.current = selectPluginShortcutView({
      event, root, entry: props.entry,
      ...(props.entry === 'session' ? {} : { focusMessageId: props.focusMessageId }),
      definitions: props.definitions, views: state.views, overrides: getAppShortcutOverrides(),
      platform: getAppShortcutPlatform(), voiceCombo: voice ? voiceInputShortcutToAppShortcutCombo(voice) : null,
      pending: state.pending, disabled: state.disabled,
    });
    return !!selected.current;
  }, () => {
    if (!selected.current) return false;
    void state.invoke(selected.current, 'run', {});
    return true;
  });
  return <>
    <span ref={marker} hidden />
    {state.error && state.views.length ? <span role="status" className="text-12 text-[var(--text-secondary)]">{t(`pluginUi.${state.error}`)}</span> : null}
  </>;
}
