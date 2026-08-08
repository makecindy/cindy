/**
 * Pi filesystem customization scanner.
 *
 * Pi reads user skills from ~/.agents/skills in Cindy sessions. Project skills
 * live in {cwd}/.pi/skills and in every .agents/skills directory from cwd up to
 * the nearest Git repository root. Project discovery is only a preview until
 * Pi's runtime catalog confirms a skill was loaded.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentCustomization,
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

function canonicalDirectory(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    const marker = fs.statSync(path.join(dir, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

/** Find the nearest Git root without spawning Git or walking above a nested repository. */
function findNearestGitRoot(workingDir: string): string | null {
  let current = canonicalDirectory(workingDir);
  while (true) {
    if (hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function agentSkillAncestors(workingDir: string): string[] {
  const start = canonicalDirectory(workingDir);
  const repoRoot = findNearestGitRoot(start);
  const result: string[] = [];
  let current = start;

  while (true) {
    result.push(current);
    if (!repoRoot || current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export function buildPiSources(workingDirs: string[]): SourceDef[] {
  const sources: SourceDef[] = [
    {
      engine: 'pi',
      kind: 'skill',
      scope: 'user',
      dir: path.join(os.homedir(), '.agents', 'skills'),
    },
  ];
  const seen = new Set<string>();

  for (const input of workingDirs) {
    if (!input || !path.isAbsolute(input)) continue;
    const workingDir = canonicalDirectory(input);
    const addProjectSource = (dir: string): void => {
      const key = `${workingDir}\0${canonicalDirectory(dir)}`;
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({
        engine: 'pi',
        kind: 'skill',
        scope: 'repo',
        dir,
        workingDir,
        runtimeStatus: 'discovered',
      });
    };

    addProjectSource(path.join(workingDir, '.pi', 'skills'));
    for (const ancestor of agentSkillAncestors(workingDir)) {
      addProjectSource(path.join(ancestor, '.agents', 'skills'));
    }
  }
  return sources;
}

function dedupePiItems(items: AgentCustomization[]): AgentCustomization[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    // Preserve the same physical skill when it belongs to a different scope or
    // working directory: those entries carry different trust/project meaning.
    const key = [
      item.scope,
      item.workingDir ?? '',
      canonicalDirectory(item.absolutePath),
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scanPiCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }

  const result = scanCustomizationSources(buildPiSources(opts.workingDirs ?? []), null);
  result.items = dedupePiItems(result.items);
  result.items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.absolutePath.localeCompare(b.absolutePath);
  });
  return result;
}
