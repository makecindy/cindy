/**
 * Claude Code plugin Skill discovery.
 *
 * Reads `<configDir>/plugins/installed_plugins.json`,
 * `<configDir>/plugins/known_marketplaces.json` and `<configDir>/settings.json`
 * (`enabledPlugins`), resolves every enabled plugin's declared `skills` roots,
 * and returns flat Skill folders named `<plugin>:<skill>` — the same namespace
 * Claude Code uses for plugin Skills.
 *
 * All failures are best-effort: an unreadable file or malformed entry yields
 * no Skills instead of breaking the palette / customization scan.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shouldPruneSkillScanDirectory } from './skill-scan-limits.js';

export interface ClaudePluginSkill {
  pluginName: string;
  skillName: string;
  /** `<pluginName>:<skillName>`, matching Claude Code's plugin namespace. */
  name: string;
  /** Absolute folder that contains SKILL.md. */
  folder: string;
  /** Absolute path to SKILL.md. */
  mdPath: string;
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findSkillFile(folder: string): string | null {
  for (const name of ['SKILL.md', 'skill.md']) {
    const candidate = path.join(folder, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing candidate: keep looking.
    }
  }
  return null;
}

function isDirectoryEntry(parent: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function addSkill(
  out: Map<string, ClaudePluginSkill>,
  pluginName: string,
  folder: string,
): void {
  const mdPath = findSkillFile(folder);
  if (!mdPath) return;
  const skillName = path.basename(folder);
  const name = `${pluginName}:${skillName}`;
  if (!out.has(name)) {
    out.set(name, { pluginName, skillName, name, folder, mdPath });
  }
}

function collectSkillsFromRoot(
  root: string,
  pluginName: string,
  out: Map<string, ClaudePluginSkill>,
): void {
  // A declared root may itself be a single Skill folder.
  if (findSkillFile(root)) {
    addSkill(out, pluginName, root);
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!isDirectoryEntry(root, entry)) continue;
    const folder = path.join(root, entry.name);
    // Names like `build` / `dist` / `target` are only pruned when the directory
    // is a namespace to walk into. A directory that is itself a Skill keeps its
    // name: Claude still resolves `/plugin:build` for it.
    if (shouldPruneSkillScanDirectory(entry.name) && !findSkillFile(folder)) continue;
    addSkill(out, pluginName, folder);
  }
}

function manifestSkillRoots(manifest: PluginManifest | null): string[] {
  // Claude Code treats a declared `skills` path as an addition to the
  // conventional `skills/` directory, not a replacement. Keeping both means a
  // plugin that declares `./extra` still exposes `skills/foo`.
  const roots = ['skills'];
  const declared = manifest?.skills;
  if (typeof declared === 'string' && declared.trim()) {
    roots.push(declared.trim());
  } else if (Array.isArray(declared)) {
    for (const item of declared) {
      if (typeof item === 'string' && item.trim()) roots.push(item.trim());
    }
  }
  return [...new Set(roots)];
}

/**
 * Directory marketplaces serve plugins from a local checkout instead of a
 * cache copy. For them `installed_plugins.json` records whatever snapshot was
 * cached — often stale — while Claude Code itself loads the plugin from
 * `installLocation` + the entry's `source`. Resolve that path first so the
 * palette shows the same Skills the running session uses.
 *
 * Returns null for non-directory marketplaces or when anything is missing, in
 * which case the caller falls back to the recorded `installPath`.
 */
function resolveDirectoryPluginDir(
  pluginKey: string,
  marketplaces: Record<string, unknown> | null,
): string | null {
  const [pluginName, marketplaceName] = pluginKey.split('@');
  if (!pluginName || !marketplaceName) return null;

  const marketplace = asRecord(marketplaces?.[marketplaceName]);
  if (asRecord(marketplace?.source)?.source !== 'directory') return null;

  const installLocation = marketplace?.installLocation;
  if (typeof installLocation !== 'string' || !installLocation) return null;

  const manifest = asRecord(
    readJson(path.join(installLocation, '.claude-plugin', 'marketplace.json')),
  );
  const entries = manifest?.plugins;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.name !== pluginName) continue;
    const relative = record.source;
    if (typeof relative !== 'string' || !relative.trim()) return null;
    const resolved = path.resolve(installLocation, relative.trim());
    // A checkout can be moved or deleted while the marketplace entry survives.
    // Only adopt the source when it is still a readable directory; otherwise
    // fall back to `installPath` so a valid cache is not silently dropped.
    try {
      if (!fs.statSync(resolved).isDirectory()) return null;
    } catch {
      return null;
    }
    return resolved;
  }
  return null;
}

/**
 * Claude merges `enabledPlugins` across settings layers, with the project's
 * own files winning over the user file. Reading only the user layer would
 * advertise plugins a project explicitly disabled (and hide ones it enabled).
 */
function readEnabledPlugins(
  configDir: string,
  workingDir?: string,
): Record<string, unknown> {
  const layers = [path.join(configDir, 'settings.json')];
  if (workingDir) {
    layers.push(
      path.join(workingDir, '.claude', 'settings.json'),
      path.join(workingDir, '.claude', 'settings.local.json'),
    );
  }
  const merged: Record<string, unknown> = {};
  for (const file of layers) {
    Object.assign(merged, asRecord(asRecord(readJson(file))?.enabledPlugins) ?? {});
  }
  return merged;
}

/**
 * User-scoped installs apply everywhere; project / local ones only inside the
 * project they were installed for. Records without a scope predate the field
 * and are user-level. An install that cannot be placed is skipped rather than
 * advertised in every project.
 */
function installMatchesProject(
  record: Record<string, unknown> | null,
  workingDir?: string,
): boolean {
  if (!record) return false;
  const scope = record.scope;
  if (typeof scope !== 'string' || scope === 'user') return true;
  if (!workingDir) return false;
  const projectPath = record?.projectPath;
  if (typeof projectPath !== 'string' || !projectPath) return false;
  return path.resolve(projectPath) === path.resolve(workingDir);
}

/**
 * List enabled Claude Code plugin Skills at `configDir`.
 * Deterministic order: plugin name, then Skill name.
 */
export function scanClaudePluginSkills(
  configDir = path.join(os.homedir(), '.claude'),
  opts?: { workingDir?: string },
): ClaudePluginSkill[] {
  const installed = asRecord(readJson(path.join(configDir, 'plugins', 'installed_plugins.json')));
  const plugins = asRecord(installed?.plugins);
  if (!plugins) return [];

  const enabledPlugins = readEnabledPlugins(configDir, opts?.workingDir);
  const marketplaces = asRecord(
    readJson(path.join(configDir, 'plugins', 'known_marketplaces.json')),
  );

  const out = new Map<string, ClaudePluginSkill>();
  for (const [pluginKey, installs] of Object.entries(plugins)) {
    // Installed plugins are enabled unless the user explicitly disabled them.
    if (enabledPlugins[pluginKey] === false) continue;
    if (!Array.isArray(installs)) continue;

    // Project / local scoped plugins only load inside their own project, so a
    // scan without project context keeps just the user-scoped installs.
    const scopedInstalls = installs
      .map((install) => asRecord(install))
      .filter((record) => installMatchesProject(record, opts?.workingDir));
    if (scopedInstalls.length === 0) continue;

    const directoryDir = resolveDirectoryPluginDir(pluginKey, marketplaces);
    const pluginDirs = directoryDir
      ? [directoryDir]
      : scopedInstalls
          .map((record) => record?.installPath)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const installPath of pluginDirs) {
      const manifest = asRecord(
        readJson(path.join(installPath, '.claude-plugin', 'plugin.json')),
      ) as PluginManifest | null;
      const manifestName = manifest?.name;
      const fallbackName = pluginKey.split('@')[0] || pluginKey;
      const pluginName =
        typeof manifestName === 'string' && manifestName.trim()
          ? manifestName.trim()
          : fallbackName;

      for (const root of manifestSkillRoots(manifest)) {
        const absolute = path.isAbsolute(root) ? root : path.resolve(installPath, root);
        collectSkillsFromRoot(absolute, pluginName, out);
      }
    }
  }

  return Array.from(out.values()).sort(
    (a, b) =>
      a.pluginName.localeCompare(b.pluginName) || a.skillName.localeCompare(b.skillName),
  );
}
