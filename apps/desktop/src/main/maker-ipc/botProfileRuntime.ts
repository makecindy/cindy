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
import { normalizeBotAutomation } from '../../shared/botAutomationCapability.js';
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
  /**
   * 全局 Maker Memory 引擎是否可用(host 注入 `makerMemory.isEnabled()`)。
   *
   * Bot 的 `memory` 能力位只能**收窄**注入,不能放大:`cindy_memory` MCP server
   * 的注册(mcp-providers 的 `isEnabled`)与 store 的打开(manager.getStore 的
   * disabled 检查)都由全局开关决定。全局关着时若仍把 `makerMemoryEnabled` 抬成
   * true, prompt 会告诉伙伴「你有持久记忆,去调 cindy_memory」,而工具面根本没有
   * 那个 server —— 典型的空头支票。缺省(未注入)按既有行为不收窄。
   */
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
   * 伙伴家里那些摊开的文件(`botProfileFolder.ts`)。
   *
   * 只取**提示词要用的那几样**:整段覆盖、知识与偏好的条目名、还没做完的事。
   * 身份与用户画像不走这里 —— 它们已经由对账收进冻结快照,运行时认的是快照,
   * 从文件再读一遍会让同一轮里出现两个版本的身份。
   *
   * 远端会话拿不到本机路径,由调用方自行不注入。
   */
  readProfileFolder?: (input: { botId: string }) => Promise<{
    systemPromptOverride: string;
    knowledge: string[];
    preferences: string[];
    todo: unknown[];
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
export function buildBotCapabilityContextPrompt(): string {
  return [
    '## Cindy Bot Runtime',
    'You are running as a Cindy Bot with a durable Profile. This task is one active runtime of that Bot, not an ordinary standalone task.',
    'Before claiming that Cindy cannot do something, inspect the current tool surface. Use `list_tools` to discover the relevant capability category and only report a capability as unavailable after checking the live result.',
    'Cindy Bot collaboration can discover other available Bots, hand off a bounded objective to one of them, receive the result back in this task, inspect ongoing or completed handoffs, and cancel a handoff that is still active.',
    'A Bot handoff is task delegation with a result return path. It does not rewrite another Bot\'s identity or make that Bot obey. If the user asks for obedience or control, explain this boundary and immediately offer the available delegation path instead of redirecting them to a separate team workflow.',
    'When you finish something and a reusable way of working came out of it — a habit worth keeping, not a fact about the user — record it in your own memory with a `learned-` name prefix (for example `learned-weekly-report-shape`). Everything else you remember keeps its ordinary name. Both stay in your memory; the prefix only tells the two apart when they are shown to the user.',
    'After you finish a multi-step task of a kind you have not handled before, turn the way you did it into one of your own skills with `save_bot_skill`: write the repeatable steps, not this run\'s conclusions. Check `list_bot_skills` first — if you already have one for this kind of task, use it as your starting point and save it again under the same name when you find a better way. A saved skill is mounted from your next task onward, so do not expect to call it in this one.',
  ].join('\n');
}

/**
 * `todo.json` → 提示词里的一行行文字。
 *
 * 容两种写法:纯字符串,或 `{ text, done }` 这样的对象(已完成的不进提示词 ——
 * 那是干扰,不是待办)。认不出的条目直接丢掉,不猜。
 */
export function readOpenTodos(items: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.done === true || row.completed === true) continue;
    const text = typeof row.text === 'string' ? row.text : typeof row.title === 'string' ? row.title : '';
    if (text.trim()) out.push(text.trim());
  }
  return out.slice(0, 50);
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
  // 只收窄不放大 —— 理由见 BotProfileRuntimeDeps.isMemoryEngineEnabled。
  const memoryEngineEnabled = deps.isMemoryEngineEnabled?.() ?? true;
  if (typeof config.memory === 'boolean') {
    opts.makerMemoryEnabled = config.memory && memoryEngineEnabled;
  } else if (!memoryEngineEnabled) {
    opts.makerMemoryEnabled = false;
  }
  const botMemoryScopeKey = buildBotMemoryScopeKey(row.botId);
  if (config.memory !== false) opts.makerMemoryScopeKey = botMemoryScopeKey;
  const projectMemoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
  // 引擎关着时不去读索引:getStore 会因 disabled 检查抛错,把每一次 Bot 会话都
  // 标成 degraded —— 那不是运行时解析降级,只是用户自己关了全局记忆开关。
  const memoryActive = config.memory !== false && memoryEngineEnabled;
  let botMemoryIndex: string | null = '';
  let projectMemoryIndex: string | null = '';
  if (memoryActive && deps.readMemoryIndex) {
    const [botMemory, projectMemory] = await Promise.allSettled([
      deps.readMemoryIndex(botMemoryScopeKey),
      deps.readMemoryIndex(projectMemoryScopeKey),
    ]);
    botMemoryIndex = botMemory.status === 'fulfilled' ? botMemory.value : null;
    projectMemoryIndex = projectMemory.status === 'fulfilled' ? projectMemory.value : null;
    opts.makerMemoryIndexSnapshot = [
      formatMemorySnapshot(
        'Bot Memory',
        botMemoryIndex ?? '',
        'This is your own durable memory. `memory_read` / `memory_search` / `memory_write` all operate on it.',
      ),
      formatMemorySnapshot(
        'Project Memory (read-only excerpt)',
        projectMemoryIndex ?? '',
        // 诚实标注:cindy_memory 的 store 由 ctx.memoryScopeKey 定位, Bot 会话恒为
        // 自己的记忆空间 —— 下面这些条目**打不开**(memory_read 会 NOT_FOUND)。
        // 不写清楚的话模型会照着索引去 read, 拿到一串 NOT_FOUND(空头支票)。
        'Context only, from this project workdir. These entries are NOT in your memory store: `memory_read` / `memory_search` cannot open them, and you cannot write here.',
      ),
    ].filter(Boolean).join('\n\n');
  }
  const userContextSource = typeof config.userContextSource === 'string'
    ? config.userContextSource
    : '';
  opts.botUserProfilePrompt = buildBotUserProfilePrompt(userContextSource);
  const memoryRefs: BotMemoryRuntimeRef[] = !memoryActive
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
  const identity = version.identitySource.trim();
  opts.botProfilePrompt = buildBotProfilePrompt({
    displayName: profile.displayName,
    identitySource: identity,
  });
  const sessionControlMode = normalizeBotSessionControlMode(config.sessionControlMode);
  // 三层装配(见 botSystemPrompt.ts):身份与「你会做什么」进稳定段,会话控制等
  // 进上下文段,技能索引与记忆快照进易变段并排在最后。能力说明按**这个伙伴
  // 实际挂载到的 toolset** 注入 —— 挂了 docs 才讲怎么做文件,没挂的一个字不提。
  const promptCapabilities: BotPromptCapabilitySignals = {
    toolsets: resolvedToolsets,
    memoryEnabled: memoryEngineEnabled && config.memory !== false,
    // 委派工具(delegate_to_bot / list_bots / cancel_bot_delegation)住在
    // cindy_helper 里,它是 essential 插件、恒挂 —— 所以判据是它在不在工具面,
    // 不是会话控制模式(那管的是"观察别的任务",另一件事)。
    delegationEnabled: resolvedToolsets.includes('xdt_helper'),
    ownSkillsEnabled: ownSkillPluginRoot !== null,
  };
  /*
    家里那几样进提示词。读失败一律当"没有" —— 一个读不动的 knowledge 目录不该
    让整个伙伴起不来。整段覆盖只有真的写了才生效。
  */
  let folderPrompt: {
    systemPromptOverride: string;
    knowledge: string[];
    preferences: string[];
    todo: unknown[];
  } | null = null;
  if (deps.readProfileFolder) {
    folderPrompt = await deps
      .readProfileFolder({ botId: row.botId })
      .catch(() => null);
  }
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
    ...(folderPrompt?.knowledge.length ? { knowledgeFiles: folderPrompt.knowledge } : {}),
    ...(folderPrompt?.preferences.length ? { preferenceFiles: folderPrompt.preferences } : {}),
    ...(folderPrompt?.todo.length ? { openTodos: readOpenTodos(folderPrompt.todo) } : {}),
    contextSections: [
      buildBotProfileContextPrompt(profile.displayName),
      buildBotSessionControlContext(sessionControlMode),
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
    automation: normalizeBotAutomation(config.automation),
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
