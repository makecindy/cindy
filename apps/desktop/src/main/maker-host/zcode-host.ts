/** Local ZCode discovery and account projection; no native configuration writes. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ModelDescriptor, ZCodeAgentOptions, ZCodeModelSelection,
  ZCodeRpcClient, ZCodeRpcClientOptions, ZCodeSessionHooks,
} from '@cindy/maker-core';
import {
  createZCodeNativeAuth, ZCodeNativeError,
  type ZCodeNativeErrorCode, type ZCodeTeamBinding,
} from './zcode-native-auth.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';

export interface ZCodeNativeStatus {
  installed: boolean;
  authenticated: boolean;
  models: ModelDescriptor[];
  errorReason?: ZCodeNativeErrorCode;
}

type Client = Pick<ZCodeRpcClient, 'request' | 'setRequestHandler' | 'close'>;

export interface ZCodeSessionScopeFiles {
  read(file: string): Promise<string | null>;
  /** Atomically create, never replace; false means another receipt already exists. */
  create(file: string, contents: string): Promise<boolean>;
}

export interface ZCodeNativeHostOptions {
  /** Owner-scoped Cindy storage root, not ZCode's existing data directory. */
  runtimeDataDir: string;
  createClient: (options: ZCodeRpcClientOptions) => Client;
  nodePath?: string;
  cliPath?: string;
  builtinConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Dependency-injected boundaries; tests must never read the actual HOME. */
  homeDir?: string;
  platform?: NodeJS.Platform;
  credentialSecret?: string;
  readText?: (file: string) => Promise<string>;
  fileExists?: (file: string, executable: boolean) => Promise<boolean>;
  prepareDirectory?: (directory: string) => Promise<void>;
  request?: (url: string, init: RequestInit) => Promise<unknown>;
  now?: () => number;
  sessionScopeFiles?: ZCodeSessionScopeFiles;
}

interface Installation {
  binaryPath: string;
  args: string[];
  env: Record<string, string | undefined>;
  builtinConfigPath: string;
}

interface BuiltinConfig {
  revision: string;
  accountProviderIds: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function error(code: ZCodeNativeErrorCode): never { throw new ZCodeNativeError(code); }

/** Secrets remain in closures. This status is the only renderer-facing projection. */
export function createZCodeNativeHost(options: ZCodeNativeHostOptions) {
  const env = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path;
  const homeDir = options.homeDir ?? env.ZCODE_DESKTOP_HOME_DIR?.trim() ?? env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? os.homedir();
  const nativeDataDir = env.ZCODE_DATA_BASE_DIR?.trim() || homeDir;
  const nativeConfigDir = paths.join(nativeDataDir, '.zcode', 'v2');
  const readText = options.readText ?? ((file: string) => readFile(file, 'utf8'));
  const fileExists = options.fileExists ?? (async (file: string, executable: boolean) => {
    try { await access(file, executable && platform !== 'win32' ? constants.X_OK : constants.R_OK); return true; }
    catch { return false; }
  });
  const prepareDirectory = options.prepareDirectory ?? (async (directory: string) => { await mkdir(directory, { recursive: true, mode: 0o700 }); });
  const scopeRoot = paths.join(options.runtimeDataDir, 'session-scopes');
  const scopeFiles: ZCodeSessionScopeFiles = options.sessionScopeFiles ?? {
    async read(file) {
      try {
        const root = await realpath(options.runtimeDataDir);
        const bytes = await readBoundedFileNoFollow(file, 1024, { containWithin: root });
        if (!bytes) return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
        return bytes.toString('utf8');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
      }
    },
    async create(file, contents) {
      await mkdir(scopeRoot, { recursive: true, mode: 0o700 });
      const [root, directory, stat] = await Promise.all([
        realpath(options.runtimeDataDir), realpath(scopeRoot), lstat(scopeRoot),
      ]);
      const relative = paths.relative(root, directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !relative || relative.startsWith(`..${paths.sep}`) || relative === '..' || paths.isAbsolute(relative)) {
        return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
      }
      // Link publishes a complete, fsynced private file without overwriting a
      // receipt written concurrently by another Cindy process.
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        try { await link(temporary, file); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw cause;
        }
        return true;
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
  let username = 'unknown';
  try { username = os.userInfo().username; } catch { /* Same native fallback when OS user lookup is unavailable. */ }
  const auth = createZCodeNativeAuth({
    settingsPath: paths.join(homeDir, '.zcode', 'v2', 'setting.json'),
    credentialsPath: paths.join(nativeConfigDir, 'credentials.json'),
    credentialSecret: options.credentialSecret ?? env.ZCODE_CREDENTIAL_SECRET ?? `zcode-credential-fallback:${platform}:${os.homedir()}:${username}`,
    readText, request: options.request, now: options.now,
  });
  let status: ZCodeNativeStatus = { installed: false, authenticated: false, models: [] };
  let installation: Installation | undefined;
  let selections = new Map<string, ZCodeModelSelection>();
  let refreshPending: Promise<ZCodeNativeStatus> | undefined;
  let disposed = false;
  const discoveryClients = new Set<Client>();

  function scopePath(nativeId: string): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(nativeId)) return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
    return paths.join(scopeRoot, `${createHash('sha256').update(nativeId).digest('hex')}.json`);
  }

  async function readSessionIdentity(nativeId: string): Promise<string | null> {
    try {
      const raw = await scopeFiles.read(scopePath(nativeId));
      if (raw === null) return null;
      if (raw.length > 1024) return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
      const receipt = record(JSON.parse(raw));
      if (receipt.version !== 1 || typeof receipt.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.identityHash)) {
        return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
      }
      return receipt.identityHash;
    } catch { return error('ZCODE_SESSION_SCOPE_UNAVAILABLE'); }
  }

  async function assertSessionIdentity(nativeId: string, binding: ZCodeTeamBinding): Promise<void> {
    const previous = await readSessionIdentity(nativeId);
    if (previous === null) return error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
    if (previous !== binding.identityHash) return error('ZCODE_AUTH_SCOPE_CHANGED');
  }

  function assertSupportedEnvironment(): void {
    // Never send credentials from a native test/private environment to production.
    if (env.ZCODE_ENV && env.ZCODE_ENV !== 'production') error('ZCODE_ENV_UNSUPPORTED');
    const endpoints = {
      BIGMODEL_API_BASE_URL: 'https://bigmodel.cn',
      BIGMODEL_PRODUCTION_API_BASE_URL: 'https://bigmodel.cn',
      ZAI_BUSINESS_BASE_URL: 'https://api.z.ai',
      ZAI_PRODUCTION_BUSINESS_BASE_URL: 'https://api.z.ai',
    };
    for (const [key, expected] of Object.entries(endpoints)) {
      if (env[key] && env[key]!.replace(/\/$/, '') !== expected) error('ZCODE_ENV_UNSUPPORTED');
    }
  }

  async function firstFile(candidates: Array<string | undefined>, executable = false): Promise<string | undefined> {
    for (const candidate of candidates) if (candidate && paths.isAbsolute(candidate) && await fileExists(candidate, executable)) return candidate;
    return undefined;
  }

  async function discover(): Promise<Installation> {
    const explicitCli = options.cliPath ?? env.CINDY_ZCODE_CLI_PATH;
    const cliCandidates = explicitCli ? [explicitCli] : platform === 'darwin' ? [
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      paths.join(homeDir, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
    ] : platform === 'win32' ? [
      env.LOCALAPPDATA ? paths.join(env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
      env.ProgramFiles ? paths.join(env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs') : undefined,
    ] : [
      '/opt/ZCode/resources/glm/zcode.cjs',
      '/usr/lib/zcode/resources/glm/zcode.cjs',
    ];
    const cliPath = await firstFile(cliCandidates);
    if (!cliPath) return error('ZCODE_NOT_INSTALLED');
    const explicitNode = options.nodePath ?? env.CINDY_ZCODE_NODE_PATH;
    const searchPath = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    const nodePath = await firstFile(explicitNode ? [explicitNode] : [
      ...searchPath.map((directory) => paths.join(directory, platform === 'win32' ? 'node.exe' : 'node')),
      ...(platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : []),
    ], true);
    if (!nodePath) return error('ZCODE_NODE_MISSING');
    const explicitBuiltin = options.builtinConfigPath ?? env.CINDY_ZCODE_BUILTIN_CONFIG_PATH;
    const builtinConfigPath = await firstFile(explicitBuiltin ? [explicitBuiltin] : [
      paths.resolve(paths.dirname(cliPath), '../config/provider/zcode-builtin.json'),
      paths.join(paths.dirname(cliPath), 'provider', 'zcode-builtin.json'),
    ]);
    if (!builtinConfigPath) return error('ZCODE_CONFIG_UNAVAILABLE');
    return {
      binaryPath: nodePath,
      args: [cliPath, 'app-server', '--stdio'],
      env: {
        ZCODE_DATA_BASE_DIR: options.runtimeDataDir,
        // The native config factory does not derive these from DATA_BASE_DIR.
        // Explicit env overrides also outrank project/user storage settings.
        ZCODE_STORAGE_DIR: paths.join(options.runtimeDataDir, '.zcode'),
        ZCODE_SESSION_DB_PATH: paths.join(options.runtimeDataDir, '.zcode', 'cli', 'db', 'db.sqlite'),
        ZCODE_SESSION_DB: undefined,
        ZCODE_LOG_DIR: paths.join(options.runtimeDataDir, 'logs'),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfigPath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.join(nativeConfigDir, 'provider_config.json'),
        // Host credentials are supplied only for the selected Team request. Do
        // not let unrelated inherited API keys select a different native route.
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: undefined,
        ZAI_API_KEY: undefined,
        BIGMODEL_API_KEY: undefined,
      },
      builtinConfigPath,
    };
  }

  async function readBuiltin(current: Installation): Promise<BuiltinConfig> {
    try {
      const release = record(JSON.parse(await readText(current.builtinConfigPath)));
      const config = record(release.config);
      const rules = record(config.providerConfigRules).providerRules;
      if (release.schemaVersion !== 1 || !Number.isSafeInteger(release.revision) || Number(release.revision) < 0 || !Array.isArray(rules)) error('ZCODE_CONFIG_UNAVAILABLE');
      const accountProviderIds = rules.flatMap((raw) => {
        const rule = record(raw);
        return record(record(rule.config).access).type === 'zhipu-account' && text(rule.providerId) ? [text(rule.providerId)] : [];
      });
      // This is the upstream NodeZCodeBuiltinProviderConfigSource revision. It
      // binds the account overlay to the exact file handed to this child.
      const sourceKey = createHash('sha256').update(paths.resolve(current.builtinConfigPath)).digest('hex');
      return { revision: `zcode-builtin:${release.revision}:${sourceKey}`, accountProviderIds };
    } catch { return error('ZCODE_CONFIG_UNAVAILABLE'); }
  }

  async function prepare(client: Client, binding: ZCodeTeamBinding): Promise<void> {
    if (!installation || disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
    await auth.check(binding);
    const builtin = await readBuiltin(installation);
    if (!builtin.accountProviderIds.includes(binding.providerId)) error('ZCODE_MODEL_UNAVAILABLE');
    const providers: Record<string, unknown> = {};
    const states: Record<string, unknown> = {};
    for (const id of builtin.accountProviderIds) {
      const selected = id === binding.providerId;
      providers[id] = { access: { type: 'zhipu-account', entitled: selected } };
      states[id] = { availability: selected ? 'available' : 'unavailable', entitled: selected, current: selected };
    }
    await auth.assertCurrent(binding);
    await client.request('provider/updateAccountConfig', {
      revision: `cindy-team:${binding.scope}:${builtin.revision}`,
      basedOnZCodeBuiltinRevision: builtin.revision, providers, states,
    });
    await auth.assertCurrent(binding);
    if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
  }

  function resolveModelSelection(model: string): ZCodeModelSelection {
    const selection = selections.get(model);
    if (!selection) return error('ZCODE_MODEL_UNAVAILABLE');
    return { ...selection, ...(selection.options ? { options: { ...selection.options } } : {}) };
  }

  function getAgentOptions(): ZCodeAgentOptions {
    if (!installation || disposed) return error('ZCODE_NOT_INSTALLED');
    return {
      args: [...installation.args], env: { ...installation.env }, resolveModelSelection,
      async createSessionHooks(opts): Promise<ZCodeSessionHooks> {
        const binding = await auth.capture();
        if (resolveModelSelection(opts.model).providerId !== binding.providerId) error('ZCODE_AUTH_SCOPE_CHANGED');
        if (opts.resumeSessionId) await assertSessionIdentity(opts.resumeSessionId, binding);
        await auth.assertCurrent(binding);
        return {
          prepareClient: (client) => prepare(client, binding),
          resolveProviderRuntimeHeaders: (params, signal) => auth.resolve(binding, params, signal),
          async onSessionReady(nativeId) {
            await auth.assertCurrent(binding);
            if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
            if (opts.resumeSessionId) {
              if (nativeId !== opts.resumeSessionId) error('ZCODE_SESSION_SCOPE_UNAVAILABLE');
              await assertSessionIdentity(nativeId, binding);
            } else {
              try {
                await scopeFiles.create(scopePath(nativeId), JSON.stringify({ version: 1, identityHash: binding.identityHash }));
              } catch { error('ZCODE_SESSION_SCOPE_UNAVAILABLE'); }
              // Existing receipts are never overwritten, including native-ID
              // collisions across process lifetimes.
              await assertSessionIdentity(nativeId, binding);
            }
            await auth.assertCurrent(binding);
            if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
          },
        };
      },
    };
  }

  async function refreshNow(): Promise<ZCodeNativeStatus> {
    let client: Client | undefined;
    let sessionId: string | undefined;
    try {
      if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
      assertSupportedEnvironment();
      installation = await discover();
      const binding = await auth.capture();
      await auth.check(binding);
      const discoveryDir = paths.join(options.runtimeDataDir, 'discovery');
      await prepareDirectory(discoveryDir);
      client = options.createClient({
        binaryPath: installation.binaryPath, args: installation.args,
        env: { ...env, ...installation.env }, cwd: discoveryDir, requestTimeoutMs: 30_000,
      });
      discoveryClients.add(client);
      client.setRequestHandler(async (method) => {
        if (method === 'session/requestRuntimePreferences') return {
          nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
        };
        // Discovery never sends a prompt, loads history, or approves tools.
        return error('ZCODE_PROTOCOL_UNAVAILABLE');
      });
      await prepare(client, binding);
      const snapshot = record(await client.request('session/create', {
        workspace: { workspacePath: discoveryDir, workspaceKey: discoveryDir },
        mode: 'build', persistence: 'deferred', titleGenerationEnabled: false, toolAllowlist: [],
      }));
      sessionId = text(record(snapshot.session).sessionId) || undefined;
      if (!sessionId) error('ZCODE_PROTOCOL_UNAVAILABLE');
      const rawModels = record(record(snapshot.settings).model).available;
      if (!Array.isArray(rawModels)) error('ZCODE_PROTOCOL_UNAVAILABLE');
      const nextSelections = new Map<string, ZCodeModelSelection>();
      const models: ModelDescriptor[] = [];
      for (const raw of rawModels) {
        const native = record(raw);
        const ref = record(native.ref);
        if (ref.providerId !== binding.providerId || !text(ref.modelId) || native.disabledReason) continue;
        const modelId = text(ref.modelId);
        // An encoded pair is stable across refreshes and prevents identically
        // named models from selecting a different native account family.
        const id = `zcode:${encodeURIComponent(binding.providerId)}/${encodeURIComponent(modelId)}`;
        if (nextSelections.has(id)) continue;
        const reasoningLevel = text(record(ref.options).reasoningLevel) || text(record(native.reasoning).defaultLevel);
        nextSelections.set(id, { providerId: binding.providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) });
        models.push({
          id, displayName: text(native.label) || modelId,
          contextWindow: positive(native.contextWindow) ?? 0,
          efforts: [], defaultEffort: null,
          ...(positive(native.maxOutputTokens) ? { maxOutputTokens: positive(native.maxOutputTokens) } : {}),
          // The initial Cindy adapter supports text input only, regardless of
          // what the underlying model advertises.
          supportsImageInput: false,
        });
      }
      if (!models.length) error('ZCODE_MODEL_UNAVAILABLE');
      await auth.assertCurrent(binding);
      if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
      selections = nextSelections;
      status = { installed: true, authenticated: true, models };
    } catch (cause) {
      selections = new Map();
      const errorReason = cause instanceof ZCodeNativeError ? cause.code : 'ZCODE_PROTOCOL_UNAVAILABLE';
      status = { installed: Boolean(installation), authenticated: false, models: [], errorReason };
    } finally {
      if (client) {
        if (sessionId) {
          await client.request('session/close', { sessionId, expectedPersistence: 'deferred' }, { timeoutMs: 5_000 }).catch(() => undefined);
        }
        try {
          await client.close();
          discoveryClients.delete(client);
        } catch {
          // Keep the handle for dispose() to retry. A failed cleanup cannot be
          // reported as a fully ready native runtime.
          selections.clear();
          status = { installed: true, authenticated: false, models: [], errorReason: 'ZCODE_PROTOCOL_UNAVAILABLE' };
        }
      }
    }
    return getStatus();
  }

  function refresh(): Promise<ZCodeNativeStatus> {
    if (!refreshPending) {
      const run = refreshNow().finally(() => { if (refreshPending === run) refreshPending = undefined; });
      refreshPending = run;
    }
    return refreshPending;
  }

  /** Before explicit owner binding, inspect executable paths only. */
  async function probe(): Promise<ZCodeNativeStatus> {
    let result: ZCodeNativeStatus;
    try {
      if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
      installation = await discover();
      if (disposed) error('ZCODE_PROTOCOL_UNAVAILABLE');
      result = { installed: true, authenticated: false, models: [] };
    } catch (cause) {
      result = {
        installed: false, authenticated: false, models: [],
        errorReason: cause instanceof ZCodeNativeError ? cause.code : 'ZCODE_NOT_INSTALLED',
      };
    }
    // A read-only availability probe must not erase an established runtime map.
    if (!status.authenticated) status = result;
    return { ...result, models: [] };
  }

  function getStatus(): ZCodeNativeStatus {
    return { ...status, models: status.models.map((model) => ({ ...model, efforts: [...model.efforts] })) };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    auth.clear();
    const clients = [...discoveryClients];
    const results = await Promise.allSettled(clients.map((client) => client.close()));
    results.forEach((result, index) => { if (result.status === 'fulfilled') discoveryClients.delete(clients[index]!); });
    selections.clear();
    status = { installed: Boolean(installation), authenticated: false, models: [] };
    if (results.some((result) => result.status === 'rejected')) error('ZCODE_PROTOCOL_UNAVAILABLE');
  }

  return { probe, refresh, getStatus, getAgentOptions, dispose, get binaryPath() { return installation?.binaryPath; } };
}

export type ZCodeNativeHost = ReturnType<typeof createZCodeNativeHost>;
