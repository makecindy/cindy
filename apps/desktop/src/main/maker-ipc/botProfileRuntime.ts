import { and, desc, eq, inArray } from 'drizzle-orm';
import { buildBotMemoryScopeKey, buildMemoryScopeKey } from '@cindy/maker-core';
import { createHash, randomUUID } from 'node:crypto';

import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { buildDefaultBotIdentity } from '../../shared/botProfileDefaults.js';
import {
  buildBotSessionControlContext,
  normalizeBotSessionControlMode,
  type BotSessionControlMode,
} from '../../shared/botSessionControl.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  botLifecycleEvents,
  botProfileVersions,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';

interface BotSkillCatalogItem {
  name: string;
  enabled?: boolean;
  runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
  runtimeCommandName?: string;
  path?: string;
  scope?: string;
  contentSha256?: string;
}

interface BotMcpCatalogItem {
  name: string;
  source: 'builtin' | 'custom';
  available?: boolean;
  generation?: string;
}

interface BotToolsetCatalogItem {
  id: string;
  name: string;
  essential?: boolean;
  available?: boolean;
  version?: string;
}

export interface BotProfileRuntimeSnapshot {
  snapshotId: string;
  botId: string;
  sessionId: string;
  profileVersion: number;
  resolutionStatus: 'applied' | 'degraded';
  configuredSkills: string[];
  resolvedSkills: string[];
  unavailableSkills: string[];
  resolvedSkillEntries: BotSkillCatalogItem[];
  skillCatalogAvailable: boolean;
  skillMode: 'inherit' | 'allowlist';
  configuredMcpServers: string[];
  resolvedMcpServers: string[];
  unavailableMcpServers: string[];
  mcpMode: 'inherit' | 'allowlist';
  configuredToolsets: string[];
  resolvedToolsets: string[];
  unavailableToolsets: string[];
  disabledToolsets: string[];
  toolsetMode: 'inherit' | 'allowlist';
  sessionControlMode: BotSessionControlMode;
  memoryRefs: BotMemoryRuntimeRef[];
}

export interface BotMemoryRuntimeRef {
  kind: 'bot' | 'project' | 'user';
  scopeKey: string;
  access: 'read-write' | 'read-only';
  status: 'captured' | 'unavailable';
  sha256?: string;
  bytes?: number;
}

export type BotRuntimeFailureStage = 'prepare' | 'agent-start' | 'storage';

export interface BotProfileRuntimeDeps {
  listSkills?: (input: {
    agentKind: MakerSessionCreateOpts['agentKind'];
    workingDir: string;
    remoteHostId?: string;
  }) => Promise<BotSkillCatalogItem[]>;
  listMcpServers?: (input: {
    agentKind: MakerSessionCreateOpts['agentKind'];
    workingDir: string;
    remoteHostId?: string;
  }) => Promise<BotMcpCatalogItem[]>;
  listToolsets?: (input: {
    agentKind: MakerSessionCreateOpts['agentKind'];
    workingDir: string;
    remoteHostId?: string;
  }) => Promise<BotToolsetCatalogItem[]>;
  readMemoryIndex?: (scopeKey: string) => Promise<string>;
  readSkillSource?: (input: {
    path: string;
    remoteHostId?: string;
  }) => Promise<string>;
  fingerprintSkillSource?: (input: {
    path: string;
    remoteHostId?: string;
  }) => Promise<string>;
}

function runtimeFailureMetadata(
  stage: BotRuntimeFailureStage,
  error: unknown,
): Record<string, string> {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : 'Error';
  const code = typeof source.code === 'string' ? source.code.trim().slice(0, 120) : '';
  return {
    stage,
    errorName: name.slice(0, 120),
    ...(code ? { errorCode: code } : {}),
  };
}

export async function markBotProfileRuntimeApplied(
  snapshot: BotProfileRuntimeSnapshot,
): Promise<boolean> {
  const appliedAt = Date.now();
  return getDbClient().tx<boolean>('bots.finishRuntime', {
    snapshotId: snapshot.snapshotId,
    botId: snapshot.botId,
    sessionId: snapshot.sessionId,
    status: snapshot.resolutionStatus,
    finishedAt: appliedAt,
    failureJson: null,
    eventId: randomUUID(),
    eventType: 'runtime-applied',
    eventPayloadJson: JSON.stringify({
        snapshotId: snapshot.snapshotId,
        profileVersion: snapshot.profileVersion,
        status: snapshot.resolutionStatus,
        unavailableSkills: snapshot.unavailableSkills,
        unavailableMcpServers: snapshot.unavailableMcpServers,
        unavailableToolsets: snapshot.unavailableToolsets,
      }),
  });
}

export async function markBotProfileRuntimeFailed(
  snapshot: BotProfileRuntimeSnapshot,
  input: { stage: BotRuntimeFailureStage; error: unknown },
): Promise<boolean> {
  const failedAt = Date.now();
  const failure = runtimeFailureMetadata(input.stage, input.error);
  return getDbClient().tx<boolean>('bots.finishRuntime', {
    snapshotId: snapshot.snapshotId,
    botId: snapshot.botId,
    sessionId: snapshot.sessionId,
    status: 'failed',
    finishedAt: failedAt,
    failureJson: JSON.stringify(failure),
    eventId: randomUUID(),
    eventType: 'runtime-failed',
    eventPayloadJson: JSON.stringify({
        snapshotId: snapshot.snapshotId,
        profileVersion: snapshot.profileVersion,
        ...failure,
      }),
  });
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export function buildBotProfilePrompt(input: {
  displayName: string;
  identitySource: string;
}): string {
  const displayName = input.displayName.trim();
  return input.identitySource.trim() || buildDefaultBotIdentity(displayName);
}

/**
 * Hermes keeps SOUL as the complete identity slot and renders the active
 * profile marker as a separate stable prompt section. Keeping the two values
 * separate prevents Cindy-owned metadata from silently changing a user's SOUL
 * bytes or being mistaken for part of the identity document.
 */
export function buildBotProfileContextPrompt(displayName: string): string {
  const name = displayName.trim() || 'Cindy Bot';
  return `Active Cindy Bot profile: ${name}.`;
}

export function buildBotUserProfilePrompt(userContextSource: string): string {
  const content = userContextSource.trim();
  return content ? `## User Profile\n${content}` : '';
}

function memoryRef(
  kind: BotMemoryRuntimeRef['kind'],
  scopeKey: string,
  access: BotMemoryRuntimeRef['access'],
  content: string | null,
): BotMemoryRuntimeRef {
  if (content === null) return { kind, scopeKey, access, status: 'unavailable' };
  return {
    kind,
    scopeKey,
    access,
    status: 'captured',
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function formatMemorySnapshot(title: string, content: string): string {
  const body = content.trim();
  return body ? `## ${title}\n${body}` : '';
}

export function resolveBotSkillReferences(
  configuredSkills: string[],
  catalog: BotSkillCatalogItem[],
): {
  resolvedSkills: string[];
  unavailableSkills: string[];
  resolvedSkillEntries: BotSkillCatalogItem[];
} {
  const available = new Map<string, BotSkillCatalogItem>();
  for (const item of catalog) {
    if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
    available.set(item.name.trim(), item);
    if (item.runtimeCommandName?.trim()) available.set(item.runtimeCommandName.trim(), item);
  }
  const resolvedSkills: string[] = [];
  const resolvedSkillEntries: BotSkillCatalogItem[] = [];
  const unavailableSkills: string[] = [];
  for (const raw of configuredSkills) {
    const name = raw.trim();
    if (!name) continue;
    const item = available.get(name);
    if (!item || item.enabled === false || item.runtimeStatus === 'failed') {
      unavailableSkills.push(name);
      continue;
    }
    resolvedSkills.push(item.runtimeCommandName?.trim() || item.name.trim());
    resolvedSkillEntries.push(item);
  }
  return {
    resolvedSkills: [...new Set(resolvedSkills)],
    unavailableSkills: [...new Set(unavailableSkills)],
    resolvedSkillEntries: [
      ...new Map(
        resolvedSkillEntries.map((item) => [
          item.runtimeCommandName?.trim() || item.name.trim(),
          item,
        ]),
      ).values(),
    ],
  };
}

export function resolveBotMcpReferences(input: {
  configured: string[];
  mode: 'inherit' | 'allowlist';
  catalog: BotMcpCatalogItem[];
}): { resolved: string[]; unavailable: string[] } {
  const available = new Set(
    input.catalog
      .filter((item) => item.source === 'custom' && item.available !== false)
      .map((item) => item.name),
  );
  if (input.mode === 'inherit') {
    return { resolved: [...available], unavailable: [] };
  }
  return {
    resolved: input.configured.filter((name) => available.has(name)),
    unavailable: input.configured.filter((name) => !available.has(name)),
  };
}

export function resolveBotToolsetReferences(input: {
  configured: string[];
  mode: 'inherit' | 'allowlist';
  catalog: BotToolsetCatalogItem[];
}): {
  resolved: string[];
  unavailable: string[];
  disabled: string[];
} {
  const configurable = input.catalog.filter((item) => !item.essential);
  const available = new Set(
    configurable.filter((item) => item.available !== false).map((item) => item.id),
  );
  if (input.mode === 'inherit') {
    return {
      resolved: [...available],
      unavailable: [],
      disabled: configurable.filter((item) => item.available === false).map((item) => item.id),
    };
  }
  const resolved = input.configured.filter((id) => available.has(id));
  const resolvedSet = new Set(resolved);
  return {
    resolved,
    unavailable: input.configured.filter((id) => !available.has(id)),
    disabled: configurable.filter((item) => !resolvedSet.has(item.id)).map((item) => item.id),
  };
}

/**
 * Resolve the Bot Profile snapshot at the main-side session-start boundary.
 *
 * This deliberately produces only the SOUL-equivalent identity segment.
 * Skills, MCP, toolsets, memory and automation must be applied by their native
 * runtime owners; declaring them in natural language would create a fake
 * capability surface that can drift from what the harness actually loaded.
 */
export async function hydrateBotProfileRuntime(
  opts: MakerSessionCreateOpts,
  deps: BotProfileRuntimeDeps = {},
  options: { persistSnapshot?: boolean } = {},
): Promise<BotProfileRuntimeSnapshot | null> {
  if (!opts.id) return null;
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      profileVersion: botSessionLinks.profileVersion,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(eq(botSessionLinks.sessionId, opts.id), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row || (row.role !== 'canonical' && row.role !== 'route')) return null;
  const [profile] = await db
    .select()
    .from(botProfiles)
    .where(eq(botProfiles.id, row.botId))
    .limit(1);
  if (!profile) return null;
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, row.botId),
        eq(botProfileVersions.version, row.profileVersion),
      ),
    )
    .limit(1);
  if (!version) return null;
  const config = parseObject(version.capabilitiesJson);
  const configuredSkills = Array.isArray(config.skills)
    ? config.skills.filter((item): item is string => typeof item === 'string')
    : [];
  const skillMode =
    config.skillMode === 'allowlist'
      ? 'allowlist'
      : config.skillMode === 'inherit'
        ? 'inherit'
        : configuredSkills.length > 0
          ? 'allowlist'
          : 'inherit';
  const configuredMcpServers = readStringList(config.mcpServers);
  const mcpMode =
    config.mcpMode === 'allowlist'
      ? 'allowlist'
      : config.mcpMode === 'inherit'
        ? 'inherit'
        : configuredMcpServers.length > 0
          ? 'allowlist'
          : 'inherit';
  const rawToolsets = readStringList(config.toolsets ?? config.tools);
  const legacyToolPlaceholders = new Set(['files', 'browser', 'mcp']);
  const hasOnlyLegacyToolPlaceholders =
    rawToolsets.length > 0 && rawToolsets.every((item) => legacyToolPlaceholders.has(item));
  const configuredToolsets = hasOnlyLegacyToolPlaceholders ? [] : rawToolsets;
  const toolsetMode =
    config.toolsetMode === 'allowlist'
      ? 'allowlist'
      : config.toolsetMode === 'inherit'
        ? 'inherit'
        : configuredToolsets.length > 0
          ? 'allowlist'
          : 'inherit';
  if (typeof config.memory === 'boolean') opts.makerMemoryEnabled = config.memory;
  const botMemoryScopeKey = buildBotMemoryScopeKey(row.botId);
  if (config.memory !== false) opts.makerMemoryScopeKey = botMemoryScopeKey;
  const projectMemoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
  let botMemoryIndex: string | null = '';
  let projectMemoryIndex: string | null = '';
  if (config.memory !== false && deps.readMemoryIndex) {
    const [botMemory, projectMemory] = await Promise.allSettled([
      deps.readMemoryIndex(botMemoryScopeKey),
      deps.readMemoryIndex(projectMemoryScopeKey),
    ]);
    botMemoryIndex = botMemory.status === 'fulfilled' ? botMemory.value : null;
    projectMemoryIndex = projectMemory.status === 'fulfilled' ? projectMemory.value : null;
    opts.makerMemoryIndexSnapshot = [
      formatMemorySnapshot('Bot Memory', botMemoryIndex ?? ''),
      formatMemorySnapshot('Project Memory (read-only)', projectMemoryIndex ?? ''),
    ].filter(Boolean).join('\n\n');
  }
  const userContextSource = typeof config.userContextSource === 'string'
    ? config.userContextSource
    : '';
  opts.botUserProfilePrompt = buildBotUserProfilePrompt(userContextSource);
  const memoryRefs: BotMemoryRuntimeRef[] = config.memory === false
    ? []
    : [
        memoryRef('bot', botMemoryScopeKey, 'read-write', botMemoryIndex),
        memoryRef('project', projectMemoryScopeKey, 'read-only', projectMemoryIndex),
        memoryRef('user', `profile:${row.botId}:v${row.profileVersion}`, 'read-only', userContextSource),
      ];
  let resolvedSkills = configuredSkills;
  let unavailableSkills: string[] = [];
  let catalog: BotSkillCatalogItem[] = [];
  let resolvedSkillEntries: BotSkillCatalogItem[] = [];
  let skillCatalogAvailable = true;
  let runtimeSkillMode: 'inherit' | 'allowlist' = skillMode;
  if (deps.listSkills) {
    try {
      catalog = await deps.listSkills({
        agentKind: opts.agentKind,
        workingDir: opts.workingDir,
        remoteHostId: opts.remoteHostId,
      });
      if (skillMode === 'inherit') {
        resolvedSkillEntries = catalog.filter(
          (item) => item.enabled !== false && item.runtimeStatus !== 'failed',
        );
        resolvedSkills = resolvedSkillEntries.map(
          (item) => item.runtimeCommandName?.trim() || item.name.trim(),
        );
      } else {
        ({ resolvedSkills, unavailableSkills, resolvedSkillEntries } = resolveBotSkillReferences(
          configuredSkills,
          catalog,
        ));
      }
    } catch (error) {
      // A remote Bot must freeze the catalog from the same machine that will
      // execute the Agent. Continuing with an empty/local catalog can leave
      // harness-default Skills enabled while the snapshot claims otherwise.
      if (opts.remoteHostId) throw error;
      // Fail closed: a configured Skill is not advertised to the Bot when the
      // native harness catalog cannot prove that it exists for this runtime.
      skillCatalogAvailable = false;
      runtimeSkillMode = 'allowlist';
      resolvedSkills = [];
      unavailableSkills = skillMode === 'allowlist' ? [...new Set(configuredSkills)] : [];
      resolvedSkillEntries = [];
    }
  }
  if ((deps.fingerprintSkillSource || deps.readSkillSource) && resolvedSkillEntries.length > 0) {
    const fingerprinted: BotSkillCatalogItem[] = [];
    for (const entry of resolvedSkillEntries) {
      const skillPath = entry.path?.trim();
      const runtimeName = entry.runtimeCommandName?.trim() || entry.name.trim();
      if (!skillPath) {
        unavailableSkills.push(runtimeName);
        continue;
      }
      try {
        const contentSha256 = deps.fingerprintSkillSource
          ? await deps.fingerprintSkillSource({
              path: skillPath,
              remoteHostId: opts.remoteHostId,
            })
          : createHash('sha256').update(await deps.readSkillSource!({
              path: skillPath,
              remoteHostId: opts.remoteHostId,
            }), 'utf8').digest('hex');
        if (!/^[a-f0-9]{64}$/i.test(contentSha256)) {
          throw new Error('Skill source fingerprint is invalid');
        }
        fingerprinted.push({
          ...entry,
          contentSha256: contentSha256.toLowerCase(),
        });
      } catch {
        unavailableSkills.push(runtimeName);
      }
    }
    resolvedSkillEntries = fingerprinted;
    // Runtime policy must only expose entries whose complete source was
    // fingerprinted. Otherwise a failed read can still leave the native
    // harness free to load a configured Skill that the frozen snapshot omitted.
    catalog = fingerprinted;
    const usableNames = new Set(
      fingerprinted.map((entry) => entry.runtimeCommandName?.trim() || entry.name.trim()),
    );
    resolvedSkills = resolvedSkills.filter((name) => usableNames.has(name));
    unavailableSkills = [...new Set(unavailableSkills)];
  }
  // A Bot task freezes the catalog at start. `inherit` is a profile-authoring
  // convenience, not permission for a live harness to discover future Skills.
  if (deps.listSkills && skillCatalogAvailable) runtimeSkillMode = 'allowlist';
  const runtimeConfiguredSkills =
    skillMode === 'inherit' ? [...resolvedSkills] : [...configuredSkills];
  let mcpCatalog: BotMcpCatalogItem[] = [];
  let resolvedMcpServers: string[] = [];
  let unavailableMcpServers: string[] = [];
  let runtimeMcpMode: 'inherit' | 'allowlist' = mcpMode;
  if (deps.listMcpServers) {
    runtimeMcpMode = 'allowlist';
    try {
      mcpCatalog = await deps.listMcpServers({
        agentKind: opts.agentKind,
        workingDir: opts.workingDir,
        remoteHostId: opts.remoteHostId,
      });
      const resolvedMcp = resolveBotMcpReferences({
        configured: configuredMcpServers,
        mode: mcpMode,
        catalog: mcpCatalog,
      });
      resolvedMcpServers = resolvedMcp.resolved;
      unavailableMcpServers = resolvedMcp.unavailable;
    } catch {
      mcpCatalog = [];
      resolvedMcpServers = [];
      unavailableMcpServers = mcpMode === 'allowlist' ? configuredMcpServers : [];
    }
  } else if (mcpMode === 'allowlist') {
    unavailableMcpServers = configuredMcpServers;
  }
  const runtimeConfiguredMcpServers =
    mcpMode === 'inherit' ? [...resolvedMcpServers] : [...configuredMcpServers];
  let toolsetCatalog: BotToolsetCatalogItem[] = [];
  let resolvedToolsets: string[] = [];
  let unavailableToolsets: string[] = [];
  let disabledToolsets: string[] = [];
  let runtimeToolsetMode: 'inherit' | 'allowlist' = toolsetMode;
  if (deps.listToolsets) {
    runtimeToolsetMode = 'allowlist';
    try {
      toolsetCatalog = await deps.listToolsets({
        agentKind: opts.agentKind,
        workingDir: opts.workingDir,
        remoteHostId: opts.remoteHostId,
      });
      const resolvedToolsetsResult = resolveBotToolsetReferences({
        configured: configuredToolsets,
        mode: toolsetMode,
        catalog: toolsetCatalog,
      });
      resolvedToolsets = resolvedToolsetsResult.resolved;
      unavailableToolsets = resolvedToolsetsResult.unavailable;
      disabledToolsets = resolvedToolsetsResult.disabled;
    } catch {
      toolsetCatalog = [];
      resolvedToolsets = [];
      unavailableToolsets = toolsetMode === 'allowlist' ? configuredToolsets : [];
      disabledToolsets = [];
    }
  } else if (toolsetMode === 'allowlist') {
    unavailableToolsets = configuredToolsets;
  }
  const runtimeConfiguredToolsets =
    toolsetMode === 'inherit' ? [...resolvedToolsets] : [...configuredToolsets];
  const identity = version.identitySource.trim();
  opts.botProfilePrompt = buildBotProfilePrompt({
    displayName: profile.displayName,
    identitySource: identity,
  });
  const sessionControlMode = normalizeBotSessionControlMode(config.sessionControlMode);
  opts.botProfileContextPrompt = [
    buildBotProfileContextPrompt(profile.displayName),
    buildBotSessionControlContext(sessionControlMode),
  ].filter(Boolean).join('\n\n');
  opts.botRuntimeProfile = {
    botId: row.botId,
    profileVersion: row.profileVersion,
    skillPolicy: {
      mode: runtimeSkillMode,
      configured: runtimeConfiguredSkills,
      catalog: catalog.map((item) => ({
        name: item.name.trim(),
        ...(item.runtimeCommandName?.trim()
          ? { runtimeCommandName: item.runtimeCommandName.trim() }
          : {}),
        ...(item.path?.trim() ? { path: item.path.trim() } : {}),
        ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
        ...(item.runtimeStatus ? { runtimeStatus: item.runtimeStatus } : {}),
        ...(item.scope?.trim() ? { scope: item.scope.trim() } : {}),
        ...(item.contentSha256 ? { contentSha256: item.contentSha256 } : {}),
      })),
    },
    mcpPolicy: {
      mode: runtimeMcpMode,
      configured: runtimeConfiguredMcpServers,
      catalog: mcpCatalog.map((item) => ({ ...item })),
    },
    toolsetPolicy: {
      mode: runtimeToolsetMode,
      configured: runtimeConfiguredToolsets,
      catalog: toolsetCatalog.map((item) => ({ ...item })),
    },
  };
  const preparedAt = Date.now();
  const resolutionStatus =
    !skillCatalogAvailable ||
    unavailableSkills.length > 0 ||
    unavailableMcpServers.length > 0 ||
    unavailableToolsets.length > 0 ||
    memoryRefs.some((ref) => ref.status === 'unavailable')
      ? 'degraded'
      : 'applied';
  const snapshotId = randomUUID();
  const profileProvenance = {
    botId: row.botId,
    version: row.profileVersion,
    identitySha256: createHash('sha256').update(identity, 'utf8').digest('hex'),
    userContextSha256: createHash('sha256').update(userContextSource, 'utf8').digest('hex'),
  };
  const executionProvenance = {
    agentKind: opts.agentKind,
    model: opts.model,
    providerId: typeof opts.providerId === 'string' ? opts.providerId : null,
    effort: typeof opts.effort === 'string' ? opts.effort : null,
    fastMode: opts.fastMode === true,
    permissionMode: opts.permissionMode,
    workspaceKind: opts.workspaceKind,
    remote: Boolean(opts.remoteHostId),
  };
  const configuredJson = JSON.stringify({
    schemaVersion: 1,
    profile: profileProvenance,
    execution: executionProvenance,
    skillMode,
    skills: configuredSkills,
    memory: config.memory !== false,
    userContext: userContextSource.length > 0,
    automation: config.automation === true,
    mcpMode,
    mcpServers: configuredMcpServers,
    toolsetMode,
    toolsets: configuredToolsets,
    sessionControlMode,
  });
  const resolvedJson = JSON.stringify({
    schemaVersion: 1,
    profile: profileProvenance,
    execution: executionProvenance,
    skills: resolvedSkills,
    skillCatalogAvailable,
    unavailableSkills,
    mcpServers: resolvedMcpServers,
    unavailableMcpServers,
    toolsets: resolvedToolsets,
    unavailableToolsets,
    disabledToolsets,
    sessionControlMode,
    memoryScopeKey: opts.makerMemoryScopeKey ?? null,
    memoryRefs,
    skillResources: resolvedSkillEntries.map((entry) => ({
      name: entry.runtimeCommandName?.trim() || entry.name.trim(),
      path: entry.path?.trim() || null,
      sha256: entry.contentSha256 ?? null,
    })),
    mcpResources: resolvedMcpServers.map((name) => {
      const entry = mcpCatalog.find((item) => item.name === name);
      return { name, generation: entry?.generation ?? null };
    }),
    toolsetResources: resolvedToolsets.map((id) => {
      const entry = toolsetCatalog.find((item) => item.id === id);
      return { id, version: entry?.version ?? null };
    }),
  });
  const [previousSnapshot] = await db
    .select({ resolvedJson: botRuntimeSnapshots.resolvedJson })
    .from(botRuntimeSnapshots)
    .where(
      and(
        eq(botRuntimeSnapshots.sessionId, opts.id),
        eq(botRuntimeSnapshots.profileVersion, row.profileVersion),
        inArray(botRuntimeSnapshots.status, ['applied', 'degraded']),
      ),
    )
    .orderBy(desc(botRuntimeSnapshots.preparedAt))
    .limit(1);
  if (previousSnapshot) {
    const previousResolved = parseObject(previousSnapshot.resolvedJson);
    const currentResolved = parseObject(resolvedJson);
    for (const key of ['skillResources', 'mcpResources', 'toolsetResources'] as const) {
      if (Array.isArray(previousResolved[key])) {
        const previousFingerprint = JSON.stringify(previousResolved[key]);
        const currentFingerprint = JSON.stringify(currentResolved[key]);
        if (previousFingerprint === currentFingerprint) continue;
        throw Object.assign(
          new Error('Bot runtime resources changed after this task was frozen; Renew the Bot task to apply the new versions'),
          { code: 'BOT_RUNTIME_RESOURCE_DRIFT' },
        );
      }
    }
  }
  if (options.persistSnapshot !== false) {
    await getDbClient().tx('bots.prepareRuntime', {
      snapshot: {
        id: snapshotId,
        botId: row.botId,
        sessionId: opts.id!,
        profileVersion: row.profileVersion,
        agentKind: opts.agentKind,
        workingDir: opts.workingDir,
        memoryScopeKey: opts.makerMemoryScopeKey ?? null,
        configuredJson,
        resolvedJson,
        preparedAt,
      },
      eventId: randomUUID(),
      eventPayloadJson: JSON.stringify({
          snapshotId,
          profileVersion: row.profileVersion,
          agentKind: opts.agentKind,
          resolutionStatus,
          unavailableSkills,
          unavailableMcpServers,
          unavailableToolsets,
          unavailableMemoryRefs: memoryRefs
            .filter((ref) => ref.status === 'unavailable')
            .map((ref) => ref.kind),
        }),
    });
  }
  return {
    snapshotId,
    botId: row.botId,
    sessionId: opts.id,
    profileVersion: row.profileVersion,
    resolutionStatus,
    configuredSkills,
    resolvedSkills,
    unavailableSkills,
    resolvedSkillEntries,
    skillCatalogAvailable,
    skillMode,
    configuredMcpServers,
    resolvedMcpServers,
    unavailableMcpServers,
    mcpMode,
    configuredToolsets,
    resolvedToolsets,
    unavailableToolsets,
    disabledToolsets,
    toolsetMode,
    sessionControlMode,
    memoryRefs,
  };
}
