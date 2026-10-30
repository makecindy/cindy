import type { AgentKind } from '@cindy/maker-core';
import { resolveAutomaticImSettings } from '../../shared/imAutomaticModel';
import type { ImDefaultSettings } from '../../shared/imDefaultSettings';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog';

export { readRemoteProviderRoute as readImRemoteProviderRoute } from '../remote-agent/controller/deviceCatalog';

/** Automatic routes are resolved only from the execution host's authorized, visible catalog. */
export async function readImRemoteAutomaticDefaults<T extends ImDefaultSettings>(
  settings: T,
  options: {
    agentDeviceId: string;
    agentKind?: AgentKind;
    providerId?: string | null;
  },
): Promise<T | null> {
  if (options.agentKind === 'zcode') return null;
  const { remoteBackgroundInvoke } = await import('../device-link');
  const providers = await readDeviceProviderViews(remoteBackgroundInvoke, options.agentDeviceId, {
    visibleOnly: true,
  });
  const resolved = resolveAutomaticImSettings(settings, providers, { ...options, agentKind: options.agentKind });
  if (!resolved) return null;
  return {
    ...resolved,
    agents: {
      ...resolved.agents,
      [resolved.agentKind]: {
        ...resolved.agents[resolved.agentKind],
        agentDeviceId: options.agentDeviceId,
      },
    },
  };
}

/** 权限档也取执行端能力，发起电脑可能没有安装该引擎。 */
export async function readImRemotePermissionModes(
  agentDeviceId: string,
  agentKind: AgentKind,
): Promise<string[]> {
  if (agentKind === 'zcode') throw new Error('ZCode does not support remote IM defaults');
  const { remoteBackgroundInvoke } = await import('../device-link');
  const response = await remoteBackgroundInvoke(agentDeviceId, 'maker:get-capabilities', [
    agentKind,
  ]);
  if (!response.ok)
    throw new Error(response.error?.message ?? 'Remote agent capabilities unavailable');
  const modes = (response.result as { permissionModes?: unknown } | null)?.permissionModes;
  if (
    !Array.isArray(modes) ||
    !modes.length ||
    !modes.every(
      (mode) =>
        mode && typeof mode === 'object' && typeof mode.id === 'string' && mode.id.length > 0,
    )
  ) {
    throw new Error('Invalid remote agent permission modes');
  }
  return modes.map((mode) => mode.id);
}
