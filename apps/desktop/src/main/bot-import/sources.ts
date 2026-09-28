import { markImportEnvironmentChoices, previewImportRedactions, resolveImportEnvironmentDependencies } from './environmentSelection.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { importedScriptName, isImportedScriptDependency } from './scripts.js';
import JSON5 from 'json5';
import { redactEnvironmentValues } from './process.js';
import yaml from 'js-yaml';
import { parse as parseEnv } from 'dotenv';
import { createImportBudget, fingerprint, optionalText, readImportFile, readImportTree, snapshotFingerprint, type ImportReadBudget } from './files.js';
import { normalizeAutomation } from './sourceAutomations.js';
import { CompanionImportError, object, string, type ImportItem, type ImportSnapshot, type ImportSource } from './types.js';

export interface SourceReaderDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  readCronDatabase(input: { database: string; storeKey: string; agentId: string; defaultAgent: boolean }): Promise<Record<string, unknown>[]>;
}

async function directories(folder: string): Promise<string[]> {
  try { return (await fs.readdir(folder, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

function sourcePath(home: string, value: string, relativeTo: string): string {
  return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(relativeTo, value);
}

async function config(root: string, file: string, budget = createImportBudget(), ancestors: string[] = [], readText = optionalText, cache?: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (ancestors.includes(file) || ancestors.length > 8) throw new CompanionImportError('SOURCE_CONFIG_INCLUDE_CYCLE');
  const key = JSON.stringify([root, file]);
  const cached = cache?.get(key);
  if (cached) return cached;
  const load = async () => {
    const text = await readText(root, file, budget);
    if (text === undefined) return {};
    try {
      const resolve = async (value: unknown): Promise<unknown> => {
        if (Array.isArray(value)) return Promise.all(value.map(resolve));
        if (!value || typeof value !== 'object') return value;
        const record = object(value);
        const includes = record.$include === undefined ? [] : Array.isArray(record.$include) ? record.$include : [record.$include];
        let result: Record<string, unknown> = {};
        for (const include of includes) {
          if (typeof include !== 'string') throw new Error('Invalid include');
          result = mergeConfig(result, await config(root, path.resolve(path.dirname(file), include), budget, [...ancestors, file], readText, cache));
        }
        for (const [key, child] of Object.entries(record)) if (key !== '$include' && !['__proto__', 'constructor', 'prototype'].includes(key)) result = mergeConfig(result, { [key]: await resolve(child) });
        return result;
      };
      return object(await resolve(/\.ya?ml$/i.test(file) ? yaml.load(text) : JSON5.parse(text)));
    }
    catch (error) { if (error instanceof CompanionImportError) throw error; throw new CompanionImportError('SOURCE_CONFIG_INVALID'); }
  };
  // Cache completed parses only: concurrent include branches must still walk
  // their ancestry to reject cycles rather than await each other's promises.
  const values = await load();
  cache?.set(key, values);
  return values;
}

function mergeConfig(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const output = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(object(output[key]), object(value)) : value;
  }
  return output;
}

function agentRows(config: Record<string, unknown>): Record<string, unknown>[] {
  const agents = object(config.agents);
  const rows = agents.entries ?? agents.list;
  if (Array.isArray(rows)) return rows.map(object);
  if (rows && typeof rows === 'object') return Object.entries(object(rows)).map(([id, value]) => ({ ...object(value), id }));
  return [{ id: 'main', default: true }];
}

/** Only installed default roots are discovered. Custom locations require a host folder grant. */
export async function discoverImportSources(deps: SourceReaderDeps, reader = createImportSourceReader(deps)): Promise<ImportSource[]> {
  const results: ImportSource[] = [];
  const hermesRoot = sourcePath(deps.home, deps.env.HERMES_HOME || path.join(deps.home, '.hermes'), deps.home);
  const roots = [{ root: hermesRoot, id: 'default' }, ...(await directories(path.join(hermesRoot, 'profiles'))).map(id => ({ root: path.join(hermesRoot, 'profiles', id), id }))];
  for (const { root, id } of roots) {
    const configFile = path.join(root, 'config.yaml');
    if (await reader.readText(root, configFile) === undefined) continue;
    const values = await reader.readConfig(root, configFile);
    const terminal = object(values.terminal);
    const workspace = string(terminal.cwd) || string(values.workdir) || root;
    results.push({ kind: 'hermes', agentId: id, name: string(values.name) || id, root, configFile,
      workspace: sourcePath(deps.home, workspace, root) });
  }
  const clawRoot = sourcePath(deps.home, deps.env.OPENCLAW_STATE_DIR || path.join(deps.home, '.openclaw'), deps.home);
  const configFile = sourcePath(deps.home, deps.env.OPENCLAW_CONFIG_PATH || path.join(clawRoot, 'openclaw.json'), clawRoot);
  // An explicitly configured external config is itself a trusted discovery root, not a renderer path.
  if (await reader.readText(path.dirname(configFile), configFile) !== undefined) {
    const values = await reader.readConfig(path.dirname(configFile), configFile);
    const defaults = object(object(values.agents).defaults);
    for (const row of agentRows(values)) {
      const id = string(row.id);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new CompanionImportError('SOURCE_AGENT_INVALID');
      results.push({ kind: 'openclaw', agentId: id, name: string(row.name) || string(object(row.identity).name) || id,
        root: clawRoot, configFile,
        workspace: sourcePath(deps.home, string(row.workspace) || string(defaults.workspace) || path.join(clawRoot, id === 'main' ? 'workspace' : `workspace-${id}`), clawRoot) });
    }
  }
  return results;
}

function entryId(prefix: string, name: string): string { return `${prefix}-${fingerprint(name).slice(0, 20)}`; }

async function document(items: ImportItem[], root: string, name: string, role: ImportItem['role'], category: 'personality' | 'memory', budget: ImportReadBudget) {
  const text = await optionalText(root, path.join(root, name), budget);
  if (!text?.trim()) return;
  items.push({ view: { id: entryId(category, name), category, name, selected: true }, text, role });
}

async function memoryDocuments(items: ImportItem[], root: string, prefix: string, budget: ImportReadBudget) {
  if (!(await directories(root)).includes(prefix)) return;
  const files = await readImportTree(path.join(root, prefix), name => /\.md$/i.test(name), budget);
  for (const file of files.filter(file => /\.md$/i.test(file.name))) {
    items.push({ view: { id: entryId('memory', `${prefix}/${file.name}`), category: 'memory', name: file.name, selected: true },
      text: file.bytes.toString('utf8'), role: /(^|\/)USER\.md$/i.test(file.name) ? 'user' : undefined });
  }
}

function scalarEnv(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] =>
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry[0]) && !['__proto__', 'prototype', 'constructor'].includes(entry[0]) && typeof entry[1] === 'string'));
}

async function connections(items: ImportItem[], source: ImportSource, values: Record<string, unknown>, deps: SourceReaderDeps, budget: ImportReadBudget, readText = optionalText) {
  const dotenv = parseEnv(await readText(source.root, path.join(source.root, '.env'), budget) ?? '');
  const envConfig = object(values.env);
  const env = { ...dotenv, ...scalarEnv(envConfig), ...scalarEnv(envConfig.vars) };
  for (const [name, value] of Object.entries(env)) {
    items.push({ view: { id: entryId('env', name), category: 'connections', name, selected: true }, env: { [name]: value } });
  }
  const servers = object(values.mcp_servers ?? values.mcpServers ?? object(values.mcp).servers);
  for (const [name, raw] of Object.entries(servers)) {
    // References resolve only from source entries, never Cindy's process environment.
    // Keep placeholders until selection is final. Otherwise deselecting an env item
    // would still copy its expanded secret inside an independently selected MCP.
    const references = new Set<string>();
    JSON.stringify(raw).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => { references.add(key); return ''; });
    const record = object(raw);
    const enabled = record.enabled !== false && record.disabled !== true;
    const command = string(record.command), url = string(record.url);
    let cwd: string | undefined;
    if (command) {
      if (record.cwd !== undefined && (typeof record.cwd !== 'string' || !record.cwd.trim() || record.cwd.includes('\0')))
        throw new CompanionImportError('SOURCE_CONFIG_INVALID');
      const rawCwd = string(record.cwd) || source.workspace;
      // Do not expand an unselected env value into the private connection. A
      // leading reference may become absolute, so anchor it only after selection.
      cwd = rawCwd.includes('${')
        ? rawCwd.startsWith('~/') ? path.join(deps.home, rawCwd.slice(2)) : rawCwd
        : sourcePath(deps.home, rawCwd, source.workspace);
    }
    items.push({ view: { id: entryId('mcp', name), category: 'connections', name, selected: enabled, enabled, dependsOn: [...references].map(key => entryId('env', key)) },
      envDependencies: { names: [...references], entries: [] },
      mcp: { name, enabled, ...(command ? { command, args: Array.isArray(record.args) ? record.args.map(string) : [], cwd, transport: 'stdio' as const } : { url, transport: record.transport === 'sse' ? 'sse' as const : 'http' as const }),
        env: scalarEnv(record.env), headers: scalarEnvHeaders(record.headers) } });
  }
  const telegram = object(object(values.channels).telegram);
  const accounts = Object.keys(object(telegram.accounts)).length ? object(telegram.accounts) : { default: telegram };
  for (const [account, raw] of Object.entries(accounts)) {
    const settings = object(raw);
    let token = string(settings.botToken) || (source.kind === 'hermes' && env.TELEGRAM_BOT_TOKEN ? '${TELEGRAM_BOT_TOKEN}' : '');
    const references = [...token.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!);
    if (!token && typeof settings.tokenFile === 'string') {
      const file = sourcePath(deps.home, settings.tokenFile, source.root);
      token = (await readText(path.dirname(file), file, budget))?.trim() ?? '';
    }
    if (token) items.push({ view: { id: entryId('telegram', account), name: `Telegram · ${account}`, category: 'connections', selected: true, dependsOn: references.map(key => entryId('env', key)) }, envDependencies: { names: references, entries: [] }, credential: { format: 'telegram', value: { token, account } } });
  }
  // Keep native auth metadata without exposing its contents or inventing a refresh protocol.
  // API keys have a direct environment equivalent; provider OAuth needs its native refresh adapter.
  const authFiles = source.kind === 'hermes' ? ['auth.json'] : [`agents/${source.agentId}/agent/auth-profiles.json`];
  for (const name of authFiles) {
    const raw = await readText(source.root, path.join(source.root, name), budget);
    if (!raw) continue;
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(raw)); } catch { throw new CompanionImportError('SOURCE_CREDENTIAL_INVALID'); }
    const profiles = source.kind === 'hermes' ? { ...object(value.providers), ...Object.fromEntries(Object.entries(object(value.credential_pool)).map(([key, records]) => [key, { ...object(object(value.providers)[key]), credential_pool: records }])) } : object(value.profiles);
    for (const [id, record] of Object.entries(profiles)) {
      if (!record || typeof record !== 'object') continue;
      const profile = object(record);
      const provider = string(profile.provider) || id.split(':')[0]!;
      const keyVariables: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', xai: 'XAI_API_KEY', google: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
      const apiKey = profile.type === 'api_key' || profile.auth_type === 'api_key' ? string(profile.key) || string(profile.api_key) : '';
      const variable = keyVariables[provider];
      items.push({ view: { id: entryId('credential', `${name}:${id}`), category: 'connections', name: `${id} · ${path.basename(name)}`, selected: true,
        ...(apiKey && variable ? {} : { issues: ['NATIVE_AUTH_REFRESH_REQUIRED'] }) }, ...(apiKey && variable ? { env: { [variable]: apiKey } } : {}), credential: { format: 'native-auth', value: { source: source.kind, file: name, profile: id, value: profile } } });
    }
  }
}

function scalarEnvHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

async function skills(items: ImportItem[], roots: string[], used: Set<string>, budget: ImportReadBudget) {
  const names = new Set<string>();
  for (const root of roots) {
    for (const slug of await directories(root)) {
      if (names.has(slug)) continue;
      const dir = path.join(root, slug);
      let manifest;
      try { manifest = await readImportFile(dir, path.join(dir, 'SKILL.md'), budget); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const text = manifest.bytes.toString('utf8');
      if (!text) continue;
      names.add(slug);
      let info: Record<string, unknown> = {};
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (front) try { info = object(yaml.load(front[1]!)); } catch { /* Raw skill is retained, and its native loader reports syntax errors. */ }
      const name = string(info.name) || slug;
      const referenced = used.has(slug) || used.has(name);
      items.push({ view: { id: entryId('skill', slug), category: 'skills', name, description: string(info.description).slice(0, 280), selected: referenced },
        sourceDirectory: dir, files: referenced ? [manifest, ...await readImportTree(dir, name => name !== 'SKILL.md', budget)] : [manifest], filesComplete: referenced });
    }
  }
}

function sourceConfiguration(items: ImportItem[], source: ImportSource, values: Record<string, unknown>) {
  const row = source.kind === 'openclaw' ? agentRows(values).find(row => row.id === source.agentId) ?? {} : values;
  const tools = source.kind === 'openclaw' ? { ...(values.tools ? { global: values.tools } : {}), ...(row.tools ? { agent: row.tools } : {}) } : object(values.tools);
  if (Object.keys(tools).length) items.push({ view: { id: entryId('configuration', 'tools'), name: 'tools', category: 'connections', selected: true, issues: ['SOURCE_TOOL_POLICY_NEEDS_MAPPING'] }, credential: { format: 'source-tools', value: tools } });
  const nativeModel = source.kind === 'hermes' ? values.model : row.model ?? object(object(values.agents).defaults).model;
  if (nativeModel) items.push({ view: { id: entryId('configuration', 'model'), name: 'model', category: 'connections', selected: true, issues: ['AUTOMATION_MODEL_NEEDS_MAPPING'] }, credential: { format: 'source-model', value: nativeModel } });
}

/** One discovery request shares a small metadata budget/cache. Never read cron,
 * memory, portraits or skill trees until the user chooses a source for preview. */
export function createImportSourceReader(deps: SourceReaderDeps, budget = createImportBudget(4 * 1024 * 1024)) {
  const texts = new Map<string, Promise<string | undefined>>();
  const configs = new Map<string, Record<string, unknown>>();
  const readText: typeof optionalText = (root, file) => {
    // Include the trust root: a cached read must not bypass a narrower root fence.
    const key = JSON.stringify([root, file]);
    let pending = texts.get(key);
    if (!pending) { pending = optionalText(root, file, budget); texts.set(key, pending); }
    return pending;
  };
  const readConfig = (root: string, file: string) => config(root, file, budget, [], readText, configs);
  const readName = async (source: ImportSource): Promise<string> => {
    const values = await readConfig(path.dirname(source.configFile), source.configFile);
    const items: ImportItem[] = [];
    // Skill credential settings live in config; no manifest/resource read is
    // needed to recognize their values, including unselected skills/API keys.
    for (const [slug, raw] of Object.entries(object(object(values.skills).entries))) {
      const settings = object(raw);
      items.push({ view: { id: entryId('skill', slug), category: 'skills', name: slug, selected: false },
        env: scalarEnv(settings.env), ...(typeof settings.apiKey === 'string'
          ? { credential: { format: 'source-tools', value: { apiKey: settings.apiKey } } } : {}) });
    }
    await connections(items, source, values, deps, budget, readText);
    sourceConfiguration(items, source, values);
    return redactEnvironmentValues(source.name, previewImportRedactions(items));
  };
  return { readText: (root: string, file: string) => readText(root, file, budget), readConfig, readName };
}

/** Snapshot immutable bytes once, then give the client only a safe selection projection. */
export async function inspectImportSource(source: ImportSource, deps: SourceReaderDeps, budget = createImportBudget()): Promise<ImportSnapshot> {
  const values = await config(path.dirname(source.configFile), source.configFile, budget);
  const items: ImportItem[] = [];
  const workspace = source.workspace;
  let jobs: Record<string, unknown>[];
  if (source.kind === 'hermes') {
    await document(items, source.root, 'SOUL.md', 'identity', 'personality', budget);
    await document(items, source.root, 'USER.md', 'user', 'memory', budget);
    // Hermes-specific context files take precedence, rather than concatenating conflicting files.
    for (const filename of ['.hermes.md', 'HERMES.md']) {
      const before = items.length;
      await document(items, workspace, filename, 'instructions', 'personality', budget);
      if (items.length !== before) break;
    }
    await memoryDocuments(items, source.root, 'memories', budget);
    const raw = await optionalText(source.root, path.join(source.root, 'cron', 'jobs.json'), budget);
    let decoded: unknown;
    try { decoded = raw ? JSON.parse(raw) : []; } catch { throw new CompanionImportError('SOURCE_AUTOMATIONS_INVALID'); }
    jobs = (Array.isArray(decoded) ? decoded : Array.isArray(object(decoded).jobs) ? object(decoded).jobs as unknown[] : []).map(object);
  } else {
    await document(items, workspace, 'SOUL.md', 'identity', 'personality', budget);
    await document(items, workspace, 'IDENTITY.md', 'identity', 'personality', budget);
    for (const file of ['AGENTS.md', 'TOOLS.md']) await document(items, workspace, file, 'instructions', 'personality', budget);
    await document(items, workspace, 'USER.md', 'user', 'memory', budget);
    await document(items, workspace, 'MEMORY.md', undefined, 'memory', budget);
    await memoryDocuments(items, workspace, 'memory', budget);
    const rows = agentRows(values);
    const defaultAgent = (rows.find(row => row.default === true) ?? rows[0])?.id === source.agentId;
    const storeKey = sourcePath(deps.home, string(object(values.cron).store) || path.join(source.root, 'cron', 'jobs.json'), source.root);
    const database = path.join(source.root, 'state', 'openclaw.sqlite');
    try {
      await fs.access(database);
      // If the current DB is unreadable, do not fall back to a stale JSON backup.
      jobs = await deps.readCronDatabase({ database, storeKey, agentId: source.agentId, defaultAgent });
      budget.reserve(Buffer.byteLength(JSON.stringify(jobs)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const raw = await optionalText(path.dirname(storeKey), storeKey, budget);
      let data: Record<string, unknown>;
      try { data = object(raw ? JSON.parse(raw) : {}); } catch { throw new CompanionImportError('SOURCE_AUTOMATIONS_INVALID'); }
      jobs = (Array.isArray(data.jobs) ? data.jobs : []).map(object).filter(job => (job.agentId ?? (defaultAgent ? source.agentId : undefined)) === source.agentId);
    }
  }
  const usedSkills = new Set(jobs.flatMap(job => [string(job.skill), ...(Array.isArray(job.skills) ? job.skills.map(string) : [])]).filter(Boolean));
  const skillRoots = source.kind === 'hermes' ? [path.join(source.root, 'skills')] : [path.join(workspace, 'skills'), path.join(source.root, 'skills')];
  await skills(items, skillRoots, usedSkills, budget);
  for (const item of items.filter(item => item.view.category === 'skills')) {
    const slug = path.basename(item.sourceDirectory!);
    const settings = object(object(object(values.skills).entries)[slug]);
    if (settings.env) item.env = scalarEnv(settings.env);
    if (settings.enabled === false) item.view.selected = false;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(item.files?.find(file => file.name === 'SKILL.md')?.bytes.toString('utf8') ?? '');
    let metadata: Record<string, unknown> = {};
    try { if (front) metadata = object(object(yaml.load(front[1]!)).metadata); } catch { /* The original skill loader reports malformed frontmatter. */ }
    const primaryEnv = string(object(metadata.openclaw ?? metadata.clawdbot ?? metadata.hermes).primaryEnv);
    if (typeof settings.apiKey === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(primaryEnv)) item.env = { ...item.env, [primaryEnv]: settings.apiKey };
    else if (settings.apiKey) item.view.issues = ['MISSING_ENVIRONMENT_REFERENCE'];
  }
  await connections(items, source, values, deps, budget);
  if (source.kind === 'hermes' && (await directories(source.root)).includes('scripts')) {
    const usedScripts = jobs.flatMap(job => [string(job.script), string(job.monitor_script)]).filter(Boolean).flatMap(file => {
      try { return [importedScriptName(source.root, sourcePath(deps.home, file, path.join(source.root, 'scripts')))]; }
      catch { return []; }
    });
    for (const file of await readImportTree(path.join(source.root, 'scripts'), undefined, budget)) items.push({ view: { id: entryId('script', file.name), category: 'connections', name: `scripts/${file.name}`, selected: isImportedScriptDependency(`scripts/${file.name}`, usedScripts) }, asset: { name: `scripts/${file.name}`, bytes: file.bytes } });
  }
  const row = source.kind === 'openclaw' ? agentRows(values).find(row => row.id === source.agentId) ?? {} : values;
  sourceConfiguration(items, source, values);
  const heartbeat = source.kind === 'openclaw' ? object(row.heartbeat ?? object(object(values.agents).defaults).heartbeat) : object(values.heartbeat);
  if (Object.keys(heartbeat).length) {
    const heartbeatText = await optionalText(workspace, path.join(workspace, 'HEARTBEAT.md'), budget);
    items.push({ view: { id: entryId('automation', 'heartbeat'), name: 'Heartbeat', category: 'automations', selected: true, enabled: heartbeat.enabled !== false && heartbeat.every !== '0s', issues: ['AUTOMATION_TRIGGER_NEEDS_ADAPTER'] }, automation: { sourceId: 'heartbeat', original: { ...heartbeat, ...(heartbeatText ? { prompt: heartbeatText } : {}) }, fingerprint: fingerprint(heartbeat) } });
  }
  for (const job of jobs) items.push(normalizeAutomation(source, job, items, string(values.timezone) || deps.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone));
  if (items.length > 2000) throw new CompanionImportError('SOURCE_TOO_MANY_ITEMS');
  const identity = items.find(item => item.view.name === 'IDENTITY.md')?.text ?? '';
  const avatar = string(object(row.identity).avatar) || string(row.avatar) || /^\s*[-*]?\s*\*{0,2}Avatar\*{0,2}:\s*(.+)$/im.exec(identity)?.[1]?.trim() || '';
  let avatarImageBase64: string | undefined;
  if (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(avatar) && avatar.length < 2_000_000) avatarImageBase64 = avatar.split(',')[1];
  else if (avatar && !/^[a-z][a-z0-9+.-]*:/i.test(avatar)) {
    const file = sourcePath(deps.home, avatar, workspace);
    try {
      const bytes = (await readImportFile(path.dirname(file), file, budget)).bytes;
      if (bytes.length < 1_500_000 && (/\.(png|jpe?g|webp)$/i.test(file))) avatarImageBase64 = bytes.toString('base64');
    } catch (error) {
      if (error instanceof CompanionImportError && ['SOURCE_SNAPSHOT_TOO_LARGE', 'SOURCE_TOO_MANY_FILES'].includes(error.code)) throw error;
      // A stale source portrait falls back to the existing portrait picker.
    }
  }
  markImportEnvironmentChoices(items);
  const resolved = resolveImportEnvironmentDependencies(items, items.filter(item => item.view.selected));
  return { source, items: resolved, ...(avatarImageBase64 ? { avatarImageBase64 } : {}), fingerprint: snapshotFingerprint(resolved) };
}
