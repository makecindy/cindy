/**
 * Local-only IPC for plugin-provided task engines (docs/plans/acp-plugin-bridge.md).
 *
 * The renderer lists engines for the model picker and is told when the list,
 * their availability or their last-seen models change. Since phase 2 (2026-11-19) the
 * list and refresh invokes are also on the device-link allowlist so a phone can pick this
 * computer's engines; the change push stays local (controllers read the list on demand).
 */

import type { IpcMainInvokeEvent } from 'electron';
import { ACP_PERMISSION_MODES } from '@cindy/maker-core';
import {
  getPluginHarnessRegistry,
  requestPluginHarnessRefresh,
  type PluginHarness,
} from '../cindy-brain/pluginHarnesses.js';
import { getCachedPluginHarnessModels, onPluginHarnessModelsChanged } from '../maker-host/acp-host.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  PLUGIN_ENGINES_INVOKE,
  PLUGIN_ENGINES_PUSH,
  pluginEngineProviderId,
  type PluginEnginePermissionMode,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';

/**
 * The list the plugin publishes for its engine wins (like a provider's own model list); without
 * one, the models the engine reported the last time a task ran on it.
 */
function engineModels(harness: PluginHarness): PluginEngineView['models'] {
  if (harness.models?.length) {
    return harness.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.group ? { group: model.group } : {}),
      ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
      ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    }));
  }
  return getCachedPluginHarnessModels(harness.key).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(model.group ? { group: model.group } : {}),
    ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
  }));
}

/** The models a new task on this engine can pick from (published list, else the last-seen one). */
export function pluginEngineModelsOf(harness: PluginHarness): PluginEngineView['models'] {
  return engineModels(harness);
}

/** Names of the agent modes Cindy can show (the renderer localizes them by id). */
const AGENT_MODE_NAMES: Record<NonNullable<PluginHarness['modes']>[number], string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan',
};

function toModeView(mode: (typeof ACP_PERMISSION_MODES)[number]): PluginEnginePermissionMode {
  return {
    id: mode.id as PluginEnginePermissionMode['id'],
    displayName: mode.displayName,
    ...(mode.description ? { description: mode.description } : {}),
  };
}

/**
 * The permission menu of an engine: the agent's own modes the plugin lists, then Cindy's Full
 * access (maker-core acpPermissionModes offers the same once the engine runs); else Cindy's two.
 */
function enginePermissionModes(harness: PluginHarness): Pick<PluginEngineView, 'permissionModes' | 'defaultPermissionMode'> {
  const generic = ACP_PERMISSION_MODES.map(toModeView);
  if (!harness.modes?.length) return { permissionModes: generic, defaultPermissionMode: 'ask' };
  return {
    permissionModes: [
      ...harness.modes.map((id) => ({ id, displayName: AGENT_MODE_NAMES[id] })),
      ...generic.filter((mode) => mode.id === 'bypassPermissions'),
    ],
    defaultPermissionMode: harness.defaultMode ?? harness.modes[0]!,
  };
}

function toView(harness: PluginHarness): PluginEngineView {
  return {
    key: harness.key,
    providerId: pluginEngineProviderId(harness.key),
    ghostId: harness.ghostId,
    harnessId: harness.harnessId,
    name: harness.name,
    ...(harness.description ? { description: harness.description } : {}),
    ...(harness.iconDataUrl ? { iconDataUrl: harness.iconDataUrl } : {}),
    availability: harness.availability,
    models: engineModels(harness),
    ...enginePermissionModes(harness),
  };
}

export function listPluginEngineViews(): PluginEngineView[] {
  return getPluginHarnessRegistry().list().map(toView);
}

/**
 * Largest plugin icon (data URL characters) sent to a phone or another computer. The DSH and
 * Antigravity icons are ~45 KB as data URLs; anything bigger travels without its icon (the
 * controller shows the generic engine mark) so a picker read stays small on the relay.
 */
export const REMOTE_PLUGIN_ENGINE_ICON_MAX_CHARS = 64 * 1024;

/** The engine list as a controller reads it over device-link: same fields, oversized icons left out. */
export function remotePluginEngineViews(views: readonly PluginEngineView[]): PluginEngineView[] {
  return views.map((view) => {
    if (!view.iconDataUrl || view.iconDataUrl.length <= REMOTE_PLUGIN_ENGINE_ICON_MAX_CHARS) return view;
    const { iconDataUrl: _dropped, ...rest } = view;
    return rest;
  });
}

/**
 * The engines as Agent tools list them (list_available_models / schedule_list_models `pluginEngines`):
 * each engine with its `default` entry first, then the models it reported, and whether it can run now.
 */
export function pluginEngineDescriptors(views: readonly PluginEngineView[] = listPluginEngineViews()): Array<{
  providerId: string;
  name: string;
  available: boolean;
  message?: string;
  models: Array<{ id: string; label: string; efforts?: string[] }>;
}> {
  return views.map((view) => ({
    providerId: view.providerId,
    name: view.name,
    available: view.availability.state !== 'unavailable',
    ...(view.availability.state === 'unavailable' && view.availability.message
      ? { message: view.availability.message } : {}),
    models: [
      { id: PLUGIN_ENGINE_DEFAULT_MODEL, label: 'Default (the engine chooses)' },
      ...view.models.map((model) => ({
        id: model.id,
        label: model.displayName,
        ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
      })),
    ],
  }));
}

export interface RegisterPluginEnginesIpcOpts {
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void;
  assertTrusted(event: IpcMainInvokeEvent): void;
  broadcast(channel: string, payload: unknown): void;
  /**
   * True while serving a device-link invoke (a phone or another computer controlling this one). The
   * two channels are on the device-link allowlist: they read the engines of this computer and ask
   * its plugins to republish models; neither depends on the sender or shows any local UI.
   */
  isDeviceLinkInvoke?(): boolean;
}

/** Returns a disposer for the change subscriptions. */
export function registerPluginEnginesIpc(opts: RegisterPluginEnginesIpcOpts): () => void {
  const remote = () => opts.isDeviceLinkInvoke?.() === true;
  opts.handle(PLUGIN_ENGINES_INVOKE.LIST, (event) => {
    if (remote()) return remotePluginEngineViews(listPluginEngineViews());
    opts.assertTrusted(event);
    return listPluginEngineViews();
  });
  // Picker opened: ask engine plugins to republish their models (cooldown per plugin in the registry).
  opts.handle(PLUGIN_ENGINES_INVOKE.REFRESH, (event) => {
    if (!remote()) opts.assertTrusted(event);
    requestPluginHarnessRefresh();
  });
  let lastPayload = '';
  const publish = (): void => {
    const engines = listPluginEngineViews();
    const payload = JSON.stringify(engines);
    if (payload === lastPayload) return;
    lastPayload = payload;
    opts.broadcast(PLUGIN_ENGINES_PUSH.CHANGED, engines);
  };
  const offRegistry = getPluginHarnessRegistry().onChange(publish);
  const offModels = onPluginHarnessModelsChanged(publish);
  return () => {
    offRegistry();
    offModels();
  };
}
