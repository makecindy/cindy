import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  McpProvider,
  McpProviderContext,
  PiNativeProvidersResult,
  PiProjectTrustInputSnapshot,
  UserMessage,
} from '@cindy/maker-core';
import type { HeadlessProfile } from './profile.js';

const execFileAsync = promisify(execFile);

export interface HeadlessTurnInput {
  text: string;
  attachments?: Array<{ type: 'file' | 'image'; path: string; mimeType?: string }>;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateTurnInput(value: unknown): string | HeadlessTurnInput {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('each turn must be a non-empty string or structured turn');
  const turn = value as Partial<HeadlessTurnInput>;
  if (typeof turn.text !== 'string' || !turn.text.trim()) throw new Error('structured turn.text must be non-empty');
  if (turn.attachments !== undefined && !Array.isArray(turn.attachments)) throw new Error('structured turn.attachments must be an array');
  for (const attachment of turn.attachments ?? []) {
    if (!attachment || !['file', 'image'].includes(attachment.type) || typeof attachment.path !== 'string' || !attachment.path.trim()) throw new Error('attachment requires type=file|image and a non-empty path');
    if (path.isAbsolute(attachment.path) || attachment.path.split(/[\\/]/).includes('..')) throw new Error('attachment paths must be workspace-relative without parent traversal');
  }
  return turn as HeadlessTurnInput;
}

export async function resolveTurns(
  rawTurns: unknown[],
  workingDir: string,
  policy: HeadlessProfile['inputPolicy'],
): Promise<Array<string | UserMessage>> {
  const workspace = await realpath(workingDir);
  return Promise.all(rawTurns.map(async (raw) => {
    const turn = validateTurnInput(raw);
    if (typeof turn === 'string') return turn;
    const attachments = turn.attachments ?? [];
    if (attachments.length > 0 && !policy?.attachments) throw new Error('profile does not enable attachments');
    if (attachments.length > (policy?.maxFiles ?? 16)) throw new Error('turn exceeds inputPolicy.maxFiles');
    const content: Exclude<UserMessage['content'], string> = [{ type: 'text', text: turn.text }];
    for (const attachment of attachments) {
      const lexical = path.resolve(workspace, attachment.path);
      const canonical = await realpath(lexical);
      if (!isWithin(workspace, canonical)) throw new Error(`attachment escapes working directory: ${attachment.path}`);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) throw new Error(`attachment is not a file: ${attachment.path}`);
      if (metadata.size > (policy?.maxFileBytes ?? 25 * 1024 * 1024)) throw new Error(`attachment exceeds inputPolicy.maxFileBytes: ${attachment.path}`);
      content.push({ type: attachment.type, path: canonical, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) });
    }
    return { type: 'user', content } satisfies UserMessage;
  }));
}

export class HeadlessRemoteMcpProvider implements McpProvider {
  readonly name: string;

  constructor(private readonly config: NonNullable<HeadlessProfile['mcpServers']>[number]) {
    this.name = config.id;
  }

  private environment(): Record<string, string> {
    const names = [this.config.bearerTokenEnvVar, ...Object.values(this.config.headerEnvVars ?? {})].filter((name): name is string => Boolean(name));
    return Object.fromEntries(names.map((name) => {
      const value = process.env[name];
      if (!value) throw new Error(`custom MCP ${this.name} requires environment variable ${name}`);
      return [name, value];
    }));
  }

  toClaudeSdkConfig(_context: McpProviderContext): unknown {
    const env = this.environment();
    const headers = Object.fromEntries(Object.entries(this.config.headerEnvVars ?? {}).map(([header, envName]) => [header, env[envName]!])) as Record<string, string>;
    if (this.config.bearerTokenEnvVar && !Object.keys(headers).some((header) => header.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${env[this.config.bearerTokenEnvVar]}`;
    return { type: 'http', url: this.config.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }

  toCodexMcpConfig(_context: McpProviderContext) {
    return {
      type: 'http' as const,
      url: new URL(this.config.url).href.replace(/\\/g, '%5C'),
      ...(this.config.bearerTokenEnvVar ? { bearerTokenEnvVar: this.config.bearerTokenEnvVar } : {}),
      ...(this.config.headerEnvVars && Object.keys(this.config.headerEnvVars).length ? { envHttpHeaders: this.config.headerEnvVars } : {}),
    };
  }

  getExtraEnv(_context: McpProviderContext): Record<string, string> {
    return this.environment();
  }
}

export function resolveNativeProviders(profile: HeadlessProfile): PiNativeProvidersResult {
  const providers = (profile.nativeProviders ?? []).map((provider) => ({ ...provider }));
  const env: Record<string, string> = {};
  for (const provider of providers) {
    if (!provider.apiKeyEnvVar) continue;
    const value = process.env[provider.apiKeyEnvVar];
    if (!value) throw new Error(`native provider ${provider.id} requires environment variable ${provider.apiKeyEnvVar}`);
    env[provider.apiKeyEnvVar] = value;
  }
  return { providers, env };
}

async function hashTree(entryPath: string, root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const metadata = await lstat(entryPath);
  if (metadata.isSymbolicLink()) throw new Error(`Pi skill tree contains a symbolic link: ${entryPath}`);
  const relative = path.relative(root, entryPath).replaceAll('\\', '/');
  if (metadata.isFile()) {
    hash.update(`f\0${relative}\0`);
    hash.update(await readFile(entryPath));
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`Pi skill tree contains a special file: ${entryPath}`);
  hash.update(`d\0${relative}\0`);
  const children = await readdir(entryPath);
  children.sort();
  for (const child of children) await hashTree(path.join(entryPath, child), root, hash);
}

export async function resolvePiProjectTrust(
  workingDir: string,
  config: NonNullable<HeadlessProfile['piProjectSkills']>,
): Promise<PiProjectTrustInputSnapshot | null> {
  if (!config.enabled) return null;
  const canonicalWorkingDir = await realpath(workingDir);
  const { stdout } = await execFileAsync('git', ['-C', canonicalWorkingDir, 'rev-parse', '--show-toplevel'], { timeout: 10_000 });
  const canonicalRepoRoot = await realpath(stdout.trim());
  if (!isWithin(canonicalRepoRoot, canonicalWorkingDir)) throw new Error('Pi project working directory is outside its Git root');
  const skills: string[] = [];
  const configuredRoots: string[] = [];
  for (const relativeRoot of config.roots) {
    const normalizedRoot = relativeRoot.replaceAll('\\', '/');
    if (normalizedRoot === '.pi/skills') configuredRoots.push(path.join(canonicalWorkingDir, '.pi', 'skills'));
    else if (normalizedRoot === '.agents/skills') {
      let cursor = canonicalWorkingDir;
      while (true) {
        configuredRoots.push(path.join(cursor, '.agents', 'skills'));
        if (path.resolve(cursor) === path.resolve(canonicalRepoRoot)) break;
        cursor = path.dirname(cursor);
      }
    } else configuredRoots.push(path.resolve(canonicalRepoRoot, relativeRoot));
  }
  for (const rootPath of [...new Set(configuredRoots)]) {
    let entries;
    try { entries = await readdir(rootPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Pi skill root contains a non-regular entry: ${entry.name}`);
      const candidate = await realpath(path.join(rootPath, entry.name));
      if (!isWithin(canonicalRepoRoot, candidate)) throw new Error(`Pi skill escapes repository: ${candidate}`);
      if (entry.isDirectory()) {
        const marker = await fileOrNull(path.join(candidate, 'SKILL.md'))
          ?? await fileOrNull(path.join(candidate, 'skill.md'));
        if (!marker) continue;
        if (!isWithin(canonicalRepoRoot, marker)) throw new Error(`Pi skill marker escapes repository: ${marker}`);
      } else if (!entry.name.toLowerCase().endsWith('.md')) continue;
      skills.push(candidate);
    }
  }
  const revisionHash = createHash('sha256');
  for (const skill of skills) {
    revisionHash.update(`skill\0${path.relative(canonicalRepoRoot, skill).replaceAll('\\', '/')}\0`);
    await hashTree(skill, skill, revisionHash);
  }
  const revision = revisionHash.digest('hex');
  const platform = process.platform === 'win32' ? 'win32' as const : 'posix' as const;
  const identity = {
    workingDir: path.resolve(workingDir),
    canonicalWorkingDir,
    canonicalRepoRoot,
    repoRootStatus: 'resolved' as const,
    platform,
    canonicalPathEncoding: platform === 'win32' ? 'utf16-lossless' as const : 'utf8-lossless' as const,
    ...(platform === 'win32' ? { windowsCaseComparison: 'ordinal-insensitive' as const } : {}),
  };
  return {
    identity,
    approval: { status: 'approved', scope: 'working-dir', scopeKey: `${canonicalRepoRoot}\0${canonicalWorkingDir}`, revision: `headless-profile:${revision}` },
    discovered: {
      skills,
      canonicalSkillEvidence: skills.map((skill) => ({ discoveredPath: skill, canonicalPath: skill })),
      settings: [],
      packages: [],
      extensions: [],
    },
  };
}

/**
 * Pi project resources that a local root task loads in place.
 *
 * Cindy `05d5e4209` (Pi 0.85.x) makes every local root task hand the workspace's
 * own Skill folders, prompt templates and extensions to Pi as explicit CLI paths
 * (`packages/maker-core/src/agents/pi/project-resource-cli.ts`), so
 * `--no-approve` alone no longer keeps them out of the runtime. Headless keeps
 * the approved-Skill contract of its frozen profiles by denying every Skill the
 * profile did not approve, and records the remaining resources in the artifact
 * because no profile field can freeze them yet.
 *
 * Collection mirrors the upstream rules: non-dot Skill folders that contain
 * `SKILL.md` or `skill.md`, `.agents/skills` from the working directory up to the
 * Git root, `.pi/prompts/*.md`, and `.pi/extensions/<file>.ts` or
 * `<folder>/index.ts`. Every candidate must resolve inside the Git root.
 */
export interface PiProjectWorkspaceResources {
  readonly canonicalWorkingDir: string;
  readonly canonicalRepoRoot: string;
  readonly skills: readonly string[];
  readonly promptTemplates: readonly string[];
  readonly extensions: readonly string[];
}

async function realpathOrNull(target: string): Promise<string | null> {
  try { return await realpath(target); } catch { return null; }
}

async function directoryOrNull(target: string): Promise<string | null> {
  const canonical = await realpathOrNull(target);
  if (!canonical) return null;
  try { return (await stat(canonical)).isDirectory() ? canonical : null; } catch { return null; }
}

async function fileOrNull(target: string): Promise<string | null> {
  const canonical = await realpathOrNull(target);
  if (!canonical) return null;
  try { return (await stat(canonical)).isFile() ? canonical : null; } catch { return null; }
}

async function findNearestGitRoot(start: string): Promise<string | null> {
  let current = start;
  while (true) {
    let markerFound = false;
    try {
      const marker = await stat(path.join(current, '.git'));
      markerFound = marker.isDirectory() || marker.isFile();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Mirrors maker-core: anything other than a clean miss stays fail-closed.
      markerFound = code !== 'ENOENT' && code !== 'ENOTDIR';
    }
    if (markerFound) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function collectSkillDirs(repoRoot: string, skillsDir: string, bucket: Set<string>): Promise<void> {
  const resolvedDir = await directoryOrNull(skillsDir);
  if (!resolvedDir || !isWithin(repoRoot, resolvedDir)) return;
  const entries = await readdir(resolvedDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const realFolder = await directoryOrNull(path.join(resolvedDir, entry.name));
    if (!realFolder || !isWithin(repoRoot, realFolder)) continue;
    const upper = await fileOrNull(path.join(realFolder, 'SKILL.md'));
    const marker = upper ?? await fileOrNull(path.join(realFolder, 'skill.md'));
    if (!marker || !isWithin(repoRoot, marker)) continue;
    bucket.add(realFolder);
  }
}

export async function inspectPiProjectWorkspaceResources(workingDir: string): Promise<PiProjectWorkspaceResources> {
  const canonicalWorkingDir = await realpathOrNull(path.resolve(workingDir)) ?? path.resolve(workingDir);
  const canonicalRepoRoot = await findNearestGitRoot(canonicalWorkingDir) ?? canonicalWorkingDir;
  const skills = new Set<string>();
  await collectSkillDirs(canonicalRepoRoot, path.join(canonicalWorkingDir, '.pi', 'skills'), skills);
  let cursor = canonicalWorkingDir;
  while (true) {
    await collectSkillDirs(canonicalRepoRoot, path.join(cursor, '.agents', 'skills'), skills);
    if (cursor === canonicalRepoRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const promptTemplates = new Set<string>();
  const promptsDir = await directoryOrNull(path.join(canonicalWorkingDir, '.pi', 'prompts'));
  if (promptsDir && isWithin(canonicalRepoRoot, promptsDir)) {
    const entries = await readdir(promptsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
      const candidate = await fileOrNull(path.join(promptsDir, entry.name));
      if (candidate && isWithin(canonicalRepoRoot, candidate)) promptTemplates.add(candidate);
    }
  }

  const extensions = new Set<string>();
  const extensionsDir = await directoryOrNull(path.join(canonicalWorkingDir, '.pi', 'extensions'));
  if (extensionsDir && isWithin(canonicalRepoRoot, extensionsDir)) {
    const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const candidate = await realpathOrNull(path.join(extensionsDir, entry.name));
      if (!candidate || !isWithin(canonicalRepoRoot, candidate)) continue;
      const index = await fileOrNull(path.join(candidate, 'index.ts'));
      if (index && isWithin(canonicalRepoRoot, index)) { extensions.add(index); continue; }
      if (candidate.endsWith('.ts') && await fileOrNull(candidate)) extensions.add(candidate);
    }
  }

  return Object.freeze({
    canonicalWorkingDir,
    canonicalRepoRoot,
    skills: Object.freeze([...skills].sort()),
    promptTemplates: Object.freeze([...promptTemplates].sort()),
    extensions: Object.freeze([...extensions].sort()),
  });
}

/** Windows resolves the same project path under several letter cases. */
function canonicalResourceKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Skills Pi would load in place that this profile did not approve.
 *
 * A disabled `piProjectSkills` approves nothing, so every discovered project
 * Skill is denied instead of silently entering the runtime.
 */
export function piProjectSkillDenials(
  resources: PiProjectWorkspaceResources,
  approvedSkills: readonly string[],
): readonly string[] {
  const approved = new Set(approvedSkills.map(canonicalResourceKey));
  return Object.freeze(resources.skills.filter((skill) => !approved.has(canonicalResourceKey(skill))));
}

export interface PiProjectResourcesEvidence {
  /** Local root tasks load project resources from the workspace instead of a staged copy. */
  readonly inPlace: true;
  /** The profile's approved Skill roots remain the only Skills Pi may load. */
  readonly approvedSkillRootsEnforced: true;
  readonly presentSkills: readonly string[];
  readonly deniedSkills: readonly string[];
  readonly promptTemplates: readonly string[];
  readonly extensions: readonly string[];
}

/** Repo-root-relative evidence so reviewers can see what the runtime actually received. */
export function piProjectResourcesEvidence(
  resources: PiProjectWorkspaceResources | null,
  deniedSkills: readonly string[],
): PiProjectResourcesEvidence | null {
  if (!resources) return null;
  const relative = (target: string) => path.relative(resources.canonicalRepoRoot, target).replaceAll('\\', '/');
  return Object.freeze({
    inPlace: true as const,
    approvedSkillRootsEnforced: true as const,
    presentSkills: Object.freeze(resources.skills.map(relative)),
    deniedSkills: Object.freeze([...deniedSkills].map(relative)),
    promptTemplates: Object.freeze(resources.promptTemplates.map(relative)),
    extensions: Object.freeze(resources.extensions.map(relative)),
  });
}
