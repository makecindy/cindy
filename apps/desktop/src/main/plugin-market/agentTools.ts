import type { PluginMarketService } from './service.js';
import type { PluginMarketItem } from '../../shared/pluginMarket.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface InstalledState {
  exists: boolean;
  /** null means the installed plugin is callable in this task. */
  errorCode: string | null;
}

export interface PluginMarketAgentDeps {
  market: Pick<PluginMarketService, 'snapshot' | 'detail' | 'install'>;
  installedState(ghostId: string): InstalledState;
  /** Owner generation and caller identity are captured before discovery's first await. */
  captureRead(): () => void;
  /** Holds the existing owner lease and live task authority through package placement. */
  captureInstall(signal?: AbortSignal): { assertCurrent(): void; release(): void };
}

function catalogItem(item: PluginMarketItem, installed: InstalledState) {
  return {
    plugin_id: item.pluginId, ghost_id: item.ghostId, release_id: item.releaseId,
    name: item.name, description: item.description, author: item.author,
    version: item.version, scope: item.scope,
    source: item.sourceType, marketplace: item.sourceMarketName,
    install_state: item.installState,
    installed: installed.exists,
    availability: installed.exists ? installed.errorCode ?? 'available' : 'not-installed',
  };
}

/** Narrow Agent adapter: live catalog discovery and first install, with no credential projection. */
export function createPluginMarketAgentTools(deps: PluginMarketAgentDeps) {
  return {
    async search(query: string): Promise<Record<string, unknown>> {
      const assertCurrent = deps.captureRead();
      const snapshot = await deps.market.snapshot({ discoveryOnly: true });
      assertCurrent();
      const needle = query.trim().toLocaleLowerCase();
      const matches = snapshot.items.filter(item =>
        `${item.name} ${item.description ?? ''} ${item.ghostId} ${item.author ?? ''}`
          .toLocaleLowerCase().includes(needle));
      return {
        ok: true,
        items: matches.slice(0, 20).map(item => catalogItem(item, deps.installedState(item.ghostId))),
        has_more: matches.length > 20,
        complete: !snapshot.unavailableReason && snapshot.unavailableCustomSourceNames.length === 0,
        // Source errors can contain local paths or server responses; expose status only.
        unavailable_sources: [
          ...(snapshot.unavailableReason ? ['server'] : []),
          ...snapshot.unavailableCustomSourceNames.map(() => 'custom'),
        ],
      };
    },
    async install(request: { pluginId: string; releaseId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
      let release: (() => void) | undefined;
      try {
        const authority = deps.captureInstall(signal);
        release = authority.release;
        authority.assertCurrent();
        const detail = await deps.market.detail(request.pluginId);
        authority.assertCurrent();
        if (detail.releaseId !== request.releaseId) {
          throwIpcError('PRECONDITION_FAILED', 'Plugin release changed after selection');
        }
        const installed = deps.installedState(detail.ghostId);
        if (installed.exists) return {
          ok: true, status: 'already-installed',
          plugin: catalogItem(detail, installed),
          ghost_id: detail.ghostId,
        };
        // Recheck at the service's final commit boundary, including concurrent local imports.
        const assertCurrent = () => {
          authority.assertCurrent();
          if (deps.installedState(detail.ghostId).exists) {
            throwIpcError('PRECONDITION_FAILED', 'Plugin appeared during installation; inspect it before continuing');
          }
        };
        const result = await deps.market.install(request.pluginId, {
          expectedReleaseId: request.releaseId,
          expectedManifest: detail.manifest,
          allowSourceReplacement: false,
        }, assertCurrent);
        authority.assertCurrent();
        return {
          ok: true, status: 'installed', ghost_id: result.ghost.manifest.id,
          name: result.ghost.manifest.name, version: result.ghost.manifest.version,
          enabled: result.ghost.enabled,
          next: 'Inspect ghost_info for the real tools and setup. Installation is not account connection or task completion.',
        };
      } catch (error) {
        return {
          ok: false, errorCode: isIpcError(error) ? error.code : 'INSTALL_UNAVAILABLE',
          message: 'Installation was not confirmed. Inspect the selected plugin before retrying; do not claim an account connection or completed work.',
        };
      } finally { release?.(); }
    },
  };
}
