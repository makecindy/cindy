import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../../shared/ghost';
import {
  installedGhostStoragePart,
  resolvePluginInstanceQuery,
} from '../../../../shared/pluginIdentity';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import {
  marketItemForInstalledGhost,
  marketReviewTargetsInstalledGhost,
} from './pluginMarketPresentation';

/** The plugin a prompt asks for. */
export interface PluginInPlaceTarget {
  ghostId: string;
  /** Required source; null is the root source. Omitted: any single source. */
  namespace?: string | null;
  /** Market listing the prompt already knows about. */
  marketPluginId?: string;
  /** Also bring an installed copy to its newer market release. */
  update?: boolean;
  /** Also turn the plugin back on in this project when it was turned off here. */
  workingDir?: string | null;
}

export type PluginInPlaceResult =
  | { status: 'ready'; ghost: InstalledGhost; changed: 'installed' | 'enabled' | 'updated' | null }
  | { status: 'cancelled' }
  /** Not something to settle here (several sources, recovery, setup): the plugin's own page. */
  | { status: 'page'; route: string }
  /** No single trusted source exists. */
  | { status: 'unavailable' }
  | { status: 'failed'; messageKey: string };

const installedRoute = (ghost: InstalledGhost) =>
  `/plugins?ghost=${encodeURIComponent(installedGhostStoragePart(ghost))}`;
const marketRoute = (pluginId: string) => `/plugins?market=${encodeURIComponent(pluginId)}`;

function failure(error: unknown, market: boolean): PluginInPlaceResult {
  // Cancelling the install confirmation is the user's answer, not a failure.
  if (extractIpcError(error)?.code === 'MUTATION_CANCELLED') return { status: 'cancelled' };
  return {
    status: 'failed',
    messageKey: market ? pluginMarketErrorKey(error) : ghostInstallErrorKey(extractIpcError(error)?.code),
  };
}

async function turnOnInProject(ghost: InstalledGhost, workingDir: string | null | undefined): Promise<boolean> {
  if (!workingDir) return false;
  const id = installedGhostStoragePart(ghost);
  if (!window.electronAPI.ghosts.workdirPrefsSync(workingDir).disabled.includes(id)) return false;
  await window.electronAPI.ghosts.setWorkdirDisabled(workingDir, id, false);
  return true;
}

function readInstalled(target: PluginInPlaceTarget) {
  return resolvePluginInstanceQuery(
    window.electronAPI.ghosts.listSync().ghosts,
    target.ghostId,
    target.namespace,
  );
}

/**
 * Make a plugin usable where the user asked for it, with the plugins page's own
 * checks: the market release and manifest the user is shown are the ones Main
 * installs, Main asks for permission in this window, a source is never switched,
 * and with several candidate sources nothing is chosen for the user.
 */
export async function makePluginUsableInPlace(target: PluginInPlaceTarget): Promise<PluginInPlaceResult> {
  const resolved = readInstalled(target);
  if (resolved.status === 'ambiguous') return { status: 'page', route: '/plugins' };
  if (resolved.status === 'unique') {
    let ghost = resolved.ghost;
    // Recovering an unverified install has its own explanation on the plugin page.
    if (ghost.approval.state !== 'approved' || ghost.retirement) return { status: 'page', route: installedRoute(ghost) };
    let changed: 'enabled' | 'updated' | null = null;
    if (target.update) {
      try {
        const market = await window.electronAPI.pluginMarket.lookup([target.ghostId]);
        const item = marketItemForInstalledGhost(market.items, ghost);
        const detail = item?.installState === 'update-available'
          ? await window.electronAPI.pluginMarket.detail(item.pluginId)
          : null;
        if (!detail || !marketReviewTargetsInstalledGhost(detail, ghost.approval.state))
          return { status: 'page', route: installedRoute(ghost) };
        ghost = (await window.electronAPI.pluginMarket.install(detail.pluginId, {
          expectedReleaseId: detail.releaseId,
          expectedManifest: detail.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
          allowSourceReplacement: false,
        })).ghost;
        changed = 'updated';
      } catch (error) {
        return failure(error, true);
      }
    }
    try {
      if (!ghost.enabled) {
        await window.electronAPI.ghosts.setEnabled(
          installedGhostStoragePart(ghost),
          true,
          ghostInstallApprovalToken(ghost.approval),
        );
        changed ??= 'enabled';
      }
      if (await turnOnInProject(ghost, target.workingDir)) changed ??= 'enabled';
    } catch (error) {
      return failure(error, false);
    }
    const fresh = readInstalled(target);
    return { status: 'ready', ghost: fresh.status === 'unique' ? fresh.ghost : ghost, changed };
  }

  try {
    const market = await window.electronAPI.pluginMarket.lookup([target.ghostId]);
    const matches = market.items.filter(
      (item) =>
        item.ghostId === target.ghostId &&
        item.installState !== 'conflict' &&
        (!target.marketPluginId || item.pluginId === target.marketPluginId) &&
        // A missing namespace is unknown, never an implicit root match.
        (target.namespace === undefined || item.namespace === target.namespace),
    );
    if (matches.length !== 1) {
      return target.marketPluginId ? { status: 'page', route: marketRoute(target.marketPluginId) } : { status: 'unavailable' };
    }
    const detail = await window.electronAPI.pluginMarket.detail(matches[0].pluginId);
    if (detail.installState !== 'not-installed') return { status: 'page', route: marketRoute(detail.pluginId) };
    const { ghost } = await window.electronAPI.pluginMarket.install(detail.pluginId, {
      expectedReleaseId: detail.releaseId,
      expectedManifest: detail.manifest,
      allowSourceReplacement: false,
    });
    await turnOnInProject(ghost, target.workingDir);
    return { status: 'ready', ghost, changed: 'installed' };
  } catch (error) {
    return failure(error, true);
  }
}

const inFlight = new Set<string>();

/**
 * The shared way a prompt offers a plugin: one click makes it usable here, with
 * the usual confirmation from Main; only what cannot be settled here opens the
 * plugin's page. `onReady` continues what the user was doing.
 */
export function usePluginInPlace() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (
      target: PluginInPlaceTarget,
      options: {
        onReady?: (ghost: InstalledGhost) => void | Promise<void>;
        /** Replaces opening the plugin page, e.g. to keep a "come back here" request. */
        onPage?: (route: string) => void;
        /**
         * Whether what the user asked from is still on screen. When not, the result is
         * still reported, but nothing continues or navigates for it.
         */
        isCurrent?: () => boolean;
      } = {},
    ): Promise<PluginInPlaceResult | null> => {
      const key = JSON.stringify([target.namespace, target.ghostId]);
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      setBusy(key);
      try {
        const result = await makePluginUsableInPlace(target);
        if (!mounted.current) return result;
        const current = options.isCurrent?.() !== false;
        switch (result.status) {
          case 'ready':
            if (result.changed === 'installed')
              toast.success(t('settings.ghosts.toast.installed', { name: result.ghost.manifest.name }));
            else if (result.changed === 'updated')
              toast.success(t('settings.ghosts.toast.updated', {
                name: result.ghost.manifest.name,
                version: result.ghost.manifest.version,
              }));
            if (current) await options.onReady?.(result.ghost);
            break;
          case 'page':
            if (!current) break;
            if (options.onPage) options.onPage(result.route);
            else navigate(result.route);
            break;
          case 'unavailable':
            toast.info(t('newChat.pluginSuggestions.unavailable'));
            break;
          case 'failed':
            toast.error(t(result.messageKey));
            break;
          case 'cancelled':
            break;
        }
        return result;
      } finally {
        inFlight.delete(key);
        if (mounted.current) setBusy((current) => (current === key ? null : current));
      }
    },
    [navigate, t],
  );

  const isBusy = useCallback(
    (target: Pick<PluginInPlaceTarget, 'ghostId' | 'namespace'>) =>
      busy === JSON.stringify([target.namespace, target.ghostId]),
    [busy],
  );
  return { run, isBusy };
}
