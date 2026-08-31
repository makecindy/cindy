import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';

import type { GhostMainViewIcon, GhostManifest, InstalledGhost } from '../../shared/ghost';
import { useInstalledGhosts } from './useInstalledGhosts';
import {
  readMainViewSidebarVisible,
  useMainViewVisibilityRevision,
} from './mainViewVisibilityStore';

export interface GhostMainViewItem {
  ghostId: string;
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
    isSidebarVisible: (ghostId: string) => boolean;
  },
): GhostMainViewProjection {
  const declared = ghosts
    .filter(mainViewDeclared)
    .map((installedGhost): GhostMainViewItem => {
      const { manifest } = installedGhost;
      return {
        ghostId: manifest.id,
        title: manifest.mainView?.title ?? manifest.name,
        icon: manifest.mainView?.icon ?? 'puzzle',
        manifest,
        installedGhost,
      };
    })
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title, locale, { sensitivity: 'base' }) ||
        left.ghostId.localeCompare(right.ghostId),
    );
  const routeCapable = declared.filter(
    ({ installedGhost }) => installedGhost.enabled && installedGhost.approval.state === 'approved',
  );
  const sidebarVisible = routeCapable.filter(({ ghostId }) => isSidebarVisible(ghostId));
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
        isSidebarVisible: (ghostId) => readMainViewSidebarVisible(dataOwnerId, ghostId),
      }),
    [dataOwnerId, ghosts, locale, visibilityRevision],
  );
}
