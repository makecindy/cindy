import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertSafeExecutionProfile, CINDY_UPSTREAM_COMMIT, compatibilityReport } from './compatibility.js';

const execFileAsync = promisify(execFile);

export interface HeadlessProfile {
  id: string;
  version: 1;
  parentProfile?: string;
  changedDimensions?: string[];
  agentBackend: 'claude-code' | 'codex' | 'pi';
  agentBinaryPath: string;
  agentBinaryVersion: string;
  supportedModelIds: string[];
  model: {
    provider: string;
    requestedId: string;
    routeId?: string;
    contextLimit?: number;
    thinkingBudget?: number | string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    maxOutputTokens?: number;
  };
  endpoint?: string;
  permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default' | 'ask' | 'auto' | 'plan';
  systemPromptFile?: string;
  expectedSystemPromptDigest?: string;
  makerMemory: boolean;
  nativeMemory: boolean;
  projectContext: boolean;
  containerSandbox?: boolean;
  unsafeAllowUnsandboxedBypass?: boolean;
  compaction?: { enabled: boolean; thresholdPct?: number };
  throughputCap?: { outputTokensPerSecond: number; enforcement: 'external-proxy' };
  inputPolicy?: { attachments: boolean; workspaceOnly: true; maxFiles?: number; maxFileBytes?: number };
  mcpServers?: Array<{
    id: string;
    transport: 'http';
    url: string;
    bearerTokenEnvVar?: string;
    headerEnvVars?: Record<string, string>;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
  }>;
  nativeProviders?: Array<{
    id: string;
    name: string;
    baseUrl: string;
    api: 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
    apiKeyEnvVar?: string;
    models: Array<{
      id: string;
      wireId?: string;
      name?: string;
      reasoning?: boolean;
      contextWindow: number;
      maxTokens: number;
      input?: Array<'text' | 'image'>;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }>;
  }>;
  piProjectSkills?: { enabled: boolean; roots: string[] };
}

export interface ResolvedProfile {
  profile: HeadlessProfile;
  profilePath: string;
  systemPrompt?: string;
  profileDigest: string;
  systemPromptDigest: string | null;
}

export interface ProfileCapabilities {
  schemaVersion: 1;
  contractVersion: number;
  profileId: string;
  agentBackend: 'claude-code' | 'codex' | 'pi';
  supportedModelIds: string[];
  supportedPermissionModes: string[];
  projectContext: boolean;
  makerMemory: boolean;
  nativeMemory: boolean;
  nativeToolSurface: 'claude-code-default' | 'codex-app-server-default' | 'pi-rpc-default';
  cindyMcpProviders: string[];
  desktopOnlyProviders: string[];
  multiTurnSession: true;
  artifactContract: string[];
  attachments: boolean;
  customMcpServers: string[];
  byomProviders: string[];
  piProjectSkills: boolean;
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
}

export function validateProfile(profile: unknown): HeadlessProfile {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be an object');
  const value = profile as Partial<HeadlessProfile>;
  nonEmptyString(value.id, 'profile.id');
  nonEmptyString(value.agentBinaryPath, 'agentBinaryPath');
  nonEmptyString(value.agentBinaryVersion, 'agentBinaryVersion');
  if (value.version !== 1) throw new Error('profile.version must be 1');
  if (!['claude-code', 'codex', 'pi'].includes(value.agentBackend ?? '')) throw new Error('agentBackend must be claude-code, codex or pi');
  if (!Array.isArray(value.supportedModelIds) || value.supportedModelIds.length === 0) throw new Error('supportedModelIds must be non-empty');
  if (value.supportedModelIds.some((id) => typeof id !== 'string' || id.trim() === '' || id === '*' || id === 'latest')) throw new Error('supportedModelIds must contain exact non-empty model IDs');
  if (new Set(value.supportedModelIds).size !== value.supportedModelIds.length) throw new Error('supportedModelIds must not contain duplicates');
  if (!value.model || typeof value.model !== 'object') throw new Error('model is required');
  nonEmptyString(value.model.provider, 'model.provider');
  nonEmptyString(value.model.requestedId, 'model.requestedId');
  if (!value.supportedModelIds.includes(value.model.requestedId)) throw new Error(`model ${value.model.requestedId} is not supported by this profile`);
  if (value.model.effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.model.effort)) throw new Error('model.effort must be minimal, low, medium, high, xhigh, max or ultra');
  if (value.model.maxOutputTokens !== undefined && (!Number.isInteger(value.model.maxOutputTokens) || value.model.maxOutputTokens <= 0)) throw new Error('model.maxOutputTokens must be a positive integer');
  if (value.agentBackend === 'codex' && value.model.maxOutputTokens !== undefined) throw new Error('model.maxOutputTokens is not supported by the codex backend');
  if (value.agentBackend === 'pi' && (!Number.isInteger(value.model.contextLimit) || (value.model.contextLimit ?? 0) <= 0)) throw new Error('pi profiles require a positive model.contextLimit');
  if (value.agentBackend === 'pi' && value.model.effort === 'ultra') throw new Error('ultra effort is not supported by the pi backend');
  if (!['bypassPermissions', 'acceptEdits', 'default', 'ask', 'auto', 'plan'].includes(value.permissionMode ?? '')) throw new Error('unsupported permissionMode');
  if (value.agentBackend === 'claude-code' && value.permissionMode === 'auto') throw new Error('auto permissionMode is only supported by codex and pi');
  if (value.agentBackend === 'codex' && (value.permissionMode === 'acceptEdits' || value.permissionMode === 'default')) throw new Error(`${value.permissionMode} permissionMode is not supported by codex`);
  if (value.agentBackend === 'pi' && value.permissionMode !== 'bypassPermissions') throw new Error('headless pi requires bypassPermissions because no interactive approval channel is available');
  if (typeof value.makerMemory !== 'boolean' || typeof value.nativeMemory !== 'boolean' || typeof value.projectContext !== 'boolean') throw new Error('makerMemory, nativeMemory and projectContext must be boolean');
  if (value.agentBackend !== 'pi' && value.makerMemory && value.nativeMemory) throw new Error('makerMemory and nativeMemory are mutually exclusive for claude-code and codex');
  if (value.containerSandbox !== undefined && typeof value.containerSandbox !== 'boolean') throw new Error('containerSandbox must be boolean');
  if (value.unsafeAllowUnsandboxedBypass !== undefined && typeof value.unsafeAllowUnsandboxedBypass !== 'boolean') throw new Error('unsafeAllowUnsandboxedBypass must be boolean');
  if (value.unsafeAllowUnsandboxedBypass && value.permissionMode !== 'bypassPermissions') throw new Error('unsafeAllowUnsandboxedBypass requires bypassPermissions');
  if (value.parentProfile && (!value.changedDimensions || value.changedDimensions.length === 0)) throw new Error('derived profiles require changedDimensions');
  if (!value.parentProfile && value.changedDimensions?.length) throw new Error('changedDimensions requires parentProfile');
  if (value.compaction?.enabled && (!Number.isFinite(value.compaction.thresholdPct) || (value.compaction.thresholdPct ?? 0) < 50 || (value.compaction.thresholdPct ?? 0) > 95)) throw new Error('enabled compaction thresholdPct must be between 50 and 95');
  if (value.throughputCap && (!Number.isFinite(value.throughputCap.outputTokensPerSecond) || value.throughputCap.outputTokensPerSecond <= 0 || value.throughputCap.enforcement !== 'external-proxy')) throw new Error('throughputCap requires a positive rate and external-proxy enforcement');
  if (value.inputPolicy) {
    if (typeof value.inputPolicy.attachments !== 'boolean' || value.inputPolicy.workspaceOnly !== true) throw new Error('inputPolicy requires attachments boolean and workspaceOnly=true');
    if (value.inputPolicy.maxFiles !== undefined) positiveInteger(value.inputPolicy.maxFiles, 'inputPolicy.maxFiles');
    if (value.inputPolicy.maxFileBytes !== undefined) positiveInteger(value.inputPolicy.maxFileBytes, 'inputPolicy.maxFileBytes');
  }
  if (value.mcpServers !== undefined) {
    if (!Array.isArray(value.mcpServers)) throw new Error('mcpServers must be an array');
    const ids = new Set<string>();
    for (const [index, server] of value.mcpServers.entries()) {
      if (!server || typeof server !== 'object') throw new Error(`mcpServers[${index}] must be an object`);
      if (!PROFILE_ID_RE.test(server.id) || ['__proto__', 'constructor', 'prototype', 'cindy_memory'].includes(server.id)) throw new Error(`mcpServers[${index}].id is invalid or reserved`);
      if (ids.has(server.id)) throw new Error(`duplicate MCP server id: ${server.id}`);
      ids.add(server.id);
      if (server.transport !== 'http') throw new Error('headless custom MCP supports streamable HTTP only');
      validateEndpoint(server.url, `mcpServers[${index}].url`);
      if (server.bearerTokenEnvVar && !ENV_NAME_RE.test(server.bearerTokenEnvVar)) throw new Error(`mcpServers[${index}].bearerTokenEnvVar is invalid`);
      for (const [header, envName] of Object.entries(server.headerEnvVars ?? {})) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) || !ENV_NAME_RE.test(envName)) throw new Error(`mcpServers[${index}].headerEnvVars is invalid`);
      }
      if (server.startupTimeoutMs !== undefined) positiveInteger(server.startupTimeoutMs, `mcpServers[${index}].startupTimeoutMs`);
      if (server.requestTimeoutMs !== undefined) positiveInteger(server.requestTimeoutMs, `mcpServers[${index}].requestTimeoutMs`);
    }
  }
  if (value.nativeProviders !== undefined) {
    if (value.agentBackend !== 'pi') throw new Error('nativeProviders are supported only by the pi backend');
    if (!Array.isArray(value.nativeProviders) || value.nativeProviders.length === 0) throw new Error('nativeProviders must be a non-empty array');
    const ids = new Set<string>();
    for (const [index, provider] of value.nativeProviders.entries()) {
      nonEmptyString(provider.id, `nativeProviders[${index}].id`);
      nonEmptyString(provider.name, `nativeProviders[${index}].name`);
      if (!PROFILE_ID_RE.test(provider.id) || provider.id === 'cindy' || ids.has(provider.id)) throw new Error(`nativeProviders[${index}].id is invalid, reserved or duplicated`);
      ids.add(provider.id);
      validateEndpoint(provider.baseUrl, `nativeProviders[${index}].baseUrl`);
      if (!['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'].includes(provider.api)) throw new Error(`nativeProviders[${index}].api is invalid`);
      if (provider.apiKeyEnvVar && !ENV_NAME_RE.test(provider.apiKeyEnvVar)) throw new Error(`nativeProviders[${index}].apiKeyEnvVar is invalid`);
      if (!Array.isArray(provider.models) || provider.models.length === 0) throw new Error(`nativeProviders[${index}].models must be non-empty`);
      for (const [modelIndex, model] of provider.models.entries()) {
        nonEmptyString(model.id, `nativeProviders[${index}].models[${modelIndex}].id`);
        positiveInteger(model.contextWindow, `nativeProviders[${index}].models[${modelIndex}].contextWindow`);
        positiveInteger(model.maxTokens, `nativeProviders[${index}].models[${modelIndex}].maxTokens`);
      }
    }
    if (!value.nativeProviders.some((provider) => provider.id === value.model?.provider && provider.models.some((model) => model.id === value.model?.requestedId))) throw new Error('selected Pi BYOM model must exist in nativeProviders');
  }
  if (value.piProjectSkills !== undefined) {
    if (value.agentBackend !== 'pi') throw new Error('piProjectSkills are supported only by the pi backend');
    if (typeof value.piProjectSkills.enabled !== 'boolean' || !Array.isArray(value.piProjectSkills.roots)) throw new Error('piProjectSkills requires enabled and roots');
    if (value.piProjectSkills.enabled && value.piProjectSkills.roots.length === 0) throw new Error('enabled piProjectSkills requires at least one root');
    for (const root of value.piProjectSkills.roots) {
      nonEmptyString(root, 'piProjectSkills.roots[]');
      if (path.isAbsolute(root) || root.split(/[\\/]/).includes('..')) throw new Error('piProjectSkills roots must be workspace-relative without parent traversal');
    }
  }
  if (value.expectedSystemPromptDigest && !/^[a-f0-9]{64}$/.test(value.expectedSystemPromptDigest)) throw new Error('expectedSystemPromptDigest must be a lowercase sha256 digest');
  return value as HeadlessProfile;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
}

export function profileDigest(profile: HeadlessProfile): string {
  return sha256(JSON.stringify(canonicalize(profile)));
}

function resolveProfileResource(value: string, profileDir: string, bundleRoot?: string): string {
  if (!value.startsWith('bundle:')) return path.isAbsolute(value) ? value : path.resolve(profileDir, value);
  if (!bundleRoot) throw new Error('bundle: profile resources require an explicit bundle root');
  const logicalPath = value.slice('bundle:'.length);
  if (!logicalPath || logicalPath.startsWith('/') || logicalPath.startsWith('\\') || /^[A-Za-z]:/.test(logicalPath)) {
    throw new Error('bundle: resource must use a relative bundle path');
  }
  const segments = logicalPath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('bundle: resource path contains an invalid segment');
  }
  const root = path.resolve(bundleRoot);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('bundle: resource escapes the bundle root');
  return resolved;
}

export async function readProfile(profilePath: string, bundleRoot?: string): Promise<ResolvedProfile> {
  const absolutePath = path.resolve(profilePath);
  const rawProfile = await readFile(absolutePath, 'utf8');
  const profile = validateProfile(JSON.parse(rawProfile));
  const canonicalProfileDigest = profileDigest(profile);
  const lockPath = path.join(path.dirname(absolutePath), 'profile.lock.json');
  const lock = await readFile(lockPath, 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const activeLock = lock?.profileFile === path.basename(absolutePath) ? lock : null;
  if (activeLock) {
    if (activeLock.schemaVersion !== 1 || activeLock.status !== 'frozen' || activeLock.profileId !== profile.id) throw new Error('profile lock identity is invalid');
    if (activeLock.profileFileSha256 !== sha256(rawProfile)) throw new Error('profile file does not match profile.lock.json');
    if (activeLock.profileDigest !== canonicalProfileDigest) throw new Error('profile digest does not match profile.lock.json');
    if (activeLock.agentBinaryVersion !== profile.agentBinaryVersion) throw new Error('profile Agent version does not match profile.lock.json');
    if (activeLock.cindyUpstreamCommit !== CINDY_UPSTREAM_COMMIT) throw new Error('profile lock Cindy upstream commit is stale');
  }
  // Profiles may travel with a release or checkout. Resolve relative binaries
  // beside the profile instead of depending on the caller's current directory.
  profile.agentBinaryPath = resolveProfileResource(profile.agentBinaryPath, path.dirname(absolutePath), bundleRoot);
  const endpointOverride = profile.agentBackend === 'claude-code' || profile.agentBackend === 'pi'
    ? process.env.CINDY_HEADLESS_BASE_URL ?? process.env.ANTHROPIC_BASE_URL
    : undefined;
  if (!profile.endpoint && endpointOverride) profile.endpoint = endpointOverride;
  let systemPrompt: string | undefined;
  let systemPromptDigest: string | null = null;
  if (profile.systemPromptFile) {
    const promptPath = resolveProfileResource(profile.systemPromptFile, path.dirname(absolutePath), bundleRoot);
    systemPrompt = await readFile(promptPath, 'utf8');
    systemPromptDigest = sha256(systemPrompt);
    if (profile.expectedSystemPromptDigest && profile.expectedSystemPromptDigest !== systemPromptDigest) throw new Error('system prompt digest does not match expectedSystemPromptDigest');
  } else if (profile.expectedSystemPromptDigest) {
    throw new Error('expectedSystemPromptDigest requires systemPromptFile');
  }
  if (activeLock && activeLock.systemPromptDigest !== systemPromptDigest) throw new Error('system prompt does not match profile.lock.json');
  return { profile, profilePath: absolutePath, systemPrompt, profileDigest: canonicalProfileDigest, systemPromptDigest };
}

export async function doctor(resolved: ResolvedProfile, outputDir?: string): Promise<{ ok: true; checks: Record<string, string | boolean> }> {
  assertSafeExecutionProfile(resolved.profile);
  await access(resolved.profile.agentBinaryPath);
  const codexHome = process.env.CINDY_HEADLESS_CODEX_HOME ?? process.env.CODEX_HOME;
  const nativeProviderAuth = resolved.profile.nativeProviders?.every((provider) => !provider.apiKeyEnvVar || Boolean(process.env[provider.apiKeyEnvVar]));
  if ((resolved.profile.agentBackend === 'claude-code' || resolved.profile.agentBackend === 'pi') && !(process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY) && !nativeProviderAuth) {
    throw new Error('CINDY_HEADLESS_API_KEY or ANTHROPIC_API_KEY is required');
  }
  for (const server of resolved.profile.mcpServers ?? []) {
    for (const envName of [server.bearerTokenEnvVar, ...Object.values(server.headerEnvVars ?? {})]) {
      if (envName && !process.env[envName]) throw new Error(`custom MCP ${server.id} requires environment variable ${envName}`);
    }
  }
  if (resolved.profile.agentBackend === 'codex' && !codexHome && !process.env.CINDY_CODEX_API_KEY) {
    throw new Error('CINDY_HEADLESS_CODEX_HOME, CODEX_HOME, or gateway API key is required for codex');
  }
  if (codexHome) await access(path.resolve(codexHome));
  const env = resolved.profile.agentBackend === 'codex' && codexHome
    ? { ...process.env, CODEX_HOME: path.resolve(codexHome) }
    : process.env;
  const versionResult = await execFileAsync(resolved.profile.agentBinaryPath, ['--version'], { timeout: 30_000, env });
  const observedVersion = `${versionResult.stdout} ${versionResult.stderr}`.trim();
  if (!observedVersion.includes(resolved.profile.agentBinaryVersion)) throw new Error(`agent binary version mismatch: expected ${resolved.profile.agentBinaryVersion}, observed ${observedVersion}`);
  if (resolved.profile.agentBackend === 'codex') {
    if (!process.env.CINDY_CODEX_API_KEY) {
      const login = await execFileAsync(resolved.profile.agentBinaryPath, ['login', 'status'], { timeout: 30_000, env });
      if (!`${login.stdout} ${login.stderr}`.toLowerCase().includes('logged in')) throw new Error('codex login status did not report an authenticated account');
    }
  }
  if (outputDir) {
    await mkdir(path.resolve(outputDir), { recursive: true });
    await access(path.resolve(outputDir));
  }
  const compatibility = compatibilityReport(resolved.profile);
  const endpointConfigured = resolved.profile.agentBackend === 'claude-code' || resolved.profile.agentBackend === 'pi'
    ? Boolean(resolved.profile.endpoint)
    : Boolean(process.env.CINDY_CODEX_BASE_URL ?? process.env.CINDY_HEADLESS_BASE_URL);
  return { ok: true, checks: { profile: true, contractVersion: String(compatibility.contractVersion), transport: compatibility.transport, securityIsolation: compatibility.security.safeForUntrustedWorkloads, agentBinary: resolved.profile.agentBinaryPath, agentBinaryVersion: observedVersion, authEnvironment: true, endpointConfigured, outputDirectory: outputDir ? path.resolve(outputDir) : 'not-requested', systemPromptDigest: resolved.systemPromptDigest ?? 'none' } };
}

export function capabilities(profile: HeadlessProfile): ProfileCapabilities {
  const codex = profile.agentBackend === 'codex';
  const pi = profile.agentBackend === 'pi';
  return { schemaVersion: 1, contractVersion: compatibilityReport(profile).contractVersion, profileId: profile.id, agentBackend: profile.agentBackend, supportedModelIds: [...profile.supportedModelIds], supportedPermissionModes: pi ? ['bypassPermissions'] : codex ? ['bypassPermissions', 'ask', 'auto', 'plan'] : ['bypassPermissions', 'acceptEdits', 'default', 'ask', 'plan'], projectContext: profile.projectContext, makerMemory: profile.makerMemory, nativeMemory: profile.nativeMemory, nativeToolSurface: pi ? 'pi-rpc-default' : codex ? 'codex-app-server-default' : 'claude-code-default', cindyMcpProviders: profile.makerMemory ? ['cindy_memory'] : [], desktopOnlyProviders: [], multiTurnSession: true, artifactContract: ['identity.json', 'config.json', 'trace.raw.jsonl', 'trace.jsonl', 'stderr.log', 'usage.json', 'result.json'], attachments: profile.inputPolicy?.attachments ?? false, customMcpServers: profile.mcpServers?.map((server) => server.id) ?? [], byomProviders: profile.nativeProviders?.map((provider) => provider.id) ?? [], piProjectSkills: profile.piProjectSkills?.enabled ?? false };
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function positiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`);
}

function validateEndpoint(raw: unknown, field: string): void {
  nonEmptyString(raw, field);
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`${field} must be HTTPS or loopback HTTP and must not contain credentials`);
  }
}
