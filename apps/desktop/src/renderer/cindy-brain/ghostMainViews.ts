import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';

import type { GhostMainViewIcon, GhostManifest, InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { useInstalledGhosts } from './useInstalledGhosts';
import {
  readMainViewSidebarVisible,
  useMainViewVisibilityRevision,
} from './mainViewVisibilityStore';

export interface GhostMainViewItem {
  ghostId: string;
  /** Physical instance id used in /apps/:id. Root stays ghostId; new org installs use storage part. */
  instanceId: string;
  title: string;
  icon: GhostMainViewIcon;
  manifest: GhostManifest;
  installedGhost: InstalledGhost;
}

export interface GhostMainViewProjection {
  declared: GhostMainViewItem[];
  routeCapable: GhostMainViewItem[];
  sidebarVisible: GhostMainViewItem[];
}

function mainViewDeclared(ghost: InstalledGhost): boolean {
  return ghost.manifest.mainView !== undefined;
}

export function projectGhostMainViews(
  ghosts: readonly InstalledGhost[],
  {
    locale,
    isSidebarVisible,
  }: {
    locale: string | undefined;
    isSidebarVisible: (instanceId: string) => boolean;
  },
): GhostMainViewProjection {
  const declared = ghosts
    .filter(mainViewDeclared)
    .map((installedGhost): GhostMainViewItem => {
      const { manifest } = installedGhost;
      return {
        ghostId: manifest.id,
        instanceId: installedGhostStoragePart(installedGhost),
        title: manifest.mainView?.title ?? manifest.name,
        icon: manifest.mainView?.icon ?? 'puzzle',
        manifest,
        installedGhost,
      };
    })
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title, locale, { sensitivity: 'base' }) ||
        left.instanceId.localeCompare(right.instanceId),
    );
  const routeCapable = declared.filter(
    ({ installedGhost }) => installedGhost.enabled && installedGhost.approval.state === 'approved',
  );
  const sidebarVisible = routeCapable.filter(({ instanceId }) => isSidebarVisible(instanceId));
  return { declared, routeCapable, sidebarVisible };
}

/** One reactive projection shared by the expanded sidebar, rail and route host. */
export function useGhostMainViews(): GhostMainViewProjection {
  const ghosts = useInstalledGhosts();
  const { dataOwnerId } = useAuth();
  const { i18n } = useTranslation();
  const visibilityRevision = useMainViewVisibilityRevision();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  return useMemo(
    () =>
      projectGhostMainViews(ghosts, {
        locale,
        isSidebarVisible: (instanceId) => readMainViewSidebarVisible(dataOwnerId, instanceId),
      }),
    [dataOwnerId, ghosts, locale, visibilityRevision],
  );
}
