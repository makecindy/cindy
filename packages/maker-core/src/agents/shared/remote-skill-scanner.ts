import path from 'node:path';

import { remoteClaudeConfigDir } from '@cindy/maker-shared';

import type { RemoteAgentFileOps } from '../base-agent.js';
import type { AgentSkillCommand, ListAgentSkillsResult } from '../../types/palette.js';
import { shouldPruneSkillScanDirectory } from './skill-scan-limits.js';

const SKILL_READ_LIMIT = 1_048_576;

/**
 * Each remote probe is a separate SSH exec, so walking a plugin's Skills one at
 * a time costs two sequential round trips per Skill — a 55-Skill plugin spends
 * 110 round trips before the palette can render. Probe in bounded batches
 * instead; the result order is preserved.
 */
const REMOTE_PROBE_CONCURRENCY = 8;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function descriptionFromMarkdown(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      for (let index = 1; index < end; index += 1) {
        const match = lines[index]?.match(/^description\s*:\s*(.*)$/);
        if (!match) continue;
        const value = match[1]?.trim() ?? '';
        if (/^[|>][+-]?$/.test(value)) {
          const block: string[] = [];
          for (let cursor = index + 1; cursor < end; cursor += 1) {
            const line = lines[cursor] ?? '';
            if (/^\S/.test(line) && line.includes(':')) break;
            if (line.trim()) block.push(line.trim());
          }
          const text = block.join(value.startsWith('>') ? ' ' : '\n').trim();
          return text ? text.slice(0, 200) : undefined;
        }
        const text = stripYamlQuotes(value);
        return text ? text.slice(0, 200) : undefined;
      }
    }
  }
  return lines
    .map((line) => line.trim())
    .find((line) => line && line !== '---' && !line.startsWith('#'))
    ?.slice(0, 200);
}

async function readDescription(fileOps: RemoteAgentFileOps, file: string): Promise<string | undefined> {
  try {
    return descriptionFromMarkdown(await fileOps.readFile(file, SKILL_READ_LIMIT));
  } catch {
    return undefined;
  }
}

async function existingSkillFile(
  fileOps: RemoteAgentFileOps,
  directory: string,
): Promise<string | null> {
  for (const name of ['SKILL.md', 'skill.md']) {
    const candidate = path.posix.join(directory, name);
    if ((await fileOps.stat(candidate))?.isFile) return candidate;
  }
  return null;
}

async function isSymlinkedNamespace(
  fileOps: RemoteAgentFileOps,
  directory: string,
): Promise<boolean> {
  // Older hosts do not expose lstat. Treat an unverifiable namespace as a link
  // and skip it rather than following it outside the discovery root.
  if (!fileOps.lstat) return true;
  try {
    const stat = await fileOps.lstat(directory);
    return stat ? stat.isSymbolicLink : true;
  } catch {
    return true;
  }
}

async function scanSkillDirectories(input: {
  fileOps: RemoteAgentFileOps;
  root: string;
  scope: 'global' | 'project' | 'user' | 'repo';
  runtimeCommandPrefix?: string;
}): Promise<AgentSkillCommand[]> {
  const names = (await input.fileOps.listDir(input.root))
    .filter((name) => name && !name.startsWith('.') && !name.includes('/')
      && !/\.bak\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  const found: AgentSkillCommand[] = [];
  const addSkill = async (name: string, skillFile: string): Promise<void> => {
    found.push({
      kind: 'agent-skill',
      name,
      description: await readDescription(input.fileOps, skillFile),
      source: 'skill',
      path: skillFile,
      scope: input.scope,
      enabled: true,
      ...(input.runtimeCommandPrefix
        ? { runtimeCommandName: `${input.runtimeCommandPrefix}${name}` }
        : {}),
    });
  };

  // Direct Skills win over nested Skills with the same leaf name regardless of
  // directory order: collect them before walking namespaces.
  const namespaces: string[] = [];
  for (const name of names) {
    const skillDir = path.posix.join(input.root, name);
    const skillFile = await existingSkillFile(input.fileOps, skillDir);
    if (skillFile) {
      await addSkill(name, skillFile);
      continue;
    }
    if (shouldPruneSkillScanDirectory(name)) continue;
    if (await isSymlinkedNamespace(input.fileOps, skillDir)) continue;
    namespaces.push(name);
  }

  // At most one namespace/author level: <root>/<namespace>/<skill>.
  for (const name of namespaces) {
    const skillDir = path.posix.join(input.root, name);
    const nestedNames = (await input.fileOps.listDir(skillDir))
      .filter((nested) => nested && !nested.startsWith('.') && !nested.includes('/')
        && !/\.bak\.\d+$/.test(nested))
      .sort((a, b) => a.localeCompare(b));
    for (const nestedName of nestedNames) {
      // Direct Skills win over nested Skills with the same leaf name; keep the
      // first namespace when names collide.
      if (found.some((skill) => skill.name === nestedName)) continue;
      const nestedFile = await existingSkillFile(
        input.fileOps,
        path.posix.join(skillDir, nestedName),
      );
      if (nestedFile) await addSkill(nestedName, nestedFile);
    }
  }
  return found;
}

async function scanClaudeCommands(
  fileOps: RemoteAgentFileOps,
  root: string,
  scope: 'global' | 'project',
): Promise<AgentSkillCommand[]> {
  const names = (await fileOps.listDir(root))
    .filter((name) => name.endsWith('.md') && !name.startsWith('.') && !name.includes('/'))
    .sort((a, b) => a.localeCompare(b));
  const found: AgentSkillCommand[] = [];
  for (const fileName of names) {
    const file = path.posix.join(root, fileName);
    if (!(await fileOps.stat(file))?.isFile) continue;
    found.push({
      kind: 'agent-skill',
      name: fileName.slice(0, -3),
      description: await readDescription(fileOps, file),
      source: 'user',
      path: file,
      scope,
      enabled: true,
    });
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readRemoteJson(fileOps: RemoteAgentFileOps, file: string): Promise<unknown> {
  try {
    return JSON.parse(await fileOps.readFile(file, SKILL_READ_LIMIT));
  } catch {
    return null;
  }
}

function remoteManifestSkillRoots(manifest: Record<string, unknown> | null): string[] {
  // Same rule as the local scanner: a declared `skills` path supplements the
  // conventional `skills/` directory instead of replacing it.
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

async function remoteDirectoryExists(
  fileOps: RemoteAgentFileOps,
  dir: string,
): Promise<boolean> {
  try {
    const stat = await fileOps.stat(dir);
    return !!stat && !stat.isFile;
  } catch {
    return false;
  }
}

/**
 * Directory marketplaces keep the plugin in a local checkout; every other
 * marketplace location is resolved from `installed_plugins.json`. Remote paths
 * may start with `$HOME`, so they are joined rather than resolved as host paths.
 */
async function resolveRemoteDirectoryPluginDir(
  fileOps: RemoteAgentFileOps,
  pluginKey: string,
  marketplaces: Record<string, unknown> | null,
): Promise<string | null> {
  const [pluginName, marketplaceName] = pluginKey.split('@');
  if (!pluginName || !marketplaceName) return null;

  const marketplace = asRecord(marketplaces?.[marketplaceName]);
  if (asRecord(marketplace?.source)?.source !== 'directory') return null;

  const installLocation = marketplace?.installLocation;
  if (typeof installLocation !== 'string' || !installLocation) return null;

  const manifest = asRecord(await readRemoteJson(
    fileOps,
    path.posix.join(installLocation, '.claude-plugin/marketplace.json'),
  ));
  const entries = manifest?.plugins;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.name !== pluginName) continue;
    const relative = record.source;
    if (typeof relative !== 'string' || !relative.trim()) return null;
    const resolved = path.posix.join(installLocation, relative.trim());
    return (await remoteDirectoryExists(fileOps, resolved)) ? resolved : null;
  }
  return null;
}

async function scanRemotePluginSkillRoot(
  fileOps: RemoteAgentFileOps,
  root: string,
  pluginName: string,
): Promise<AgentSkillCommand[]> {
  // A declared root can itself be a single Skill folder (`skills: "./x/skill"`).
  // The local scanner recognizes that shape; the remote one has to as well or
  // the SSH palette silently drops such plugins.
  const rootSkillFile = await existingSkillFile(fileOps, root);
  if (rootSkillFile) {
    return [{
      kind: 'agent-skill',
      name: `${pluginName}:${path.posix.basename(root)}`,
      description: await readDescription(fileOps, rootSkillFile),
      source: 'skill',
      path: rootSkillFile,
      scope: 'global',
      enabled: true,
    }];
  }

  const names = (await fileOps.listDir(root))
    .filter((name) => name && !name.startsWith('.') && !name.includes('/')
      && !/\.bak\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  const probed = await mapLimit(
    names,
    REMOTE_PROBE_CONCURRENCY,
    async (name): Promise<AgentSkillCommand | null> => {
      const skillFile = await existingSkillFile(fileOps, path.posix.join(root, name));
      // Prune names only apply to namespaces; a directory that is itself a
      // Skill keeps its name (`build/SKILL.md` is `/plugin:build`).
      if (!skillFile) return null;
      return {
        kind: 'agent-skill',
        name: `${pluginName}:${name}`,
        description: await readDescription(fileOps, skillFile),
        source: 'skill',
        path: skillFile,
        scope: 'global',
        enabled: true,
      };
    },
  );
  return probed.filter((skill): skill is AgentSkillCommand => skill !== null);
}

/**
 * Enabled, user-scoped Claude Code plugin Skills on the remote host.
 *
 * Reads the directory the remote daemon actually uses — `claude-home`, not
 * `~/.claude`; cc-manager keeps Cindy state out of the host's global config.
 */
export async function scanRemoteClaudePluginSkills(
  fileOps: RemoteAgentFileOps,
): Promise<AgentSkillCommand[]> {
  const configDir = remoteClaudeConfigDir('$HOME');
  const installed = asRecord(
    await readRemoteJson(fileOps, `${configDir}/plugins/installed_plugins.json`),
  );
  const plugins = asRecord(installed?.plugins);
  if (!plugins) return [];

  const settings = asRecord(await readRemoteJson(fileOps, `${configDir}/settings.json`));
  const enabledPlugins = asRecord(settings?.enabledPlugins) ?? {};
  const marketplaces = asRecord(
    await readRemoteJson(fileOps, `${configDir}/plugins/known_marketplaces.json`),
  );

  const out = new Map<string, AgentSkillCommand>();
  for (const [pluginKey, installs] of Object.entries(plugins)) {
    if (enabledPlugins[pluginKey] === false) continue;
    if (!Array.isArray(installs)) continue;

    // Project / local scoped plugins only exist inside that project; a global
    // Skill list must not advertise commands the remote session cannot resolve.
    const userInstalls = installs
      .map((install) => asRecord(install))
      .filter((record) => record && (typeof record.scope !== 'string' || record.scope === 'user'));
    if (userInstalls.length === 0) continue;

    const directoryDir = await resolveRemoteDirectoryPluginDir(fileOps, pluginKey, marketplaces);
    const pluginDirs = directoryDir
      ? [directoryDir]
      : userInstalls
          .map((record) => record?.installPath)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const installPath of pluginDirs) {
      const manifest = asRecord(
        await readRemoteJson(fileOps, path.posix.join(installPath, '.claude-plugin/plugin.json')),
      ) as Record<string, unknown> | null;
      const manifestName = manifest?.name;
      const pluginName = typeof manifestName === 'string' && manifestName.trim()
        ? manifestName.trim()
        : (pluginKey.split('@')[0] || pluginKey);

      for (const root of remoteManifestSkillRoots(manifest)) {
        const absolute = root.startsWith('/') ? root : path.posix.join(installPath, root);
        for (const skill of await scanRemotePluginSkillRoot(fileOps, absolute, pluginName)) {
          if (!out.has(skill.name)) out.set(skill.name, skill);
        }
      }
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanRemoteClaudeSkills(input: {
  fileOps: RemoteAgentFileOps;
  workingDir?: string;
  /** Partner sessions never load the user's plugins; see ListAgentSkillsOptions. */
  excludePluginSkills?: boolean;
}): Promise<ListAgentSkillsResult> {
  const merged = new Map<string, AgentSkillCommand>();
  // Same directory the remote daemon runs with; see remoteClaudeConfigDir.
  const remoteConfigDir = remoteClaudeConfigDir('$HOME');
  const sources = [
    ...(await scanClaudeCommands(
      input.fileOps,
      path.posix.join(remoteConfigDir, 'commands'),
      'global',
    )),
    ...(await scanSkillDirectories({
      fileOps: input.fileOps,
      root: path.posix.join(remoteConfigDir, 'skills'),
      scope: 'global',
    })),
    ...(input.excludePluginSkills ? [] : await scanRemoteClaudePluginSkills(input.fileOps)),
  ];
  if (input.workingDir && path.posix.isAbsolute(input.workingDir)) {
    sources.push(
      ...(await scanClaudeCommands(
        input.fileOps,
        path.posix.join(input.workingDir, '.claude/commands'),
        'project',
      )),
      ...(await scanSkillDirectories({
        fileOps: input.fileOps,
        root: path.posix.join(input.workingDir, '.claude/skills'),
        scope: 'project',
      })),
    );
  }
  for (const skill of sources) merged.set(skill.name, skill);
  return { skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function scanRemotePiSkills(input: {
  fileOps: RemoteAgentFileOps;
  workingDir?: string;
}): Promise<ListAgentSkillsResult> {
  const sources: AgentSkillCommand[] = await scanSkillDirectories({
    fileOps: input.fileOps,
    root: '$HOME/.agents/skills',
    scope: 'user',
    runtimeCommandPrefix: 'skill:',
  });
  if (input.workingDir && path.posix.isAbsolute(input.workingDir)) {
    let current = path.posix.resolve(input.workingDir);
    sources.push(...await scanSkillDirectories({
      fileOps: input.fileOps,
      root: path.posix.join(current, '.pi/skills'),
      scope: 'repo',
      runtimeCommandPrefix: 'skill:',
    }));
    while (true) {
      sources.push(...await scanSkillDirectories({
        fileOps: input.fileOps,
        root: path.posix.join(current, '.agents/skills'),
        scope: 'repo',
        runtimeCommandPrefix: 'skill:',
      }));
      if (await input.fileOps.stat(path.posix.join(current, '.git'))) break;
      const parent = path.posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const deduped = new Map<string, AgentSkillCommand>();
  for (const skill of sources) deduped.set(`${skill.scope}\0${skill.path}`, skill);
  return { skills: [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
