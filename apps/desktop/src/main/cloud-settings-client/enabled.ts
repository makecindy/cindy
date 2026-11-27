import { isCloudInstanceServiceConfigured } from '../clientEndpointsService';
import { getInstanceConfig } from '../instance-runtime/config.js';
import { createCloudWindowArgument } from '../../shared/cloudWindow';

/**
 * Whether cloud instances exist for this app at all: it runs as one, or a region has a cloud
 * instance service. Otherwise no cloud IPC, bridge, window, listener or request is created.
 */
export function cloudInstancesEnabled(): boolean {
  return getInstanceConfig() !== null || isCloudInstanceServiceConfigured();
}

/** Launch arguments that give the main window its cloud bridges; empty without cloud instances. */
export function cloudWindowArguments(): string[] {
  return cloudInstancesEnabled()
    ? [createCloudWindowArgument({ instance: getInstanceConfig() !== null })]
    : [];
}
