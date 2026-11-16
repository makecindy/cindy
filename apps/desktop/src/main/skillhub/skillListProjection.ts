import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { AgentCustomization, ListCustomizationsResult } from '@cindy/maker-core';
import type { BuiltInSkillDescriptor } from '../maker-host/built-in-skills';
import { canonicalBuiltInSkillActivationPath } from '../maker-host/built-in-skill-activation';
import type { StoredInstall } from './registry/types';
import type { ProjectInput, ScanResult, Skill, SkillFileEntry, SkillScope, SkillKind, SourceReport } from './scanner';
import { inspectLocalSkillTarget, isPluginManagedSkillPath } from './localSkillTarget';
import { isIgnoredSkillPackagePath } from './packageIgnore';
import { workingDirComparisonKey } from '../../shared/workingDir';

/** Read-only list projection. Runs only in the bounded discovery process. */
export interface SkillListProjectionInput {
  projects: ProjectInput[];
  listed: ListCustomizationsResult;
  registryEntries: Array<{ skillName: string; installPath: string; entry: StoredInstall }>;
  managedSkillRoots: readonly string[];
  builtInSkills: readonly BuiltInSkillDescriptor[];
  disabledPaths: readonly string[];
  userDataDir: string;
  appDataDir: string;
}

function activationKey(source: string, userDataDir: string, appDataDir: string): string {
  let resolved = realPathOrNormalized(source);
  if (path.basename(resolved).toLowerCase() === 'skill.md') resolved = path.dirname(resolved);
  resolved = canonicalBuiltInSkillActivationPath(resolved, userDataDir, appDataDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function skillPackageRelPath(root: string, child: string, fallback: string): string {
  return path.relative(root, child).replace(/\\/g, '/') || fallback;
}

function normalizeScope(engine: string, rawScope: string): SkillScope {
  if (engine === 'codex' || engine === 'pi') {
    return rawScope === 'repo' ? 'project' : 'global';
  }
  return rawScope === 'project' ? 'project' : 'global';
}

function realPathOrNormalized(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.normalize(value);
  }
}

function normalizeSkillEntityPath(c: AgentCustomization): AgentCustomization {
  if (
    c.kind === 'skill' &&
    path.basename(c.absolutePath).toLowerCase() === 'skill.md'
  ) {
    return {
      ...c,
      absolutePath: path.dirname(c.absolutePath),
      mdPath: c.mdPath ?? c.absolutePath,
    };
  }
  return c;
}

function filterSkillPackageFileEntries(rootDir: string, entries: SkillFileEntry[]): SkillFileEntry[] {
  return entries.filter((entry) => {
    const childPath = path.join(rootDir, entry.name);
    return !isIgnoredSkillPackagePath(skillPackageRelPath(rootDir, childPath, entry.name));
  });
}

function readBuiltInCustomization(descriptor: BuiltInSkillDescriptor): AgentCustomization {
  const skillFile = path.join(descriptor.absolutePath, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  let frontmatter: Record<string, unknown> | undefined;
  let description: string | undefined;
  let parseError: string | undefined;
  try {
    const parsed = matter(raw);
    frontmatter = parsed.data;
    if (typeof parsed.data.description === 'string') {
      description = parsed.data.description.trim().slice(0, 500) || undefined;
    }
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const files = fs.readdirSync(descriptor.absolutePath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' as const : 'file' as const }));
  return {
    engine: 'claude-code',
    kind: 'skill',
    scope: 'global',
    name: descriptor.name,
    description,
    absolutePath: descriptor.absolutePath,
    mdPath: skillFile,
    files,
    frontmatter,
    parseError,
  };
}

export function buildSkillList(input: SkillListProjectionInput): ScanResult {
  const { projects, listed, managedSkillRoots, builtInSkills, registryEntries, disabledPaths, userDataDir, appDataDir } = input;
  const projectByWorkingDir = new Map<string, ProjectInput>();
  const projectsByCanonicalWorkingDir = new Map<string, ProjectInput[]>();
  const projectPathKey = (value: string) => workingDirComparisonKey(path.normalize(value))!;
  const workingDirs: string[] = [];
  for (const p of projects) {
    if (p.projectRoot && path.isAbsolute(p.projectRoot)) {
      const lexicalRoot = projectPathKey(p.projectRoot);
      if (projectByWorkingDir.has(lexicalRoot)) continue;
      workingDirs.push(p.projectRoot);
      projectByWorkingDir.set(lexicalRoot, p);
      const canonicalRoot = projectPathKey(realPathOrNormalized(p.projectRoot));
      const aliases = projectsByCanonicalWorkingDir.get(canonicalRoot) ?? [];
      aliases.push(p);
      projectsByCanonicalWorkingDir.set(canonicalRoot, aliases);
    }
  }
  const projectForWorkingDir = (workingDir?: string): ProjectInput | undefined => {
    if (!workingDir) return undefined;
    const lexicalMatch = projectByWorkingDir.get(projectPathKey(workingDir));
    if (lexicalMatch) return lexicalMatch;
    const canonicalMatches = projectsByCanonicalWorkingDir.get(projectPathKey(realPathOrNormalized(workingDir)));
    return canonicalMatches?.length === 1 ? canonicalMatches[0] : undefined;
  };

  const discoveredEnginesByRealPath = new Map<
    string,
    Map<Skill['engine'], Skill['linkedEngines'][number]>
  >();
  for (const rawItem of listed.items) {
    const item = normalizeSkillEntityPath(rawItem);
    if (item.kind !== 'skill') continue;
    const realPath = realPathOrNormalized(item.absolutePath);
    const engines = discoveredEnginesByRealPath.get(realPath) ?? new Map();
    if (!engines.has(item.engine)) {
      engines.set(item.engine, {
        engine: item.engine,
        label: item.engine === 'claude-code' ? 'Claude' : item.engine === 'codex' ? 'Codex' : 'Pi',
        ...(item.runtimeStatus ? { runtimeStatus: item.runtimeStatus } : {}),
      });
    }
    discoveredEnginesByRealPath.set(realPath, engines);
  }
  const builtInRealPaths = new Set<string>();
  for (const descriptor of builtInSkills) {
    try {
      const customization = readBuiltInCustomization(descriptor);
      const realPath = realPathOrNormalized(customization.absolutePath);
      builtInRealPaths.add(realPath);
      listed.items.push(customization);
    } catch (error) {
      listed.errors.push({
        path: descriptor.absolutePath,
        message: `Could not read built-in Skill ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ── 过滤 + 跨引擎去重 ──────────────────────────────────────────────────────
  // ~/.agents/skills/ 是 agent-agnostic 的共享路径（canonical），实体文件在此。
  // 当同一逻辑 skill 被多个来源发现时，优先保留公共路径作为显示路径。
  const HIDDEN_SCOPES = new Set(['system', 'admin']);
  const isBackupPath = (p: string) => /\.bak\.\d+$/.test(path.basename(p));
  const isGenericPath = (p: string) => /\/\.agents\/skills\//.test(p.replace(/\\/g, '/'));
  const seenItems = new Map<string, { winner: AgentCustomization; all: AgentCustomization[]; realPath: string }>();
  for (const item of listed.items) {
    const c = normalizeSkillEntityPath(item);
    if (HIDDEN_SCOPES.has(c.scope)) continue;
    if (isBackupPath(c.absolutePath)) continue;
    const realKey = realPathOrNormalized(c.absolutePath);
    const normalizedScope = normalizeScope(c.engine, c.scope);
    const project = normalizedScope === 'project' ? projectForWorkingDir(c.workingDir) : undefined;
    const dedupeKey = project ? `${realKey}\0project:${project.hash}` : realKey;
    const existing = seenItems.get(dedupeKey);
    if (existing) {
      existing.all.push(c);
      if (!isGenericPath(existing.winner.absolutePath) && isGenericPath(c.absolutePath)) {
        existing.winner = c;
      }
      continue;
    }
    seenItems.set(dedupeKey, { winner: c, all: [c], realPath: realKey });
  }
  const deduped = Array.from(seenItems.values());

  // ── AgentCustomization → SkillhubSkill ──────────────────────────────────────
  const candidates = deduped.map(({ winner: c, all, realPath }) => {
    const engine = c.engine as Skill['engine'];
    const project = projectForWorkingDir(c.workingDir);
    const projectHash = project?.hash;
    // skill 类型的 identity 始终是目录名（= market slug），不依赖 frontmatter name。
    // Codex RPC 可能从 frontmatter 取 name 导致与目录名不一致，统一用 basename(realPath)。
    const canonicalName = c.kind === 'skill' ? path.basename(realPath) : c.name;
    // Codex RPC may return 'repo' scope for user-level skills when homedir is
    // used as fallback cwd. If the workingDir doesn't map to a tracked project,
    // treat the skill as global — it's effectively user-level.
    const rawScope = normalizeScope(engine, c.scope);
    const scope: SkillScope = (rawScope === 'project' && !projectHash) ? 'global' : rawScope;
    const urlKey = scope === 'global'
      ? `${c.kind}:global:${canonicalName}`
      : `${c.kind}:project:${projectHash}:${canonicalName}`;
    return { c, all, realPath, engine, project, projectHash, canonicalName, scope, urlKey };
  });
  const identityCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const identity = `${candidate.engine}:${candidate.urlKey}`;
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }

  const skills: Skill[] = candidates.map(({
    c,
    all,
    realPath,
    engine,
    project,
    projectHash,
    canonicalName,
    scope,
    urlKey,
  }) => {
    const builtIn = builtInRealPaths.has(realPath);
    const hasIdentityCollision = (identityCounts.get(`${engine}:${urlKey}`) ?? 0) > 1;
    // Pi entries are new to this SkillHub projection. Give them a path-derived
    // identity even when currently unique, so adding/removing a same-name source
    // never changes the surviving Pi entry's React/storage identity.
    const sourceKey = engine === 'pi' || hasIdentityCollision
      ? createHash('sha256').update(realPath).digest('hex')
      : undefined;
    const id = `${engine}:${urlKey}${sourceKey ? `:source:${sourceKey}` : ''}`;

    const engineSet = new Map<Skill['engine'], Skill['linkedEngines'][number]>();
    for (const item of all) {
      const eng = item.engine;
      if (!engineSet.has(eng)) {
        engineSet.set(eng, {
          engine: eng,
          label: eng === 'claude-code' ? 'Claude' : eng === 'codex' ? 'Codex' : 'Pi',
          ...(item.runtimeStatus ? { runtimeStatus: item.runtimeStatus } : {}),
        });
      }
    }
    const linkedEngines = builtIn
      ? Array.from(discoveredEnginesByRealPath.get(realPath)?.values() ?? [])
      : Array.from(engineSet.values());

    const skill: Skill = {
      id,
      urlKey,
      ...(sourceKey ? { sourceKey } : {}),
      ...(hasIdentityCollision ? { requiresSourceKey: true } : {}),
      engine,
      linkedEngines,
      kind: c.kind as SkillKind,
      scope,
      name: canonicalName,
      description: c.description,
      absolutePath: realPath,
      discoveredPath: c.absolutePath,
      mdPath: c.mdPath ?? realPath,
      files: c.kind === 'skill'
        ? filterSkillPackageFileEntries(realPath, (c.files ?? []) as SkillFileEntry[])
        : [],
      frontmatter: c.frontmatter,
      parseError: c.parseError,
      registryEntry: null,            // 下面 join 阶段填
      ...(c.kind === 'skill' ? (() => {
        const discoveryPaths = [...new Set(all.map((item) => item.absolutePath))];
        const target = inspectLocalSkillTarget(realPath, discoveryPaths, managedSkillRoots);
        return { cindyEnabled: !disabledPaths.includes(activationKey(realPath, userDataDir, appDataDir)), discoveryPaths,
          ...(builtIn ? { builtIn: true } : {}),
          managedByPlugin: isPluginManagedSkillPath(realPath, managedSkillRoots),
          canUninstall: !builtIn && target !== null, uninstallLinkOnly: target?.linkOnly ?? false };
      })() : {}),
      ...(project ? { projectRoot: project.projectRoot } : {}),
      ...(projectHash ? { projectHash } : {}),
    };
    return skill;
  });

  // ── join registry ──────────────────────────────────────────────────────────
  const registryByPath = new Map<string, (typeof registryEntries)[number]>();
  for (const r of registryEntries) {
    const installPathKey = path.normalize(r.installPath);
    registryByPath.set(installPathKey, r);
    try {
      const realInstallPathKey = path.normalize(fs.realpathSync(r.installPath));
      registryByPath.set(realInstallPathKey, r);
    } catch {
      // Missing paths retain their lexical registry key; listing never mutates them.
    }
  }
  for (const s of skills) {
    if (s.kind !== 'skill') continue;
    let resolved: string;
    try {
      resolved = fs.realpathSync(s.absolutePath);
    } catch {
      resolved = s.absolutePath;
    }
    const normPath = path.normalize(resolved);
    // path 是物理唯一标识；允许 registry skillName 和 scanner directory name 不一致
    // （历史数据或 frontmatter name 与目录名不同步时会出现）
    const registered = registryByPath.get(normPath);
    s.registryEntry = registered?.entry ?? null;
    s.registrySkillName = registered?.skillName;
  }

  // ── sources[] 兼容 (renderer 只存不读) ─────────────────────────────────────
  const sources: SourceReport[] = listed.errors.map((e) => ({
    kind: 'skill',
    scope: 'global',
    path: e.path ?? '',
    status: { state: 'error', message: e.message },
  }));

  return { skills, sources, learnSkillEnabled: skills.some((skill) => skill.builtIn && skill.name === 'learn' && skill.cindyEnabled !== false) };
}
