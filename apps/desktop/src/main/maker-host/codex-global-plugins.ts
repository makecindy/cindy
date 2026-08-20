import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  isSameOrInside,
  normalizeForCompare,
  removeManagedLink,
} from './managed-dir-links.js';

const MANAGED_OVERLAY_MARKER = '.cindy-capability-routing.json';

interface ManagedOverlayMarker {
  schemaVersion: 1;
  source: string;
  sourceSnapshot: string;
  skills: unknown[];
}

export interface CodexGlobalPluginsRetirementResult {
  changed: boolean;
  removedMarketplaces: string[];
  warnings: string[];
}

export function codexGlobalPluginsPaths(codexHome: string, homeDir = os.homedir()) {
  return {
    cacheDir: path.join(codexHome, 'plugins', 'cache'),
    sourceCacheDir: path.join(homeDir, '.codex', 'plugins', 'cache'),
  };
}

async function readManagedOverlayMarker(
  marketplaceDir: string,
): Promise<ManagedOverlayMarker | null> {
  try {
    const raw = await fsp.readFile(
      path.join(marketplaceDir, MANAGED_OVERLAY_MARKER),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Partial<ManagedOverlayMarker>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.source !== 'string' ||
      typeof parsed.sourceSnapshot !== 'string' ||
      !Array.isArray(parsed.skills)
    ) {
      return null;
    }
    return parsed as ManagedOverlayMarker;
  } catch {
    return null;
  }
}

function resolvesInside(candidate: string, parent: string): boolean {
  return isSameOrInside(
    normalizeForCompare(candidate),
    normalizeForCompare(parent),
  );
}

async function managedLinkTarget(
  linkPath: string,
  sourceCacheDir: string,
): Promise<string | null> {
  try {
    const target = await fsp.readlink(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), target);
    return resolvesInside(resolved, sourceCacheDir) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Retire the legacy bridge that projected ~/.codex plugin marketplaces into
 * Cindy's isolated CODEX_HOME. Only Cindy-owned symlinks and marked routing
 * overlays are removed; Codex-managed real directories and user config remain
 * untouched. Runtime plugin isolation is enforced separately per thread.
 */
export async function retireCodexGlobalPluginsBridge(
  codexHome: string,
  opts: { homeDir?: string } = {},
): Promise<CodexGlobalPluginsRetirementResult> {
  const { cacheDir, sourceCacheDir } = codexGlobalPluginsPaths(
    codexHome,
    opts.homeDir,
  );
  const removedMarketplaces: string[] = [];
  const warnings: string[] = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { changed: false, removedMarketplaces, warnings };
    }
    return {
      changed: false,
      removedMarketplaces,
      warnings: [
        `cannot inspect isolated Codex plugin cache ${cacheDir}: ${(error as Error).message}`,
      ],
    };
  }

  for (const entry of entries) {
    const entryPath = path.join(cacheDir, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        if (!(await managedLinkTarget(entryPath, sourceCacheDir))) continue;
        if (await removeManagedLink(entryPath)) removedMarketplaces.push(entry.name);
        continue;
      }
      if (!entry.isDirectory()) continue;

      const marker = await readManagedOverlayMarker(entryPath);
      if (!marker || !resolvesInside(marker.source, sourceCacheDir)) continue;
      await fsp.rm(entryPath, { recursive: true, force: true });
      removedMarketplaces.push(entry.name);
    } catch (error) {
      warnings.push(
        `cannot retire isolated Codex plugin marketplace ${entryPath}: ${(error as Error).message}`,
      );
    }
  }

  removedMarketplaces.sort();
  return {
    changed: removedMarketplaces.length > 0,
    removedMarketplaces,
    warnings,
  };
}
