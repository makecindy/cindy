/**
 * Local-only IPC for plugin-provided task engines (docs/plans/acp-plugin-bridge.md).
 *
 * The renderer lists engines for the model picker and is told when the list,
 * their availability or their last-seen models change. These channels are not
 * in the device-link allowlist: phones and other computers never see them.
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
    permissionModes: ACP_PERMISSION_MODES.map((mode) => ({
      id: mode.id as PluginEnginePermissionMode['id'],
      displayName: mode.displayName,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  };
}

export function listPluginEngineViews(): PluginEngineView[] {
  return getPluginHarnessRegistry().list().map(toView);
}

export interface RegisterPluginEnginesIpcOpts {
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void;
  assertTrusted(event: IpcMainInvokeEvent): void;
  broadcast(channel: string, payload: unknown): void;
}

/** Returns a disposer for the change subscriptions. */
export function registerPluginEnginesIpc(opts: RegisterPluginEnginesIpcOpts): () => void {
  opts.handle(PLUGIN_ENGINES_INVOKE.LIST, (event) => {
    opts.assertTrusted(event);
    return listPluginEngineViews();
  });
  // Picker opened: ask engine plugins to republish their models (cooldown per plugin in the registry).
  opts.handle(PLUGIN_ENGINES_INVOKE.REFRESH, (event) => {
    opts.assertTrusted(event);
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
