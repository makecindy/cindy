import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getPluginModelPickerAgents, getPluginModelPickerPluginEngines } from './ghostModelPicker.js';
import { createRuntimePluginHost, type RuntimePluginHostPorts } from './runtimePluginHostCore.js';

type RouteSources = ReturnType<RuntimePluginHostPorts['modelRouteSources']>;

/** The remote route readers can be installed or removed after startup. */
export function createDesktopRuntimePluginHost(ports: Omit<RuntimePluginHostPorts, 'modelRouteSources'> & {
  remoteSources(): Pick<RouteSources, 'locations' | 'remoteViews' | 'remotePluginEngines'>;
}) {
  return createRuntimePluginHost({
    ...ports,
    modelRouteSources: () => ({
      localViews: () => getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, snapshotOnly: true }),
      localAgents: getPluginModelPickerAgents,
      localPluginEngines: getPluginModelPickerPluginEngines,
      ...ports.remoteSources(),
    }),
  });
}
