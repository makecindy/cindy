import { and, desc, eq, inArray } from 'drizzle-orm';
import { buildBotMemoryScopeKey } from '@cindy/maker-core';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { buildDefaultBotIdentity } from '../../shared/botProfileDefaults.js';
import {
  buildBotContextTier,
  buildBotStableTier,
  buildBotVolatileTier,
  type BotPromptCapabilitySignals,
  type BotSystemPromptInput,
} from './botSystemPrompt.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  botLifecycleEvents,
  botProfileVersions,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';
import { clearBotAttention, noteBotAttention } from './botAttentionService.js';
import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc:bot-profile-runtime');

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
  memoryRefs: BotMemoryRuntimeRef[];
  /** True when the permanent canonical Chat must rebuild its live runtime. */
  runtimeEpochChanged: boolean;
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
  /**
   * 这个伙伴的队友们(除它自己之外、还启用着的伙伴)。
   *
   * 委派能力开着却不告诉它队友是谁,那条能力基本不会被触发 —— 见
   * buildBotTeammateRoster 的说明。返回空数组表示「就它一个」。
   */
  listTeammates?: (input: { excludeBotId: string }) => Promise<
    { id: string; name: string; description?: string | null }[]
  >;
  /** @deprecated Bot Home Memory no longer follows the global Maker Memory switch. */
  isMemoryEngineEnabled?: () => boolean;
  /**
   * 这个伙伴自己沉淀的技能(Cindy 自有 per-bot 存储,不是 harness 发现目录)。
   *
   * 它刻意**不**并进 `listSkills` 的目录:那份目录是「用户允许保留哪些既有
   * Skill」的 allowlist 语料,而这些是伙伴自己写的文件,恒挂载、也不该被
   * 用户的勾选误关掉。远端会话拿不到本机路径,由调用方自行不注入。
   */
  listOwnSkills?: (input: { botId: string }) => Promise<{
    pluginRoot: string;
    skills: { name: string; description: string; path: string }[];
  }>;
  readSkillSource?: (input: {
    path: string;
    remoteHostId?: string;
  }) => Promise<string>;
  fingerprintSkillSource?: (input: {
    path: string;
    remoteHostId?: string;
  }) => Promise<string>;
  /**
   * 伙伴的家(`botProfileFolder.ts`):它在磁盘上的位置,以及用户维护的 prompt overlay。
   *
   * 身份与用户画像不走这里 —— 它们已经由对账收进冻结快照,运行时认的是快照,
   * 从文件再读一遍会让同一轮里出现两个版本的身份。
   *
   * `homeDir` 有两个去处,缺一不可:进提示词(伙伴才知道自己有个家)、进
   * `writableDirs`(文件工具才够得到且真能修改)。`extraDirs` 是只读引用面,
   * 把家塞进去会出现「提示词承诺可写、运行时明确拒绝」的死路。
   *
   * 远端会话拿不到本机路径,由调用方自行不注入。
   */
  readProfileFolder?: (input: { botId: string }) => Promise<{
    homeDir: string;
    contentWritableDirs?: string[];
    systemPromptOverride: string;
  }>;
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
  const transitioned = await getDbClient().tx<boolean>('bots.finishRuntime', {
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
  if (transitioned) {
    await clearBotAttention({ botId: snapshot.botId, successfulAt: appliedAt }).catch((error) => {
      log.warn('Bot runtime attention clear failed', {
        botId: snapshot.botId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return transitioned;
}

export async function markBotProfileRuntimeFailed(
  snapshot: BotProfileRuntimeSnapshot,
  input: { stage: BotRuntimeFailureStage; error: unknown },
): Promise<boolean> {
  const failedAt = Date.now();
  const failure = runtimeFailureMetadata(input.stage, input.error);
  const transitioned = await getDbClient().tx<boolean>('bots.finishRuntime', {
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
  if (transitioned) {
    await noteBotAttention({
      botId: snapshot.botId,
      failure: input.error,
      observedAt: failedAt,
    }).catch((error) => {
      log.warn('Bot runtime attention update failed', {
        botId: snapshot.botId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return transitioned;
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

/**
 * Cindy-owned Bot runtime guidance, kept outside the user-authored SOUL.
 *
 * Hermes keeps identity files declarative while the runtime explains the
 * capabilities that are actually mounted for the current agent. The helper
 * MCP remains the source of truth: this section describes capability classes
 * and tells the Bot to discover the live surface instead of freezing tool
 * names into a prompt that can drift from the registered server.
 *
 * 批次 ε 只加了一句 `learned-` slug 约定。它必须待在 prompt 层:哪一条经验值得
 * 留成可复用的做法,是语言理解问题,代码判不了(见 maker-core-and-agent-behavior.md
 * §2 的分界)。代码这边只负责确定性的那一半 —— 前缀检出与两个列表的切分,见
 * Renderer 的 `botGrowth.partitionBotMemoryRecords`。文本是常量,不含会话变量,
 * 因此 prompt 前缀保持稳定,不影响缓存率。
 */
export function buildBotCapabilityContextPrompt(
  options: { helperAvailable?: boolean } = {},
): string {
  const helperAvailable = options.helperAvailable !== false;
  return [
    '## Cindy Bot Runtime',
    'You are running as a Cindy Bot with a durable Profile. This task is one active runtime of that Bot, not an ordinary standalone task.',
    ...(helperAvailable ? [
      'Use direct Bot tools named in this prompt without inventorying Cindy. Only when the user asks for an explicitly mounted external capability and its exact tool is unknown, perform one scoped discovery for that capability; do not repeatedly list the whole tool surface.',
      'Cindy Bot collaboration can discover other available Bots, hand off a bounded objective to one of them, receive the result back in this task, inspect ongoing or completed handoffs, and cancel a handoff that is still active.',
      'A Bot handoff is task delegation with a result return path. It does not rewrite another Bot\'s identity or make that Bot obey. If the user asks for obedience or control, explain this boundary and immediately offer the available delegation path instead of redirecting them to a separate team workflow.',
    ] : []),
    'Long-term memory and your own Skills are deliberate, user-visible records, not a diary of every turn. Write one only when the user explicitly asks, a preference has repeated and is stable, or a workflow has been verified and is clearly reusable. Never start a background review worker just to create memory or Skills.',
    'Before writing memory, search for an existing record and update it instead of creating a duplicate. Use a `learned-` name only for a stable reusable working habit, never for a one-off conclusion, temporary path, guess, or unverified step.',
    ...(helperAvailable ? [
      'Before `save_bot_skill`, call `list_bot_skills`. Save or update a Skill only after the workflow has succeeded and the reusable steps are known. A saved Skill is mounted from the next task onward and remains visible, editable, and removable by the user.',
    ] : []),
  ].join('\n');
}

/**
 * 把 Bot Home 的 workspace 补进会话可写面。整个 Home 不能直接可写：根部留有
 * 旧版 config.json 等宿主配置，memories / skills 也包含宿主维护的数据与索引。
 */
export function withBotHomeAccess(
  extraDirs: readonly string[] | undefined,
  writableDirs: readonly string[] | undefined,
  homeDir: string,
  contentWritableDirs: readonly string[] = [],
): { extraDirs: string[] | undefined; writableDirs: string[] | undefined } {
  const home = homeDir.trim();
  const references = Array.isArray(extraDirs) ? [...extraDirs] : undefined;
  const writable = Array.isArray(writableDirs) ? [...writableDirs] : undefined;
  if (!home) return { extraDirs: references, writableDirs: writable };
  const resolvedHome = path.resolve(home);
  const workspaceRoot = path.join(resolvedHome, 'workspace');
  const contains = (root: string, candidate: string): boolean => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const homeRelativeWritable = contentWritableDirs
    .map((dir) => dir.trim())
    .filter((dir) => {
      if (!dir) return false;
      return path.resolve(dir) === workspaceRoot;
    });
  const keptReferences = references?.filter(
    (dir) =>
      !contains(dir, resolvedHome)
      && !homeRelativeWritable.some((contentDir) => contains(dir, contentDir)),
  );
  const currentWritable = writable?.filter((dir) => !contains(dir, resolvedHome)) ?? [];
  return {
    extraDirs: keptReferences && keptReferences.length > 0 ? keptReferences : undefined,
    writableDirs: [
      ...new Map(
        [...currentWritable, ...homeRelativeWritable].map((dir) => [path.resolve(dir), dir]),
      ).values(),
    ],
  };
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

function formatMemorySnapshot(title: string, content: string, note?: string): string {
  const body = content.trim();
  if (!body) return '';
  return note ? `## ${title}\n${note}\n\n${body}` : `## ${title}\n${body}`;
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
    // "Follow Cindy" means available for progressive discovery, not eagerly
    // mounting every custom server into every Bot context.
    return { resolved: [], unavailable: [] };
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
      // Essential Bot runtime tools are mounted separately. Optional Cindy
      // toolsets stay discoverable but do not flood the Bot by default.
      resolved: [],
      unavailable: [],
      disabled: configurable.map((item) => item.id),
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
  if (!row || !['canonical', 'delegation'].includes(row.role)) return null;
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
  // `inherit` is retained only as a wire/storage compatibility value. For a
  // Bot it now means "no explicit external Skill grant"; ambient Cindy,
  // project, and harness Skills never become part of the Bot runtime.
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
  // Bot Memory belongs to the Bot Home and is independent from Cindy's global
  // Maker Memory switch. The profile can still explicitly disable its own memory.
  const memoryEngineEnabled = config.memory !== false;
  opts.makerMemoryEnabled = memoryEngineEnabled;
  const botMemoryScopeKey = buildBotMemoryScopeKey(row.botId);
  if (config.memory !== false) opts.makerMemoryScopeKey = botMemoryScopeKey;
  const memoryActive = memoryEngineEnabled;
  let botMemoryIndex: string | null = '';
  if (memoryActive && deps.readMemoryIndex) {
    const [botMemory] = await Promise.allSettled([deps.readMemoryIndex(botMemoryScopeKey)]);
    botMemoryIndex = botMemory.status === 'fulfilled' ? botMemory.value : null;
    opts.makerMemoryIndexSnapshot = formatMemorySnapshot(
      'Bot Memory',
      botMemoryIndex ?? '',
      opts.agentKind === 'pi'
        ? 'This is the only durable memory for this Bot. Use the direct `bot_memory` tool.'
        : 'This is the only durable memory for this Bot. Memory tools operate only on this Bot Home.',
    );
  }
  const userContextSource = typeof config.userContextSource === 'string'
    ? config.userContextSource
    : '';
  opts.botUserProfilePrompt = buildBotUserProfilePrompt(userContextSource);
  const memoryRefs: BotMemoryRuntimeRef[] = !memoryActive
    ? []
    : [
        memoryRef('bot', botMemoryScopeKey, 'read-write', botMemoryIndex),
        memoryRef('user', `profile:${row.botId}:v${row.profileVersion}`, 'read-only', userContextSource),
      ];
  let resolvedSkills = configuredSkills;
  let unavailableSkills: string[] = [];
  let catalog: BotSkillCatalogItem[] = [];
  let resolvedSkillEntries: BotSkillCatalogItem[] = [];
  let skillCatalogAvailable = true;
  let runtimeSkillMode: 'inherit' | 'allowlist' = 'allowlist';
  if (deps.listSkills) {
    try {
      catalog = await deps.listSkills({
        agentKind: opts.agentKind,
        workingDir: opts.workingDir,
        remoteHostId: opts.remoteHostId,
      });
      if (skillMode === 'inherit') {
        // Legacy "inherit" means no explicit external grants for a Bot. A Bot
        // owns Home Skills; Cindy/project/harness Skills never flow in ambiently.
        // Keep the discovered catalog only so each harness can emit explicit
        // `off` entries for every ambient Skill it would otherwise discover.
        resolvedSkillEntries = [];
        resolvedSkills = [];
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
    // Keep every discovered ambient entry so native harnesses can explicitly
    // turn unselected Skills off. A selected entry whose source could not be
    // fingerprinted stays in the catalog only as a forced-disabled row.
    const selectedNames = new Set(configuredSkills.map((item) => item.trim()));
    const fingerprintedByName = new Map<string, BotSkillCatalogItem>();
    for (const entry of fingerprinted) {
      fingerprintedByName.set(entry.name.trim(), entry);
      if (entry.runtimeCommandName?.trim()) {
        fingerprintedByName.set(entry.runtimeCommandName.trim(), entry);
      }
    }
    catalog = catalog.map((entry) => {
      const runtimeName = entry.runtimeCommandName?.trim();
      const selected = selectedNames.has(entry.name.trim())
        || (!!runtimeName && selectedNames.has(runtimeName));
      if (!selected) return entry;
      return fingerprintedByName.get(entry.name.trim())
        ?? (runtimeName ? fingerprintedByName.get(runtimeName) : undefined)
        ?? { ...entry, enabled: false, runtimeStatus: 'failed' as const };
    });
    const usableNames = new Set(
      fingerprinted.map((entry) => entry.runtimeCommandName?.trim() || entry.name.trim()),
    );
    resolvedSkills = resolvedSkills.filter((name) => usableNames.has(name));
    unavailableSkills = [...new Set(unavailableSkills)];
  }
  const runtimeConfiguredSkills = skillMode === 'allowlist' ? [...configuredSkills] : [];
  /*
    伙伴自己沉淀的技能。

    读失败不降级整个会话:一个读不出来的技能架子不该让伙伴起不来,也不该把
    「用户配的 Skill 有一条不可用」这种真降级信号稀释掉 —— 所以它既不进
    unavailableSkills,也不参与 resolutionStatus。

    同样不进下面 resolvedJson 的 `skillResources`(那是冻结漂移检查的口径):
    伙伴在任务里刚学会一个技能,紧接着要能续跑同一个任务;把自己写的文件也
    冻上,等于「一学会就再也 resume 不了」。
  */
  let ownSkills: { name: string; description: string; path: string }[] = [];
  let ownSkillPluginRoot: string | null = null;
  // SSH remote 会话的 harness 跑在远端文件系统上,本机 userData 里的技能目录
  // 在那边不存在 —— 与其挂一串打不开的路径,不如这类会话直接不挂。
  if (deps.listOwnSkills && !opts.remoteHostId) {
    try {
      const own = await deps.listOwnSkills({ botId: row.botId });
      ownSkills = own.skills;
      ownSkillPluginRoot = own.skills.length > 0 ? own.pluginRoot : null;
    } catch {
      ownSkills = [];
      ownSkillPluginRoot = null;
    }
  }
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
  // 工具集 → 内置 MCP 服务器。显式挂载 docs 的伙伴,提示词会承诺文档能力
  // (DOCS_GUIDANCE),对应服务器必须同轮进入 MCP allowlist —— 否则就是本文件
  // 开头记录的那类事故:「提示词说有,运行时够不到」。
  const TOOLSET_MCP_SERVERS: Record<string, string> = { docs: 'cindy_docs' };
  for (const toolsetId of resolvedToolsets) {
    const serverName = TOOLSET_MCP_SERVERS[toolsetId];
    if (!serverName || runtimeConfiguredMcpServers.includes(serverName)) continue;
    if (mcpCatalog.some((item) => item.name === serverName && item.available !== false)) {
      runtimeConfiguredMcpServers.push(serverName);
    }
  }
  const identity = version.identitySource.trim();
  opts.botProfilePrompt = buildBotProfilePrompt({
    displayName: profile.displayName,
    identitySource: identity,
  });
  const helperAvailable = !opts.remoteHostId || opts.agentKind === 'pi';
  // 三层装配(见 botSystemPrompt.ts):身份与「你会做什么」进稳定段,会话控制等
  // 进上下文段,技能索引与记忆快照进易变段并排在最后。能力说明按**这个伙伴
  // 实际挂载到的 toolset** 注入 —— 挂了 docs 才讲怎么做文件,没挂的一个字不提。
  const promptCapabilities: BotPromptCapabilitySignals = {
    toolsets: resolvedToolsets,
    memoryEnabled: memoryEngineEnabled && config.memory !== false,
    // Bot-to-Bot messaging is a narrow canonical-Bot capability provided by
    // the essential helper. It is not the generic Orca/team-worker surface and
    // therefore must not depend on optional toolset inheritance.
    delegationEnabled: row.role === 'canonical' && helperAvailable,
    botCreationEnabled: row.role === 'canonical' && helperAvailable,
    ownSkillsEnabled: ownSkillPluginRoot !== null,
    botModeEnabled: row.role === 'canonical',
  };
  /*
    伙伴的家。读失败一律当"没有" —— 一次读不动不该让整个伙伴起不来,只是这一轮
    它不知道自己有个家(工具面也不会多出这个目录,两边同时缺,不会出现"提示词说有、
    工具够不到"的错位)。overlay 只有真的写了才生效,且不能取代 Cindy 核心协议。
  */
  let folderPrompt: {
    homeDir: string;
    contentWritableDirs?: string[];
    systemPromptOverride: string;
  } | null = null;
  // Local userData paths are meaningless on a remote harness. Do not promise or
  // mount a Home there until the host provisions an actual remote-owned path.
  if (deps.readProfileFolder && !opts.remoteHostId) {
    folderPrompt = await deps
      .readProfileFolder({ botId: row.botId })
      .catch(() => null);
  }
  const botHomeDir = folderPrompt?.homeDir.trim() ?? '';
  // 提示词与可写工具面必须同进同退 —— 只给其中一个就是开一张打不开的空头支票。
  if (botHomeDir) {
    const mounted = withBotHomeAccess(
      opts.extraDirs,
      opts.writableDirs,
      botHomeDir,
      folderPrompt?.contentWritableDirs ?? [],
    );
    opts.extraDirs = mounted.extraDirs;
    opts.writableDirs = mounted.writableDirs;
  }
  /*
    队友名册。只在委派能力真的开着时才查 —— 关着委派的伙伴看见一份自己用不上的
    名单,是纯粹的上下文浪费。查失败当作「没有队友」,绝不拦住会话启动。
  */
  const teammates =
    promptCapabilities.botModeEnabled
      && promptCapabilities.delegationEnabled
      && deps.listTeammates
      ? await deps.listTeammates({ excludeBotId: row.botId }).catch(() => [])
      : [];
  const promptInput: BotSystemPromptInput = {
    displayName: profile.displayName,
    identity,
    capabilities: promptCapabilities,
    skillIndex: ownSkills.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
    ...(folderPrompt?.systemPromptOverride.trim()
      ? { systemPromptOverride: folderPrompt.systemPromptOverride }
      : {}),
    ...(botHomeDir ? { homeDir: botHomeDir } : {}),
    ...(teammates.length > 0 ? { teammates } : {}),
    contextSections: [
      buildBotProfileContextPrompt(profile.displayName),
      // Hermes-style Bot Mode is a property of the permanent Bot Chat only.
      // Delegation children keep Cindy's normal Session prompt plus their
      // narrow task context.
      ...(row.role === 'canonical'
        ? [buildBotCapabilityContextPrompt({ helperAvailable })]
        : []),
    ],
  };
  opts.botProfileContextPrompt = [
    buildBotStableTier({ ...promptInput, identity: '' }),
    buildBotContextTier(promptInput),
    buildBotVolatileTier(promptInput),
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
      ...(ownSkills.length > 0
        ? {
            ownSkills: ownSkills.map((item) => ({
              name: item.name,
              ...(item.description ? { description: item.description } : {}),
              path: item.path,
            })),
          }
        : {}),
      ...(ownSkillPluginRoot ? { ownSkillPluginRoots: [ownSkillPluginRoot] } : {}),
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
    mcpMode,
    mcpServers: configuredMcpServers,
    toolsetMode,
    toolsets: configuredToolsets,
  });
  const runtimeEpochSha256 = createHash('sha256').update(JSON.stringify({
    profileVersion: row.profileVersion,
    profilePrompt: opts.botProfilePrompt ?? '',
    contextPrompt: opts.botProfileContextPrompt ?? '',
    userProfilePrompt: opts.botUserProfilePrompt ?? '',
    skillResources: resolvedSkillEntries.map((entry) => ({
      name: entry.runtimeCommandName?.trim() || entry.name.trim(),
      path: entry.path?.trim() || null,
      sha256: entry.contentSha256 ?? null,
    })),
    botOwnSkillResources: ownSkills.map((entry) => ({ name: entry.name, path: entry.path })),
    mcpResources: resolvedMcpServers.map((name) => {
      const entry = mcpCatalog.find((item) => item.name === name);
      return { name, generation: entry?.generation ?? null };
    }),
    toolsetResources: resolvedToolsets.map((id) => {
      const entry = toolsetCatalog.find((item) => item.id === id);
      return { id, version: entry?.version ?? null };
    }),
  }), 'utf8').digest('hex');
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
    memoryScopeKey: opts.makerMemoryScopeKey ?? null,
    memoryRefs,
    skillResources: resolvedSkillEntries.map((entry) => ({
      name: entry.runtimeCommandName?.trim() || entry.name.trim(),
      path: entry.path?.trim() || null,
      sha256: entry.contentSha256 ?? null,
    })),
    // 刻意与 skillResources 分开:下面的漂移检查只认那三个 *Resources 键,
    // 伙伴自己写的技能不该把「刚学会就 resume 不了」变成硬错误。
    botOwnSkillResources: ownSkills.map((entry) => ({ name: entry.name, path: entry.path })),
    mcpResources: resolvedMcpServers.map((name) => {
      const entry = mcpCatalog.find((item) => item.name === name);
      return { name, generation: entry?.generation ?? null };
    }),
    toolsetResources: resolvedToolsets.map((id) => {
      const entry = toolsetCatalog.find((item) => item.id === id);
      return { id, version: entry?.version ?? null };
    }),
    runtimeEpoch: { sha256: runtimeEpochSha256 },
  });
  const [previousSnapshot] = await db
    .select({
      profileVersion: botRuntimeSnapshots.profileVersion,
      resolvedJson: botRuntimeSnapshots.resolvedJson,
    })
    .from(botRuntimeSnapshots)
    .where(
      and(
        eq(botRuntimeSnapshots.sessionId, opts.id),
        inArray(botRuntimeSnapshots.status, ['applied', 'degraded']),
      ),
    )
    .orderBy(desc(botRuntimeSnapshots.preparedAt))
    .limit(1);
  const previousResolved = previousSnapshot
    ? parseObject(previousSnapshot.resolvedJson)
    : null;
  const previousRuntimeEpoch = previousResolved
    ? parseObject(
        typeof previousResolved.runtimeEpoch === 'string'
          ? previousResolved.runtimeEpoch
          : JSON.stringify(previousResolved.runtimeEpoch ?? {}),
      )
    : null;
  const runtimeEpochChanged = row.role === 'canonical' && previousSnapshot !== undefined
    ? previousSnapshot.profileVersion !== row.profileVersion
      || previousRuntimeEpoch?.sha256 !== runtimeEpochSha256
    : false;
  if (previousSnapshot && row.role !== 'canonical') {
    if (!previousResolved) {
      throw Object.assign(
        new Error('Bot runtime snapshot is invalid'),
        { code: 'BOT_RUNTIME_SNAPSHOT_INVALID' },
      );
    }
    const currentResolved = parseObject(resolvedJson);
    for (const key of ['skillResources', 'mcpResources', 'toolsetResources'] as const) {
      if (Array.isArray(previousResolved[key])) {
        const previousFingerprint = JSON.stringify(previousResolved[key]);
        const currentFingerprint = JSON.stringify(currentResolved[key]);
        if (previousFingerprint === currentFingerprint) continue;
        throw Object.assign(
          new Error('Bot runtime resources changed after this task was frozen'),
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
    memoryRefs,
    runtimeEpochChanged,
  };
}
