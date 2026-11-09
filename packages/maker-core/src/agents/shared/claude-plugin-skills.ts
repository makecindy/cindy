/**
 * Claude Code plugin Skill discovery.
 *
 * Reads `<configDir>/plugins/installed_plugins.json`, the marketplace metadata
 * under `<configDir>/plugins/known_marketplaces.json`, and `enabledPlugins`
 * from the settings layers that apply to the session, then returns flat Skill
 * folders named `<plugin>:<skill>` — the same namespace Claude Code uses.
 *
 * Every input the scan needs is passed in: the config directory the session's
 * runtime actually uses, and (optionally) its Git root. The scanner never
 * infers either. Showing a Skill the running session does not load is worse
 * than showing nothing, so an unknown context yields no entries rather than a
 * `~/.claude` guess.
 *
 * All failures are best-effort: an unreadable file or malformed entry yields
 * no Skills instead of breaking the palette / customization scan.
 */

import fs from 'node:fs';
import path from 'node:path';

import { shouldPruneSkillScanDirectory } from './skill-scan-limits.js';

export type ClaudePluginSkillScope = 'user' | 'project' | 'local';

export interface ClaudeSkillScanContext {
  /** Absolute path to the config directory the session's runtime uses. */
  configDir: string;
  /** Git root of the session's project, when it has one. */
  projectRoot?: string;
  /** Scopes this scan may surface. Defaults to user-only. */
  scopes?: readonly ClaudePluginSkillScope[];
}

export interface ClaudePluginSkill {
  pluginName: string;
  skillName: string;
  /** `<pluginName>:<skillName>`, matching Claude Code's plugin namespace. */
  name: string;
  /** Absolute folder that contains SKILL.md. */
  folder: string;
  /** Absolute path to SKILL.md. */
  mdPath: string;
  scope: ClaudePluginSkillScope;
  /** Set for project / local scoped installs. */
  projectRoot?: string;
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
}

const USER_SCOPES: readonly ClaudePluginSkillScope[] = ['user'];
const PROJECT_SCOPES: readonly ClaudePluginSkillScope[] = ['user', 'project', 'local'];

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

/**
 * Compare project paths the way the platform does: resolve symlinks and, on
 * Windows, fold case — `C:\Repo` and `c:\repo` are the same project.
 */
function canonicalPath(value: string): string {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A missing path keeps its lexical form; comparison still needs to work.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
  scope: ClaudePluginSkillScope,
  projectRoot: string | undefined,
): void {
  const mdPath = findSkillFile(folder);
  if (!mdPath) return;
  const skillName = path.basename(folder);
  const name = `${pluginName}:${skillName}`;
  // Project-scoped entries win over user entries with the same name, matching
  // the order the collector runs in (user first, project/local after).
  out.set(name, {
    pluginName,
    skillName,
    name,
    folder,
    mdPath,
    scope,
    ...(projectRoot ? { projectRoot } : {}),
  });
}

function collectSkillsFromRoot(
  root: string,
  pluginName: string,
  scope: ClaudePluginSkillScope,
  projectRoot: string | undefined,
  out: Map<string, ClaudePluginSkill>,
): void {
  // A declared root may itself be a single Skill folder.
  if (findSkillFile(root)) {
    addSkill(out, pluginName, root, scope, projectRoot);
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
    addSkill(out, pluginName, folder, scope, projectRoot);
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
function readEnabledPlugins(context: ClaudeSkillScanContext): Record<string, unknown> {
  const layers = [path.join(context.configDir, 'settings.json')];
  if (context.projectRoot) {
    layers.push(
      path.join(context.projectRoot, '.claude', 'settings.json'),
      path.join(context.projectRoot, '.claude', 'settings.local.json'),
    );
  }
  const merged: Record<string, unknown> = {};
  for (const file of layers) {
    Object.assign(merged, asRecord(asRecord(readJson(file))?.enabledPlugins) ?? {});
  }
  return merged;
}

function installScope(record: Record<string, unknown> | null): ClaudePluginSkillScope {
  const scope = record?.scope;
  if (scope === 'project' || scope === 'local') return scope;
  // Records without a scope predate the field and are user-level.
  return 'user';
}

/**
 * A user-scoped install applies everywhere; project / local ones only inside
 * the project they were installed for. An install that cannot be placed is
 * skipped rather than advertised in every project.
 */
function installMatchesContext(
  record: Record<string, unknown> | null,
  context: ClaudeSkillScanContext,
  allowedScopes: readonly ClaudePluginSkillScope[],
): boolean {
  if (!record) return false;
  const scope = installScope(record);
  if (!allowedScopes.includes(scope)) return false;
  if (scope === 'user') return true;
  if (!context.projectRoot) return false;
  const projectPath = record.projectPath;
  if (typeof projectPath !== 'string' || !projectPath) return false;
  return canonicalPath(projectPath) === canonicalPath(context.projectRoot);
}

/**
 * List enabled Claude Code plugin Skills for one scan context.
 * Deterministic order: plugin name, then Skill name.
 */
export function scanClaudePluginSkills(
  context: ClaudeSkillScanContext,
): ClaudePluginSkill[] {
  if (!context.configDir) return [];
  // A project context widens the default: project / local installs are only
  // reachable once we know which project they belong to.
  const allowedScopes = context.scopes
    ?? (context.projectRoot ? PROJECT_SCOPES : USER_SCOPES);

  const installed = asRecord(
    readJson(path.join(context.configDir, 'plugins', 'installed_plugins.json')),
  );
  const plugins = asRecord(installed?.plugins);
  if (!plugins) return [];

  const enabledPlugins = readEnabledPlugins(context);
  const marketplaces = asRecord(
    readJson(path.join(context.configDir, 'plugins', 'known_marketplaces.json')),
  );

  const out = new Map<string, ClaudePluginSkill>();
  for (const [pluginKey, installs] of Object.entries(plugins)) {
    // Installed plugins are enabled unless the user explicitly disabled them.
    if (enabledPlugins[pluginKey] === false) continue;
    if (!Array.isArray(installs)) continue;

    const matching = installs
      .map((install) => asRecord(install))
      .filter((record) => installMatchesContext(record, context, allowedScopes));
    if (matching.length === 0) continue;

    const directoryDir = resolveDirectoryPluginDir(pluginKey, marketplaces);

    // User installs first so project / local entries override them by name.
    matching.sort((a, b) => Number(installScope(a) !== 'user') - Number(installScope(b) !== 'user'));

    for (const record of matching) {
      const scope = installScope(record);
      const projectRoot = scope === 'user' ? undefined : context.projectRoot;
      const installPath = directoryDir ?? record?.installPath;
      if (typeof installPath !== 'string' || !installPath) continue;

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
        collectSkillsFromRoot(absolute, pluginName, scope, projectRoot, out);
      }
    }
  }

  return Array.from(out.values()).sort(
    (a, b) =>
      a.pluginName.localeCompare(b.pluginName) || a.skillName.localeCompare(b.skillName),
  );
}
