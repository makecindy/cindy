import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseClaudeSettingsJson } from '@cindy/maker-core';
import { groupMcpDuplicateConnections, type CustomMcpConfig, type McpDuplicateChoice, type McpDuplicateReport } from '../../shared/customMcp.js';

type JsonObject = Record<string, unknown>;
/** Bounded, read-only native configuration reader; missing files are empty. */
export async function readMcpJson(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Unsupported MCP configuration');
    const raw = await handle.readFile('utf8');
    return ['settings.json', 'settings.local.json'].includes(path.basename(file))
      ? parseClaudeSettingsJson(raw) : JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  } finally { await handle?.close(); }
}

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export interface McpDuplicateDetectionDeps {
  readJson(file: string): Promise<unknown>;
  home: string;
  listCustom(): Promise<CustomMcpConfig[]>;
  builtinNames(): string[];
  workspaceSettingsFiles(workingDir: string): Promise<string[]>;
  readToken(id: string): string | null;
  readChoices(): Record<string, McpDuplicateChoice>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function referencedEnvironment(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return [...value.matchAll(/\$\{([^}:]+)(?::-([^}]*))?\}/g)]
    .map(([, key, fallback]) => [key, env[key!] ?? fallback ?? null]);
  if (Array.isArray(value)) return value.map(item => referencedEnvironment(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, referencedEnvironment(item, env)]));
  return null;
}
function endpoint(raw: unknown, env: NodeJS.ProcessEnv): URL | undefined {
  if (typeof raw !== 'string') return;
  let unresolved = false;
  const expanded = raw.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, key: string, fallback?: string) => {
    const value = env[key] ?? fallback;
    if (value === undefined) unresolved = true;
    return value ?? '';
  });
  if (unresolved) return;
  try {
    const url = new URL(expanded);
    return ['http:', 'https:'].includes(url.protocol) ? url : undefined;
  } catch { return; }
}
function relation(a: URL, b: URL): 'endpoint' | 'similar' | undefined {
  if (a.origin !== b.origin) return;
  const ap = a.pathname.replace(/\/+$/, '');
  const bp = b.pathname.replace(/\/+$/, '');
  if (ap === bp) return a.search === b.search ? 'endpoint' : 'similar';
  // A router may expose a client-specific child route. This is only a suggestion,
  // never proof of equivalence and never permission to disable either connection.
  if (ap && bp && (ap.startsWith(`${bp}/`) || bp.startsWith(`${ap}/`))) return 'similar';
  return;
}

/** Read-only user-scope diagnostics. Project/local overrides mask a user entry at runtime. */
export async function detectMcpDuplicates(
  deps: McpDuplicateDetectionDeps,
  input: { env: NodeJS.ProcessEnv; workingDir?: string },
): Promise<McpDuplicateReport> {
  const connections: McpDuplicateReport['connections'] = [];
  try {
    const configFile = input.env.CLAUDE_CONFIG_DIR
      ? path.join(input.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(deps.home, '.claude.json');
    const rawConfig = await deps.readJson(configFile);
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return { connections, complete: false };
    const config = object(rawConfig);
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
      return { connections, complete: false };
    }
    const native = object(config.mcpServers);
    const masked = new Set<string>((Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : [])
      .filter((name): name is string => typeof name === 'string'));
    const settingsFiles = new Set([path.join(input.env.CLAUDE_CONFIG_DIR ?? path.join(deps.home, '.claude'), 'settings.json')]);
    if (input.workingDir) {
      // Share CLI discovery with the runtime guard: lexical paths alone miss an
      // external symlink target and a linked worktree's canonical repository.
      const workspaceDirs = new Set([path.resolve(input.workingDir)]);
      for (const file of await deps.workspaceSettingsFiles(input.workingDir)) {
        settingsFiles.add(file);
        workspaceDirs.add(path.dirname(path.dirname(file)));
      }
      for (const dir of workspaceDirs) {
        for (const key of new Set([dir, dir.replace(/\\/g, '/')])) {
          const project = object(object(config.projects)[key]);
          for (const name of Object.keys(object(project.mcpServers))) masked.add(name);
          for (const name of Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []) {
            if (typeof name === 'string') masked.add(name);
          }
        }
      }
      // Native project discovery can inherit ancestor .mcp.json files. Be conservative:
      // never apply a user-scope choice to a same-name project connection.
      const scannedDirs = new Set<string>();
      for (const start of workspaceDirs) for (let dir = start; !scannedDirs.has(dir);) {
        scannedDirs.add(dir);
        settingsFiles.add(path.join(dir, '.claude', 'settings.json'));
        settingsFiles.add(path.join(dir, '.claude', 'settings.local.json'));
        const scoped = object(await deps.readJson(path.join(dir, '.mcp.json')));
        for (const name of Object.keys(object(scoped.mcpServers))) masked.add(name);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // Re-read inherited restrictions before applying a saved source choice. Name
    // denials are unambiguous; complex policy/allowlist semantics belong to the CLI.
    // If we cannot establish availability, never omit Cindy's connection.
    for (const file of settingsFiles) {
      const raw = await deps.readJson(file);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { connections: [], complete: false };
      const settings = object(raw);
      if (settings.allowedMcpServers !== undefined || settings.allowManagedMcpServersOnly === true
        || settings.strictPluginOnlyCustomization !== undefined) return { connections: [], complete: false };
      if (settings.deniedMcpServers === undefined) continue;
      if (!Array.isArray(settings.deniedMcpServers)) return { connections: [], complete: false };
      for (const denied of settings.deniedMcpServers) {
        const rule = object(denied);
        if (Object.keys(rule).length !== 1 || typeof rule.serverName !== 'string'
          || !rule.serverName || rule.serverName.trim() !== rule.serverName) return { connections: [], complete: false };
        masked.add(rule.serverName);
      }
    }
    const custom = await deps.listCustom();
    const injectedNames = new Set([...deps.builtinNames(), ...custom.map(server => server.id)]);
    const choices = deps.readChoices();
    for (const server of custom) {
      const hostUrl = endpoint(server.url, input.env);
      if (!hostUrl) continue;
      for (const [name, raw] of Object.entries(native)) {
        if (masked.has(name) || injectedNames.has(name)) continue;
        const entry = object(raw);
        const nativeUrl = endpoint(entry.url, input.env);
        if (!nativeUrl || (entry.type !== 'http' && entry.type !== 'sse')) continue;
        const reason = relation(hostUrl, nativeUrl);
        if (!reason) continue;
        const id = fingerprint([configFile, server, deps.readToken(server.id), name, entry, nativeUrl.href,
          referencedEnvironment(entry, input.env)]);
        connections.push({ id, cindyId: server.id, cindyName: server.name, claudeName: name,
          origin: hostUrl.origin, reason, ...(choices[id] ? { choice: choices[id] } : {}) });
      }
    }
    return { connections, complete: true };
  } catch {
    // Unknown formats/read failures are advisory only; preserve native behavior.
    return { connections: [], complete: false };
  }
}

/** Connected components prevent contradictory pair choices from disabling both sides. */
export function resolveMcpDuplicateChoices(report: McpDuplicateReport): {
  skipHostServers: string[]; denyNativeServers: string[];
} {
  if (!report.complete) return { skipHostServers: [], denyNativeServers: [] };
  const skipHostServers = new Set<string>();
  const denyNativeServers = new Set<string>();
  for (const group of groupMcpDuplicateConnections(report.connections)) {
    const hosts = new Set(group.map(pair => pair.cindyId));
    const natives = new Set(group.map(pair => pair.claudeName));
    if (group.every(pair => pair.choice === 'cindy')) for (const name of natives) denyNativeServers.add(name);
    if (group.every(pair => pair.choice === 'claude')) for (const name of hosts) skipHostServers.add(name);
  }
  return { skipHostServers: [...skipHostServers], denyNativeServers: [...denyNativeServers] };
}
