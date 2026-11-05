import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { useInstalledGhosts } from './useInstalledGhosts';
import { usePluginShortcutDefinitions } from './usePluginShortcutDefinitions';

/** The installed manifest icon is already read and validated by the host. */
export function PluginUiCommandIcon({ shortcutId }: { shortcutId: string }) {
  const definitions = usePluginShortcutDefinitions();
  const ghosts = useInstalledGhosts();
  const instanceId = definitions.find(definition => definition.id === shortcutId)?.instanceId;
  const icon = instanceId && ghosts.find(ghost => installedGhostStoragePart(ghost) === instanceId)?.iconDataUrl;
  return icon ? <img src={icon} alt="" aria-hidden="true" className="size-4 shrink-0 rounded object-contain" /> : null;
}
