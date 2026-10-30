import { markImportEnvironmentChoices, previewImportRedactions, resolveImportEnvironmentDependencies } from './environmentSelection.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { redactEnvironmentValues } from './process.js';
import yaml from 'js-yaml';
import { parse as parseEnv } from 'dotenv';
import { createImportBudget, fingerprint, optionalText, readImportFile, readImportTree, snapshotFingerprintAsync, type ImportReadBudget } from './files.js';
import { discoverImportSkills } from './skills.js';
import { indexAutomationDependencies, normalizeAutomation } from './sourceAutomations.js';
import { memoryFileContent } from './memoryFiles.js';
import { CompanionImportError, object, string, type ImportItem, type ImportSnapshot, type ImportSource } from './types.js';
import type { CompanionImportBotPlatform } from '@cindy/maker-shared/companion-import';

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
        workspace: sourcePath(deps.home, deps.env.OPENCLAW_WORKSPACE_DIR || string(row.workspace) || string(defaults.workspace) || path.join(clawRoot, id === 'main' ? 'workspace' : `workspace-${id}`), clawRoot) });
    }
  }
  return results;
}

function entryId(prefix: string, name: string): string { return `${prefix}-${fingerprint(name).slice(0, 20)}`; }

async function document(items: ImportItem[], root: string, name: string, role: ImportItem['role'], category: 'personality' | 'memory', budget: ImportReadBudget) {
  try {
    const text = await optionalText(root, path.join(root, name), budget);
    if (text === undefined) return;
    if (!text.trim()) {
      items.push({ view: { id: entryId(category, name), category, name, selected: true }, asset: { name, bytes: Buffer.from(text) } });
      return;
    }
    items.push({ view: { id: entryId(category, name), category, name, selected: true }, text, role });
  } catch (error) {
    items.push({ view: { id: entryId(category, name), category, name, selected: true }, role,
      sourceFile: { root, file: path.join(root, name) }, captureIssue: error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED' });
  }
}

async function memoryDocuments(items: ImportItem[], root: string, prefix: string, budget: ImportReadBudget, sharedDocumentRoots: string[]) {
  if (!(await directories(root)).includes(prefix)) return;
  const directory = path.join(root, prefix);
  const failed = (name: string, error: unknown, kind: 'file' | 'directory' | 'unknown') => items.push({ view: { id: entryId('memory', `${prefix}/${name}`), category: 'memory', name: name || prefix, selected: true },
    sourceFile: { root: directory, file: path.join(directory, name), kind, logicalPrefix: prefix, sharedDocumentRoots }, captureIssue: error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED' });
  let files;
  try { files = await readImportTree(directory, undefined, budget, failed, directory, sharedDocumentRoots); }
  catch (error) { failed('', error, 'directory'); return; }
  for (const file of files) {
    const content = memoryFileContent(file);
    if (content.kind !== 'text') {
      items.push({ view: { id: entryId('memory', `${prefix}/${file.name}`), category: 'memory', name: `${prefix}/${file.name}`, selected: true }, asset: { name: `${prefix}/${file.name}`, bytes: file.bytes } });
      continue;
    }
    items.push({ view: { id: entryId('memory', `${prefix}/${file.name}`), category: 'memory', name: file.name, description: prefix, selected: true },
      text: content.text, role: /(^|\/)USER\.md$/i.test(file.name) ? 'user' : undefined });
  }
}

function scalarEnv(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] =>
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry[0]) && !['__proto__', 'prototype', 'constructor'].includes(entry[0]) && typeof entry[1] === 'string'));
}

async function sourceEnvironment(source: ImportSource, values: Record<string, unknown>, budget: ImportReadBudget, readText = optionalText): Promise<Record<string, string>> {
  const dotenv = parseEnv(await readText(source.root, path.join(source.root, '.env'), budget) ?? '');
  const envConfig = object(values.env);
  return { ...dotenv, ...scalarEnv(envConfig), ...scalarEnv(envConfig.vars) };
}

/** `bots`: messaging bots become their own category for controllers that can show it; otherwise legacy connections. */
async function connections(items: ImportItem[], source: ImportSource, values: Record<string, unknown>, deps: SourceReaderDeps, budget: ImportReadBudget, readText = optionalText, bots = false) {
  const env = await sourceEnvironment(source, values, budget, readText);
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
    items.push({ view: { id: entryId('mcp', name), category: 'connections', name, selected: true, enabled, dependsOn: [...references].map(key => entryId('env', key)) },
      envDependencies: { names: [...references], entries: [] },
      mcp: { name, enabled, ...(command ? { command, args: Array.isArray(record.args) ? record.args.map(string) : [], cwd, transport: 'stdio' as const } : { url, transport: record.transport === 'sse' ? 'sse' as const : 'http' as const }),
        env: scalarEnv(record.env), headers: scalarEnvHeaders(record.headers) } });
  }
  if (bots) pushBotItems(items, await sourceBots(source, values, env, deps, budget, readText), env);
  else await legacyImBots(items, source, values, env, deps, budget, readText);
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

/** Telegram / Discord as `connections` for controllers without the bots category; no source stop. */
async function legacyImBots(items: ImportItem[], source: ImportSource, values: Record<string, unknown>, env: Record<string, string>, deps: SourceReaderDeps, budget: ImportReadBudget, readText = optionalText) {
  const channels = object(values.channels);
  const ownerAllowFrom = listOf(object(values.commands).ownerAllowFrom);
  const telegram = object(channels.telegram);
  const accounts = Object.keys(object(telegram.accounts)).length ? object(telegram.accounts) : { default: telegram };
  for (const [account, raw] of Object.entries(accounts)) {
    const settings = object(raw);
    let token = string(settings.botToken) || (source.kind === 'hermes' && env.TELEGRAM_BOT_TOKEN ? '${TELEGRAM_BOT_TOKEN}' : '');
    const references = [...token.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!);
    if (!token && typeof settings.tokenFile === 'string') {
      const file = sourcePath(deps.home, settings.tokenFile, source.root);
      token = (await readText(path.dirname(file), file, budget))?.trim() ?? '';
    }
    // Owner: Hermes TELEGRAM_ALLOWED_USERS; OpenClaw commands.ownerAllowFrom (telegram:<id>), then the
    // account's effective allowFrom (an omitted account list inherits channels.telegram.allowFrom).
    const ownerUserId = source.kind === 'hermes'
      ? singleUserId(listOf(env.TELEGRAM_ALLOWED_USERS), [], TELEGRAM_USER_ID)
      : singleUserId(ownerAllowFrom.filter(entry => /^telegram:/i.test(String(entry))), ['telegram:'], TELEGRAM_USER_ID)
        ?? singleUserId(listOf(settings.allowFrom ?? telegram.allowFrom), ['telegram:', 'tg:'], TELEGRAM_USER_ID);
    if (token) items.push({ view: { id: entryId('telegram', account), name: `Telegram · ${account}`, category: 'connections', selected: true, dependsOn: references.map(key => entryId('env', key)) }, envDependencies: { names: references, entries: [] }, credential: { format: 'telegram', value: { token, account, ...(ownerUserId ? { ownerUserId } : {}) } } });
  }
  // Discord: OpenClaw channels.discord[.accounts.*].token (plain string or env SecretRef; DISCORD_BOT_TOKEN
  // is the default-account fallback once a channels.discord block exists); Hermes DISCORD_BOT_TOKEN.
  const discord = object(channels.discord);
  const discordAccounts = Object.keys(object(discord.accounts)).length ? object(discord.accounts) : { default: discord };
  for (const [account, raw] of Object.entries(discordAccounts)) {
    const settings = object(raw);
    let token = secretReference(settings.token);
    if (!token && account === 'default' && env.DISCORD_BOT_TOKEN
      && (source.kind === 'hermes' || Object.hasOwn(channels, 'discord'))) token = '${DISCORD_BOT_TOKEN}';
    if (!token) continue;
    const references = [...token.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!);
    // Owner: Hermes DISCORD_ALLOWED_USERS; OpenClaw commands.ownerAllowFrom (discord:<id>), then the
    // first set of allowFrom / legacy dm.allowFrom on the account, then on channels.discord.
    const inherited = [settings.allowFrom, object(settings.dm).allowFrom, discord.allowFrom, object(discord.dm).allowFrom].find(value => value !== undefined);
    const ownerUserId = source.kind === 'hermes'
      ? singleUserId(listOf(env.DISCORD_ALLOWED_USERS), [], DISCORD_USER_ID)
      : singleUserId(ownerAllowFrom.filter(entry => /^discord:/i.test(String(entry))), ['discord:'], DISCORD_USER_ID)
        ?? singleUserId(listOf(inherited), ['discord:', 'user:'], DISCORD_USER_ID);
    items.push({ view: { id: entryId('discord', account), name: `Discord · ${account}`, category: 'connections', selected: true, dependsOn: references.map(key => entryId('env', key)) }, envDependencies: { names: references, entries: [] }, credential: { format: 'discord', value: { token, account, ...(ownerUserId ? { ownerUserId } : {}) } } });
  }
}

const TELEGRAM_USER_ID = /^\d{4,20}$/;
const DISCORD_USER_ID = /^\d{17,20}$/;

/** Allowlists are arrays in OpenClaw config and comma-separated strings in Hermes env. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',');
  return [];
}

/** Only a single explicit user ID is an owner. Wildcards, access groups and multi-user lists are not guessed. */
function singleUserId(entries: unknown[], prefixes: string[], pattern: RegExp): string | undefined {
  const ids = new Set<string>();
  for (const entry of entries) {
    let value = typeof entry === 'number' && Number.isSafeInteger(entry) ? String(entry) : typeof entry === 'string' ? entry.trim() : '';
    const prefix = prefixes.find(candidate => value.toLowerCase().startsWith(candidate));
    if (prefix) value = value.slice(prefix.length);
    if (pattern.test(value)) ids.add(value);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** A plain token, or an OpenClaw env SecretRef kept as a source reference until selection. */
function secretReference(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const ref = object(value);
  return ref.source === 'env' && typeof ref.id === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.id) ? `\${${ref.id}}` : '';
}

function scalarEnvHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BOT_OWNER_ALTERNATIVES = 5;
const PLAIN_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_@.:-]{0,127}$/;

interface SourceBot {
  platform: CompanionImportBotPlatform;
  account: string;
  name: string;
  /** Platform credential fields; values may still be `${VAR}` source references. */
  credential: Record<string, string>;
  service?: 'feishu' | 'lark';
  enabled: boolean;
  enabledPath: string[];
  owner?: string;
  /** Allowed users when no single owner is evident. */
  ownerCandidates?: string[];
  /** Other agents also route through this bot: stopping it affects them, so it is not preselected. */
  shared?: boolean;
}

/** Distinct IDs only; wildcards, access groups and malformed entries are never owners. */
function userIds(entries: unknown[], prefixes: string[], pattern: RegExp): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    let value = typeof entry === 'number' && Number.isSafeInteger(entry) ? String(entry) : typeof entry === 'string' ? entry.trim() : '';
    const prefix = prefixes.find(candidate => value.toLowerCase().startsWith(candidate));
    if (prefix) value = value.slice(prefix.length);
    if (pattern.test(value)) ids.add(value);
  }
  return [...ids];
}

/** Single allowed user; else the allowed user that is the home chat; else the only allowed admin. */
function inferOwner(allowed: string[], home = '', admins: string[] = []): Pick<SourceBot, 'owner' | 'ownerCandidates'> {
  if (allowed.length === 1) return { owner: allowed[0] };
  if (home && allowed.includes(home)) return { owner: home };
  const allowedAdmins = admins.filter(id => allowed.includes(id));
  if (allowedAdmins.length === 1) return { owner: allowedAdmins[0] };
  return { ownerCandidates: allowed };
}

function sourceDisabled(value: unknown): boolean {
  return value === false || typeof value === 'string' && /^(?:false|no|off|0)$/i.test(value.trim());
}

function sourceBotName(source: ImportSource, account: string, ...names: unknown[]): string {
  const name = names.map(value => string(value).trim()).find(Boolean);
  if (name) return name;
  if (account !== 'default') return account;
  return source.kind === 'hermes' && source.agentId === 'default' && source.name === 'default' ? 'Hermes' : source.name;
}

function hermesBots(source: ImportSource, values: Record<string, unknown>, env: Record<string, string>): SourceBot[] {
  const platforms = object(values.platforms);
  // Env wins over platforms.<name>.extra, as in Hermes' own env bridge.
  const value = (variable: string, fallback: unknown) => env[variable] ? `\${${variable}}` : secretReference(fallback);
  const bots: SourceBot[] = [];
  for (const platform of ['telegram', 'discord', 'feishu', 'wecom', 'dingtalk'] as const) {
    const block = object(platforms[platform]);
    const extra = object(block.extra);
    const enabled = !sourceDisabled(block.enabled);
    const enabledPath = ['platforms', platform, 'enabled'];
    const allowed = (pattern: RegExp) => userIds(listOf(env[`${platform.toUpperCase()}_ALLOWED_USERS`]), [], pattern);
    if (platform === 'telegram' || platform === 'discord') {
      const token = value(`${platform.toUpperCase()}_BOT_TOKEN`, block.token);
      if (!token) continue;
      const users = allowed(platform === 'telegram' ? TELEGRAM_USER_ID : DISCORD_USER_ID);
      const home = platform === 'telegram' ? string(env.TELEGRAM_HOME_CHANNEL) || string(values.TELEGRAM_HOME_CHANNEL)
        || string(object(block.home_channel).chat_id) || string(block.home_channel) : '';
      const admins = platform === 'telegram' ? userIds([...listOf(extra.group_allow_admin_from), ...listOf(extra.admins)], [], TELEGRAM_USER_ID) : [];
      bots.push({ platform, account: 'default', name: sourceBotName(source, 'default', block.name, extra.bot_name), credential: { token },
        enabled, enabledPath, ...(platform === 'telegram' ? inferOwner(users, home.trim(), admins) : inferOwner(users)) });
      continue;
    }
    const fields: Record<string, string> = platform === 'feishu' ? { appId: value('FEISHU_APP_ID', extra.app_id), appSecret: value('FEISHU_APP_SECRET', extra.app_secret) }
      : platform === 'wecom' ? { wecomBotId: value('WECOM_BOT_ID', extra.bot_id), secret: value('WECOM_SECRET', extra.secret) }
        : { appKey: value('DINGTALK_CLIENT_ID', extra.client_id), appSecret: value('DINGTALK_CLIENT_SECRET', extra.client_secret) };
    if (Object.values(fields).some(field => !field)) continue;
    const domain = string(env.FEISHU_DOMAIN) || string(extra.domain);
    // Feishu: open_id admins; WeCom / DingTalk: explicit allowed users.
    const owners = platform === 'feishu' ? userIds(listOf(extra.admins), [], /^ou_[A-Za-z0-9_-]{1,128}$/) : allowed(PLAIN_USER_ID);
    bots.push({ platform, account: 'default', name: sourceBotName(source, 'default', platform === 'feishu' ? env.FEISHU_BOT_NAME : '', extra.bot_name, block.name),
      credential: fields, ...(platform === 'feishu' ? { service: /lark/i.test(domain) ? 'lark' as const : 'feishu' as const } : {}),
      enabled, enabledPath, ...inferOwner(owners) });
  }
  return bots;
}

/** OpenClaw route bindings: the agent a bot account delivers to, and whether other agents share it. */
function openclawRoute(values: Record<string, unknown>, platform: string, account: string, defaultAccount: string, groups: unknown): { agent: string; shared: boolean } {
  const rows = agentRows(values);
  const fallback = string((rows.find(row => row.default === true) ?? rows[0])?.id) || 'main';
  const bindings = (Array.isArray(values.bindings) ? values.bindings : []).map(object)
    .filter(binding => (binding.type ?? 'route') === 'route' && string(object(binding.match).channel).toLowerCase() === platform)
    .filter(binding => {
      const id = object(binding.match).accountId;
      // An omitted accountId matches only the default account; "*" matches every account.
      return id === '*' || (id === undefined ? account === defaultAccount : String(id) === account);
    });
  const wide = bindings.filter(binding => Object.keys(object(binding.match)).every(key => key === 'channel' || key === 'accountId'));
  const exact = wide.find(binding => object(binding.match).accountId !== '*') ?? wide.find(binding => object(binding.match).accountId === '*');
  const agent = string(exact?.agentId) || fallback;
  const routed = Object.values(object(groups)).flatMap(group => [object(group).agentId, ...Object.values(object(object(group).topics)).map(topic => object(topic).agentId)]);
  return { agent, shared: bindings.some(binding => string(binding.agentId) !== agent) || routed.some(id => typeof id === 'string' && id !== agent) };
}

async function openclawBots(source: ImportSource, values: Record<string, unknown>, env: Record<string, string>, deps: SourceReaderDeps, budget: ImportReadBudget, readText = optionalText, allAgents = false): Promise<SourceBot[]> {
  const channels = object(values.channels);
  const ownerAllowFrom = listOf(object(values.commands).ownerAllowFrom);
  const bots: SourceBot[] = [];
  for (const platform of ['telegram', 'discord', 'feishu'] as const) {
    if (!Object.hasOwn(channels, platform)) continue;
    const channel = object(channels[platform]);
    const configured = object(channel.accounts);
    const multi = Object.keys(configured).length > 0;
    const defaultAccount = string(channel.defaultAccount) || 'default';
    const { accounts: _accounts, defaultAccount: _default, ...base } = channel;
    for (const account of multi ? Object.keys(configured) : ['default']) {
      // Same inheritance as OpenClaw: authored account fields override channel defaults.
      const own = multi ? object(configured[account]) : {};
      const merged = { ...base, ...own };
      const route = openclawRoute(values, platform, account, defaultAccount, merged.groups);
      if (!allAgents && route.agent !== source.agentId) continue;
      const enabled = !sourceDisabled(channel.enabled) && !sourceDisabled(merged.enabled);
      const enabledPath = multi ? ['channels', platform, 'accounts', account, 'enabled'] : ['channels', platform, 'enabled'];
      const name = sourceBotName(source, account, merged.name);
      const prefixed = (prefix: string, pattern: RegExp) => userIds(ownerAllowFrom.filter(entry => String(entry).toLowerCase().startsWith(`${prefix}:`)), [`${prefix}:`], pattern);
      if (platform === 'feishu') {
        const appId = secretReference(merged.appId), appSecret = secretReference(merged.appSecret);
        if (!appId || !appSecret) continue;
        const domain = string(merged.domain);
        const pattern = /^ou_[A-Za-z0-9_-]{1,128}$/;
        const owners = prefixed('feishu', pattern);
        const allowed = owners.length ? owners : userIds(listOf(merged.allowFrom), ['feishu:', 'lark:'], pattern);
        bots.push({ platform, account, name, credential: { appId, appSecret }, service: domain === 'lark' || /larksuite/i.test(domain) ? 'lark' : 'feishu',
          enabled, enabledPath, shared: route.shared, ...inferOwner(allowed) });
        continue;
      }
      let token = platform === 'telegram' ? '' : secretReference(merged.token);
      // Telegram: account tokenFile / botToken, then the channel's (OpenClaw's own resolution order).
      if (platform === 'telegram') for (const [tokenFile, value] of [[own.tokenFile, own.botToken], [channel.tokenFile, channel.botToken]]) {
        if (typeof tokenFile === 'string' && tokenFile.trim()) {
          const file = sourcePath(deps.home, tokenFile, source.root);
          token = (await readText(path.dirname(file), file, budget))?.trim() ?? '';
        }
        token ||= secretReference(value);
        if (token) break;
      }
      const variable = `${platform.toUpperCase()}_BOT_TOKEN`;
      if (!token && account === 'default' && env[variable]) token = `\${${variable}}`;
      if (!token) continue;
      const pattern = platform === 'telegram' ? TELEGRAM_USER_ID : DISCORD_USER_ID;
      const owners = prefixed(platform, pattern);
      const allowFrom = platform === 'telegram' ? merged.allowFrom
        : [own.allowFrom, object(own.dm).allowFrom, channel.allowFrom, object(channel.dm).allowFrom].find(entry => entry !== undefined);
      const allowed = owners.length ? owners : userIds(listOf(allowFrom), platform === 'telegram' ? ['telegram:', 'tg:'] : ['discord:', 'user:'], pattern);
      bots.push({ platform, account, name, credential: { token }, enabled, enabledPath, shared: route.shared, ...inferOwner(allowed) });
    }
  }
  return bots;
}

/** WeCom / DingTalk on OpenClaw are external plugins with no published config shape; they are not guessed. */
async function sourceBots(source: ImportSource, values: Record<string, unknown>, env: Record<string, string>, deps: SourceReaderDeps, budget: ImportReadBudget, readText = optionalText, allAgents = false): Promise<SourceBot[]> {
  return source.kind === 'hermes' ? hermesBots(source, values, env) : openclawBots(source, values, env, deps, budget, readText, allAgents);
}

/**
 * One entry per bot; an ambiguous owner offers up to five exclusive alternatives, none preselected.
 * Every platform needs a known owner: the companion would otherwise adopt whoever messages it first.
 * A bot carries its own credential: references the source environment defines are resolved here,
 * so importing the bot never also requires selecting its token under connections.
 */
function pushBotItems(items: ImportItem[], bots: SourceBot[], env: Record<string, string> = {}) {
  for (const original of bots) {
    const credential = Object.fromEntries(Object.entries(original.credential).map(([field, value]) =>
      [field, value.replace(REFERENCE, (match, name: string) => Object.hasOwn(env, name) ? env[name]! : match)]));
    const bot = { ...original, credential };
    const references = [...new Set(Object.values(bot.credential).flatMap(value => [...value.matchAll(REFERENCE)].map(match => match[1]!)))];
    const selected = bot.enabled && !bot.shared;
    const item = (id: string, owner: string | undefined, view: Partial<ImportItem['view']> = {}): ImportItem => ({
      view: { id, category: 'bots', platform: bot.platform, name: bot.name, selected, ...(bot.enabled ? {} : { enabled: false }),
        dependsOn: references.map(key => entryId('env', key)), ...(owner ? { owner } : {}), ...view },
      envDependencies: { names: references, entries: [] },
      credential: { format: bot.platform, value: { ...bot.credential, account: bot.account, ...(bot.service ? { service: bot.service } : {}), ...(owner ? { ownerUserId: owner } : {}) } },
      bot: { platform: bot.platform, account: bot.account, enabledPath: bot.enabledPath },
    });
    const id = entryId(bot.platform, bot.account);
    const candidates = bot.owner ? [] : bot.ownerCandidates ?? [];
    if (bot.owner) items.push(item(id, bot.owner));
    else if (candidates.length > 1 && candidates.length <= BOT_OWNER_ALTERNATIVES) {
      const ids = candidates.map(owner => entryId(bot.platform, `${bot.account}\0owner:${owner}`));
      candidates.forEach((owner, index) => items.push(item(ids[index]!, owner, { selected: false, exclusiveWith: ids.filter((_id, other) => other !== index) })));
    } else items.push(item(id, undefined, { issues: ['IMPORT_IM_BOT_OWNER_MISSING'] }));
  }
}

const BOT_IDENTITY_FIELDS = ['token', 'appId', 'wecomBotId', 'appKey'] as const;

/** The platform identity (token / app ID / bot ID) of one bot credential. */
export function importBotIdentity(credential: unknown): string {
  const value = object(credential);
  return BOT_IDENTITY_FIELDS.map(field => string(value[field])).find(Boolean) ?? '';
}

/** The bot's current identity in its source, re-read with the source's own environment; '' when it is gone or routed elsewhere. */
export async function readImportSourceBotIdentity(source: ImportSource, bot: NonNullable<ImportItem['bot']>, deps: SourceReaderDeps): Promise<string> {
  const budget = createImportBudget();
  const values = await config(path.dirname(source.configFile), source.configFile, budget);
  const env = await sourceEnvironment(source, values, budget);
  const found = (await sourceBots(source, values, env, deps, budget))
    .find(candidate => candidate.platform === bot.platform && candidate.account === bot.account);
  if (!found) return '';
  return importBotIdentity(Object.fromEntries(Object.entries(found.credential).map(([field, value]) =>
    [field, value.replace(REFERENCE, (match, name: string) => Object.hasOwn(env, name) ? env[name]! : match)])));
}

/** Current source switch for one imported bot, re-read from its native config. */
export async function readImportSourceBot(source: ImportSource, bot: NonNullable<ImportItem['bot']>): Promise<{ enabled: boolean; present: boolean; value?: unknown }> {
  const values = await config(path.dirname(source.configFile), source.configFile, createImportBudget());
  let parent: Record<string, unknown> = values;
  for (const key of bot.enabledPath.slice(0, -1)) parent = object(parent[key]);
  const key = bot.enabledPath.at(-1)!;
  const present = Object.hasOwn(parent, key);
  const channelOff = source.kind === 'openclaw' && sourceDisabled(object(object(values.channels)[bot.platform]).enabled);
  return { enabled: !channelOff && !(present && sourceDisabled(parent[key])), present, ...(present ? { value: parent[key] } : {}) };
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
  const readRedactions = async (source: ImportSource): Promise<Record<string, string>> => {
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
    // Mask every bot credential, including bots routed to other agents and platforms the legacy path skips.
    const env = await sourceEnvironment(source, values, budget, readText);
    pushBotItems(items, await sourceBots(source, values, env, deps, budget, readText, true), env);
    sourceConfiguration(items, source, values);
    return previewImportRedactions(items);
  };
  return { readText: (root: string, file: string) => readText(root, file, budget), readConfig, readRedactions, readName: async (source: ImportSource) => redactEnvironmentValues(source.name, await readRedactions(source)) };
}

/** Snapshot immutable bytes once, then give the client only a safe selection projection. */
export async function inspectImportSource(source: ImportSource, deps: SourceReaderDeps, budget = createImportBudget(), options: { bots?: boolean } = {}): Promise<ImportSnapshot> {
  const values = await config(path.dirname(source.configFile), source.configFile, budget);
  const items: ImportItem[] = [];
  const workspace = source.workspace;
  // A memory-tree symlink cannot grant access to arbitrary account files. Only
  // the source's explicitly configured document vault supplies external roots;
  // do not infer trust from filenames, all PATH-like env values or Cindy's env.
  const envConfig = object(values.env);
  const sourceEnv = { ...parseEnv(await optionalText(source.root, path.join(source.root, '.env'), budget) ?? ''), ...scalarEnv(envConfig), ...scalarEnv(envConfig.vars) };
  const sharedDocumentRoots: string[] = [];
  if (sourceEnv.OBSIDIAN_VAULT_PATH) {
    try {
      const vault = await fs.realpath(sourcePath(deps.home, sourceEnv.OBSIDIAN_VAULT_PATH, source.root));
      if ((await fs.stat(vault)).isDirectory()) sharedDocumentRoots.push(vault);
    } catch { /* An unavailable vault does not grant a fallback to another root. */ }
  }
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
    await memoryDocuments(items, source.root, 'memories', budget, sharedDocumentRoots);
    // Some installations keep their own archive alongside Hermes' built-in memories.
    // Keep distinct paths/IDs; this does not redefine the upstream layout.
    await memoryDocuments(items, source.root, 'memory', budget, sharedDocumentRoots);
    await document(items, source.root, 'MEMORY.md', undefined, 'memory', budget);
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
    await memoryDocuments(items, workspace, 'memory', budget, sharedDocumentRoots);
    for (const file of ['DREAMS.md', 'HEARTBEAT.md']) await document(items, workspace, file, undefined, 'memory', budget);
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
  items.push(...await discoverImportSkills(source, values, deps.home, deps.env, budget, new Set(jobs.flatMap(job => [string(job.skill), ...(Array.isArray(job.skills) ? job.skills.map(string) : [])]).filter(Boolean))));
  // Credential alternatives must not deselect the skill that owns them.
  for (const item of [...items]) if (item.view.category === 'skills' && item.env && Object.keys(item.env).length) {
    const id = entryId('skill-env', item.view.id);
    items.push({ view: { id, category: 'connections', name: item.view.name, selected: true }, env: item.env });
    item.envDependencies = { names: Object.keys(item.env), entries: [] };
    delete item.env;
  }
  await connections(items, source, values, deps, budget, optionalText, options.bots === true);
  if (source.kind === 'hermes' && (await directories(source.root)).includes('scripts')) {
    for (const file of await readImportTree(path.join(source.root, 'scripts'), undefined, budget)) items.push({ view: { id: entryId('script', file.name), category: 'connections', name: `scripts/${file.name}`, selected: true }, asset: { name: `scripts/${file.name}`, bytes: file.bytes, executable: file.executable } });
  }
  const row = source.kind === 'openclaw' ? agentRows(values).find(row => row.id === source.agentId) ?? {} : values;
  sourceConfiguration(items, source, values);
  const automationDependencies = indexAutomationDependencies(items);
  const timezone = string(values.timezone) || deps.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const [index, job] of jobs.entries()) {
    items.push(normalizeAutomation(source, job, automationDependencies, timezone, index));
  }
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
  return { source, items: resolved, ...(avatarImageBase64 ? { avatarImageBase64 } : {}), fingerprint: await snapshotFingerprintAsync(resolved) };
}
