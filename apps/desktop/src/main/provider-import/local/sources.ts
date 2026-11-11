/**
 * Saved API settings only: no CLI execution, OAuth adoption, source writes or network.
 * Format references: yetone/magpie internal/provider/importapps.go, import_codex.go,
 * import_opencode.go at 0024660445ab8ac64a381cda3ce8f63c6932bc6f (MIT).
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { localImportClaudeConfigDirectory } from './sourceEnvironment.js';
import { resolveBetterSqliteNativeBinding } from '../../localDb/betterSqliteFactory.js';
import { stripJsonComments } from '../../../shared/theme-import/vscode.js';
import { parse as parseToml } from 'smol-toml';
import {
  pickModelMetadata,
  type AgentKind,
  type ProviderWireProtocol,
  type ProviderRuntimeModelConfig,
} from '@cindy/model-providers';
import type {
  LocalProviderIssue,
  LocalProviderSource,
} from '../../../shared/localProviderImport.js';

export const LOCAL_SOURCE_LIMIT = 50;
const FILE_LIMIT = 4 * 1024 * 1024;
type ObjectMap = Record<string, unknown>;
export const obj = (v: unknown): ObjectMap =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectMap) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const first = (...v: unknown[]): string => v.map(str).find((v) => v.length > 0) ?? '';
export interface LocalEndpoint {
  agent: AgentKind;
  protocol?: ProviderWireProtocol;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ProviderRuntimeModelConfig[];
  requestPath?: string;
  modelsUrl?: string;
}
export interface LocalSourceEntry {
  ref: string;
  name: string;
  endpoints: LocalEndpoint[];
  issue?: LocalProviderIssue;
  disabled?: boolean;
}
export interface LocalSourceResult {
  source: LocalProviderSource;
  entries: LocalSourceEntry[];
  issue?: LocalProviderIssue;
}
export interface LocalSourceContext {
  home: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}
export const localSourceContext = (): LocalSourceContext => ({
  home: homedir(),
  platform: process.platform,
  env: Object.fromEntries(
    ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA'].map(
      (key) => [
        key,
        key === 'CLAUDE_CONFIG_DIR' ? localImportClaudeConfigDirectory() : process.env[key],
      ],
    ),
  ),
});
export const SOURCE_IDS: LocalProviderSource[] = [
  'alma',
  'cc-switch',
  'claude-code',
  'codex',
  'opencode',
];

/** Bound reads through the opened handle; source errors never escape to renderer/logs. */
async function textFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new SourceError('limit');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let n = 0;
    while (n < buffer.length) {
      const r = await handle.read(buffer, n, buffer.length - n, null);
      if (!r.bytesRead) break;
      n += r.bytesRead;
    }
    if (n > FILE_LIMIT) throw new SourceError('limit');
    const bytes = buffer.subarray(0, n),
      text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new SourceError('invalid');
    return text.replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
}
/** Carries only a public issue code, never a path or raw parser message. */
class SourceError extends Error {
  constructor(readonly issue: LocalProviderIssue) {
    super(issue);
  }
}
/** Reuse the existing string-aware JSONC reader; no evaluation or substitution. */
export function staticJson(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function models(value: unknown): LocalEndpoint['models'] {
  if (typeof value === 'string') {
    try {
      return models(JSON.parse(value));
    } catch {
      return value ? [{ id: value, name: value }] : [];
    }
  }
  const pairs = Array.isArray(value)
    ? value.map((v) => [str(v) || str(obj(v).id), obj(v)] as const)
    : Object.entries(obj(value));
  if (pairs.length > 10_000) throw new SourceError('limit');
  return [
    ...new Map(
      pairs
        .filter(([id]) => id)
        .map(([id, row]) => {
          const m = obj(row),
            limit = obj(m.limit);
          const context = m.contextWindow ?? limit.context;
          return [
            id,
            {
              ...pickModelMetadata(m),
              id,
              name: str(m.name) || id,
              ...(typeof context === 'number' ? { contextWindow: context } : {}),
              ...(typeof m.defaultEnabled === 'boolean'
                ? { defaultEnabled: m.defaultEnabled }
                : {}),
              ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
              ...(Array.isArray(m.reasoningEfforts)
                ? {
                    reasoningEfforts:
                      m.reasoningEfforts as ProviderRuntimeModelConfig['reasoningEfforts'],
                  }
                : {}),
              ...(typeof m.supportsImageInput === 'boolean'
                ? { supportsImageInput: m.supportsImageInput }
                : {}),
            },
          ];
        }),
    ).values(),
  ];
}
function headers(value: unknown): Record<string, string> | undefined {
  if (typeof value === 'string' && value) value = staticJson(value);
  if (value === undefined || value === '' || value === null) return undefined;
  const map = obj(value);
  if (
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.values(map).some((v) => typeof v !== 'string')
  )
    throw new SourceError('unsupported');
  return Object.keys(map).length
    ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, str(v)]))
    : undefined;
}
function protocol(value: unknown): ProviderWireProtocol | undefined {
  const v = str(value);
  if (['anthropic', 'anthropic-messages', '@ai-sdk/anthropic'].includes(v))
    return 'anthropic-messages';
  if (['responses', 'openai-responses', '@ai-sdk/openai'].includes(v)) return 'openai-responses';
  if (
    ['chat', 'openai', 'openai-chat', 'openai-completions', '@ai-sdk/openai-compatible'].includes(v)
  )
    return 'openai-chat';
  if (['gemini', 'google-generative-ai', '@ai-sdk/google'].includes(v))
    return 'google-generative-ai';
  return undefined;
}
function endpoint(
  agent: AgentKind,
  baseUrl: string,
  wire?: ProviderWireProtocol,
  key?: string,
  ms?: unknown,
  hs?: unknown,
): LocalEndpoint {
  return {
    agent,
    baseUrl,
    protocol: wire,
    ...(key ? { apiKey: key } : {}),
    ...(hs ? { headers: headers(hs) } : {}),
    models: models(ms),
  };
}
// Claude CLI modes are not API model IDs. Only resolve aliases using mappings
// saved in this file; account/provider defaults require runtime discovery.
// https://code.claude.com/docs/en/model-config
function claudeStaticModels(value: unknown, env: ObjectMap): string[] {
  const id = str(value).trim();
  const alias = id.replace(/\[1m\]$/, '');
  if (!id || ['default', 'inherit'].includes(alias)) return [];
  if (alias === 'opusplan') {
    return ['opus', 'sonnet'].flatMap((family) => claudeStaticModels(family, env));
  }
  const family = alias === 'best' ? 'opus' : alias;
  if (['opus', 'sonnet', 'haiku', 'fable'].includes(family)) {
    const mapped = str(env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]).trim();
    // An unresolved/self-referential alias is not a statically known wire ID.
    return mapped &&
      !['default', 'inherit', 'opusplan', 'best', 'opus', 'sonnet', 'haiku', 'fable'].includes(
        mapped.replace(/\[1m\]$/, ''),
      )
      ? [mapped.replace(/\[1m\]$/, '')]
      : [];
  }
  return [id.replace(/\[1m\]$/, '')];
}
function claude(ref: string, name: string, config: ObjectMap): LocalSourceEntry {
  const env = obj(config.env);
  const base =
    first(env.ANTHROPIC_BASE_URL) ||
    (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? 'https://api.anthropic.com' : '');
  const token = str(env.ANTHROPIC_AUTH_TOKEN),
    key = str(env.ANTHROPIC_API_KEY);
  const ms = [
    first(env.ANTHROPIC_MODEL, config.model),
    ...[
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
    ].map((k) => env[k]),
  ].flatMap((value) => claudeStaticModels(value, env));
  const hs = token ? { Authorization: `Bearer ${token}` } : undefined;
  const ep = endpoint('claude-code', base, 'anthropic-messages', token ? undefined : key, ms, hs);
  if (env.ANTHROPIC_CUSTOM_HEADERS) {
    const extra: Record<string, string> = {};
    for (const row of str(env.ANTHROPIC_CUSTOM_HEADERS).split('\n').filter(Boolean)) {
      const i = row.indexOf(':');
      if (i < 1) throw new SourceError('unsupported');
      const k = row.slice(0, i).trim();
      if (Object.keys(extra).some((e) => e.toLowerCase() === k.toLowerCase()))
        throw new SourceError('unsupported');
      extra[k] = row.slice(i + 1).trim();
    }
    ep.headers = { ...extra, ...hs };
  }
  return { ref, name, endpoints: [ep] };
}
function codex(config: ObjectMap, key = ''): LocalSourceEntry[] {
  const profiles = Object.values(obj(config.profiles)).map(obj);
  const entries = Object.entries(obj(config.model_providers)).map(([id, raw]) => {
    const p = obj(raw);
    // auth.json belongs to OpenAI auth, not to arbitrary selected providers.
    // Never substitute it for an unresolved env key or command-backed token.
    const openAiKey =
      config.model_provider === id &&
      p.requires_openai_auth === true &&
      p.env_key === undefined &&
      p.auth === undefined
        ? key
        : '';
    const ms = [
      config.model_provider === id ? config.model : undefined,
      ...profiles
        .filter((v) => (v.model_provider ?? config.model_provider) === id)
        .map((v) => v.model),
    ].filter(Boolean);
    const ep = endpoint(
      'codex',
      str(p.base_url),
      p.wire_api === undefined ? 'openai-responses' : protocol(p.wire_api),
      first(p.auth === undefined ? p.experimental_bearer_token : undefined, openAiKey),
      ms,
      p.http_headers,
    );
    return {
      ref: id,
      name: str(p.name) || id,
      endpoints: [ep],
      ...(p.env_http_headers ? { issue: 'unsupported' as const } : {}),
    };
  });
  if (
    key &&
    (!config.model_provider || config.model_provider === 'openai') &&
    !entries.some((entry) => entry.ref === 'openai')
  )
    entries.push({
      ref: 'openai',
      name: 'OpenAI',
      endpoints: [
        endpoint(
          'codex',
          'https://api.openai.com/v1',
          'openai-responses',
          key,
          config.model ? [config.model] : [],
        ),
      ],
    });
  return entries;
}
function generic(ref: string, name: string, app: string, raw: ObjectMap): LocalSourceEntry[] {
  if (app === 'claude' || app === 'claude-desktop') return [claude(ref, name, raw)];
  if (app === 'codex')
    return codex(obj(parseToml(str(raw.config))), str(obj(raw.auth).OPENAI_API_KEY)).map((e) => ({
      ...e,
      ref: `${ref}/${e.ref}`,
      name,
    }));
  const opts = obj(raw.options);
  if (app === 'gemini') {
    const env = obj(raw.env);
    // Gemini CLI stores an SDK root, whereas Cindy's explicit wire route includes
    // the API version. Keep a relay prefix and any explicit supported version.
    const root = (
      str(env.GOOGLE_GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com'
    ).replace(/\/+$/, '');
    const base = /\/v1(?:beta)?$/.test(root) ? root : `${root}/v1beta`;
    return [
      {
        ref,
        name,
        endpoints: [
          endpoint(
            'pi',
            base,
            'google-generative-ai',
            first(env.GEMINI_API_KEY, env.GOOGLE_API_KEY),
            env.GEMINI_MODEL ? [env.GEMINI_MODEL] : [],
          ),
        ],
      },
    ];
  }
  const wire = protocol(first(raw.api, raw.npm, raw.type));
  const agent: AgentKind =
    app === 'pi' ? 'pi' : wire === 'anthropic-messages' ? 'claude-code' : 'codex';
  const ep = endpoint(
    agent,
    first(raw.baseUrl, raw.baseURL, raw.base_url, opts.baseURL, opts.baseUrl, opts.base_url),
    wire,
    first(raw.apiKey, raw.api_key, opts.apiKey),
    raw.models,
    raw.headers ?? opts.headers,
  );
  const requestPath = first(raw.requestPath, opts.requestPath),
    modelsUrl = first(raw.modelsUrl, opts.modelsUrl);
  if (requestPath) ep.requestPath = requestPath;
  if (modelsUrl) ep.modelsUrl = modelsUrl;
  return [
    {
      ref,
      name,
      endpoints: [ep],
      ...(agent === 'pi' && requestPath ? { issue: 'unsupported' as const } : {}),
    },
  ];
}
async function json(path: string): Promise<ObjectMap> {
  const value = staticJson(await textFile(path));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('invalid');
  return value as ObjectMap;
}
function configRoot(c: LocalSourceContext): string {
  return c.platform === 'darwin'
    ? join(c.home, 'Library', 'Application Support')
    : c.platform === 'win32'
      ? c.env.APPDATA || join(c.home, 'AppData', 'Roaming')
      : c.env.XDG_CONFIG_HOME || join(c.home, '.config');
}
/** One bounded SELECT is a SQLite snapshot and includes WAL; never immutable mode. */
async function database(path: string, query: string): Promise<ObjectMap[]> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new SourceError('invalid');
  } finally {
    await handle.close();
  }
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 100,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
  try {
    db.pragma('query_only = ON');
    const rows: ObjectMap[] = [];
    let bytes = 0;
    for (const raw of db.prepare(query).iterate()) {
      const row = raw as ObjectMap;
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (rows.length >= LOCAL_SOURCE_LIMIT || bytes > FILE_LIMIT) throw new SourceError('limit');
      rows.push(row);
    }
    return rows;
  } finally {
    db.close();
  }
}
const OFFICIAL: Record<string, [string, ProviderWireProtocol]> = {
  anthropic: ['https://api.anthropic.com', 'anthropic-messages'],
  openai: ['https://api.openai.com/v1', 'openai-responses'],
  google: ['https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai'],
  deepseek: ['https://api.deepseek.com/v1', 'openai-chat'],
  openrouter: ['https://openrouter.ai/api/v1', 'openai-chat'],
  xai: ['https://api.x.ai/v1', 'openai-chat'],
};
async function read(
  source: LocalProviderSource,
  c: LocalSourceContext,
): Promise<LocalSourceEntry[]> {
  const cap = LOCAL_SOURCE_LIMIT + 1;
  if (source === 'claude-code') {
    const cfg = await json(
      join(c.env.CLAUDE_CONFIG_DIR || join(c.home, '.claude'), 'settings.json'),
    );
    if (
      !Object.keys(obj(cfg.env)).some((k) =>
        ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(k),
      )
    ) {
      if (cfg.apiKeyHelper) throw new SourceError('unsupported');
      return [];
    }
    const entry = claude('settings', 'Claude Code', cfg);
    if (
      cfg.apiKeyHelper &&
      !entry.endpoints.some(
        (ep) =>
          ep.apiKey ||
          Object.entries(ep.headers ?? {}).some(
            ([key, value]) =>
              /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(key) && !!value,
          ),
      )
    ) {
      throw new SourceError('unsupported');
    }
    return [entry];
  }
  if (source === 'codex') {
    const dir = c.env.CODEX_HOME || join(c.home, '.codex');
    const config = obj(parseToml(await textFile(join(dir, 'config.toml'))));
    let key = '';
    try {
      key = str((await json(join(dir, 'auth.json'))).OPENAI_API_KEY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = codex(config, key);
    const profiles = [config, ...Object.values(obj(config.profiles)).map(obj)];
    for (const profile of profiles) {
      if (!profile.model_catalog_json) continue;
      const id = profile.model_provider ?? config.model_provider;
      const target = entries.find((e) => e.ref === id);
      if (!target) continue;
      const path = str(profile.model_catalog_json);
      const full = path.startsWith('~/')
        ? join(c.home, path.slice(2))
        : isAbsolute(path)
          ? path
          : resolve(dir, path);
      const catalog = await json(full);
      const list = catalog.models;
      if (!Array.isArray(list)) throw new SourceError('invalid');
      const ms = models(list.map((v) => ({ ...obj(v), id: str(obj(v).slug) || str(obj(v).id) })));
      target.endpoints[0].models = [
        ...new Map([...target.endpoints[0].models, ...ms].map((m) => [m.id, m])).values(),
      ];
    }
    return entries;
  }
  if (source === 'opencode') {
    let auth: ObjectMap = {};
    try {
      auth = await json(
        join(c.env.XDG_DATA_HOME || join(c.home, '.local', 'share'), 'opencode', 'auth.json'),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    let cfg: ObjectMap = {};
    const dir = join(c.env.XDG_CONFIG_HOME || join(c.home, '.config'), 'opencode');
    try {
      cfg = await json(join(dir, 'opencode.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        cfg = await json(join(dir, 'opencode.jsonc'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const ps = obj(cfg.provider);
    return [...new Set([...Object.keys(auth), ...Object.keys(ps)])]
      .filter(
        (id) =>
          obj(auth[id]).type === 'api' ||
          (!auth[id] && typeof obj(obj(ps[id]).options).apiKey === 'string'),
      )
      .map((id) => {
        const p = obj(ps[id]),
          opts = obj(p.options),
          known = OFFICIAL[id];
        const base = first(opts.baseURL, opts.baseUrl) || known?.[0] || '';
        const wire = protocol(p.npm) ?? (p.npm ? undefined : known?.[1]);
        const key = first(opts.apiKey, obj(auth[id]).key);
        const dynamic = /\{(?:env|file):/.test(key);
        return {
          ref: id,
          name: str(p.name) || id,
          endpoints: [
            endpoint(
              wire === 'anthropic-messages' ? 'claude-code' : 'pi',
              base,
              wire,
              dynamic ? '' : key,
              p.models,
              opts.headers,
            ),
          ],
        };
      });
  }
  if (source === 'cc-switch') {
    const dir = join(c.home, '.cc-switch');
    let rows: ObjectMap[];
    try {
      rows = await database(
        join(dir, 'cc-switch.db'),
        `SELECT id, app_type, name, substr(settings_config,1,4194305) AS settings_config FROM providers LIMIT ${cap}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const cfg = await json(join(dir, 'config.json'));
      rows = Object.entries(cfg).flatMap(([app, sec]) =>
        Object.entries(obj(obj(sec).providers)).map(([id, value]) => ({
          id,
          app_type: app,
          name: obj(value).name,
          settings_config: JSON.stringify(obj(value).settingsConfig),
        })),
      );
    }
    return rows.flatMap((row) => {
      try {
        return generic(
          `${str(row.app_type)}/${str(row.id)}`,
          str(row.name) || str(row.id),
          str(row.app_type),
          obj(staticJson(str(row.settings_config))),
        );
      } catch {
        return [
          {
            ref: `${str(row.app_type)}/${str(row.id)}`,
            name: str(row.name) || 'CC Switch',
            endpoints: [],
            issue: 'invalid' as const,
          },
        ];
      }
    });
  }
  const rows = await database(
    join(configRoot(c), 'alma', 'chat_threads.db'),
    `SELECT id,name,type,api_key,substr(models,1,4194305) AS models,base_url,enabled,api_format,is_response_api,substr(custom_headers,1,4194305) AS custom_headers FROM providers LIMIT ${cap}`,
  );
  return rows.map((row) => {
    const type = str(row.type),
      known = OFFICIAL[type];
    const format = str(row.api_format);
    // Alma's Responses toggle refines its OpenAI format; it does not change
    // the Anthropic/Gemini families into Responses.
    const wire =
      format === 'anthropic' || type === 'anthropic'
        ? 'anthropic-messages'
        : format === 'gemini' || type === 'google'
          ? 'google-generative-ai'
          : row.is_response_api || format === 'openai-responses'
            ? 'openai-responses'
            : format
              ? protocol(format)
              : type === 'openai'
                ? 'openai-chat'
                : (known?.[1] ??
                  (['custom', 'openai-compatible'].includes(type) ? 'openai-chat' : undefined));
    const result: LocalSourceEntry = {
      ref: str(row.id),
      name: str(row.name) || type,
      endpoints: [],
      disabled: row.enabled === 0,
    };
    if (
      [
        'acp',
        'copilot',
        'claude-subscription',
        'codex-subscription',
        'gemini-cli',
        'antigravity',
        'cursor',
        'azure',
      ].includes(type)
    )
      return { ...result, issue: 'unsupported' };
    try {
      result.endpoints = [
        endpoint(
          wire === 'anthropic-messages' ? 'claude-code' : 'pi',
          str(row.base_url) || known?.[0] || '',
          wire,
          str(row.api_key),
          row.models ? staticJson(str(row.models)) : [],
          row.custom_headers,
        ),
      ];
    } catch {
      result.issue = 'invalid';
    }
    return result;
  });
}
export async function readLocalProviderSource(
  source: LocalProviderSource,
  context: LocalSourceContext,
): Promise<LocalSourceResult> {
  try {
    const entries = await read(source, context);
    if (entries.length > LOCAL_SOURCE_LIMIT || JSON.stringify(entries).length > FILE_LIMIT)
      throw new SourceError('limit');
    const refs = entries.map((e) => e.ref);
    if (new Set(refs).size !== refs.length || refs.some((ref) => !ref || ref.length > 1024))
      throw new SourceError('invalid');
    return { source, entries };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      source,
      entries: [],
      issue:
        error instanceof SourceError
          ? error.issue
          : code === 'ENOENT'
            ? 'missing'
            : code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_BUSY'
              ? 'readFailed'
              : 'invalid',
    };
  }
}
