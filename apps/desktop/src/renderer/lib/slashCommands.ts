/**
 * Slash command palette helper —— ChatInput `/` 三源汇总 + dispatch。
 *
 * 三源 (palette refactor) :
 *   - desktop       : main 进程 DesktopCommandRegistry, 通过 IPC 拉取
 *   - agent-builtin : agent 子类硬编码白名单, 通过 IPC 拉取
 *   - agent-skill   : agent 用户/项目目录扫描, 通过 IPC 拉取
 *
 * 三者合并成 UnifiedCommand[] 给 SlashCommandPalette 渲染。
 * dispatch 时按 cmd.kind 分流:
 *   - 'desktop'        → executeDesktopCommand IPC (main 那边广播 DESKTOP_COMMAND_TRIGGERED)
 *   - 'agent-builtin'  → 当 prompt 前缀 send 给当前 session
 *   - 'agent-skill'    → 同 agent-builtin
 *
 * 模块本身 UI-agnostic, 不依赖 React; SlashCommandPalette / ChatInput / CCAgentSessionView
 * 各自消费这里的纯函数, 方便单测。
 */

import type { UnifiedCommand, AgentKind } from '@cindy/maker-core';
import { leadingSlashInvocation } from '@cindy/maker-shared';

export { leadingSlashInvocation };

import { createLogger } from '@/lib/logger';

const log = createLogger('SlashCommands');
const shadowedUnavailableSkillsByCommands = new WeakMap<UnifiedCommand[], Set<string>>();
const ambiguousUnavailableSkillsByCommands = new WeakMap<UnifiedCommand[], Set<string>>();

export type { UnifiedCommand } from '@cindy/maker-core';

export const PI_RUNTIME_SKILL_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000] as const;

export function isSlashCommandUnavailable(command: UnifiedCommand): boolean {
  return command.kind === 'agent-skill'
    && command.scope === 'repo'
    && command.runtimeStatus === 'discovered';
}

/**
 * A discovered Pi project Skill is not executable in an existing runtime, but
 * New Maker may select it before the runtime exists. The delayed first-message
 * handoff starts Pi, refreshes the catalog until the Skill is loaded, then
 * records Pi's runtime command name separately for the send boundary.
 */
export function isSlashCommandSelectable(
  command: UnifiedCommand,
  allowPendingProjectSkillSelection = false,
): boolean {
  return !isSlashCommandUnavailable(command) || allowPendingProjectSkillSelection;
}

export function hasAvailableSlashCommand(
  commands: readonly UnifiedCommand[],
  allowPendingProjectSkillSelection = false,
): boolean {
  return commands.some((command) => (
    isSlashCommandSelectable(command, allowPendingProjectSkillSelection)
  ));
}

export interface AgentSkillInvocation {
  name: string;
  runtimeCommandName: string;
  scope: NonNullable<Extract<UnifiedCommand, { kind: 'agent-skill' }>['scope']>;
  sourcePath?: string;
}

/** Resolve an available Skill alias without changing its user-visible text. */
export function agentSkillInvocationForDispatch(
  message: string,
  command: UnifiedCommand | undefined,
): AgentSkillInvocation | undefined {
  if (
    !command
    || command.kind !== 'agent-skill'
    || !command.runtimeCommandName
    || !command.scope
    || !command.path
    || isSlashCommandUnavailable(command)
  ) {
    return undefined;
  }
  const leading = leadingSlashInvocation(message);
  if (!leading || leading.name.toLowerCase() !== command.name.toLowerCase()) return undefined;
  return {
    name: command.name,
    runtimeCommandName: command.runtimeCommandName,
    scope: command.scope,
    sourcePath: command.path,
  };
}

/** First available command index, or 0 when nothing is available/present. */
export function firstAvailableSlashCommandIndex(
  commands: readonly UnifiedCommand[],
  allowPendingProjectSkillSelection = false,
): number {
  const index = commands.findIndex((command) => (
    isSlashCommandSelectable(command, allowPendingProjectSkillSelection)
  ));
  return index >= 0 ? index : 0;
}

/** Move with wraparound while skipping unavailable discovered project skills. */
export function nextAvailableSlashCommandIndex(
  commands: readonly UnifiedCommand[],
  current: number,
  delta: 1 | -1,
  allowPendingProjectSkillSelection = false,
): number {
  if (commands.length === 0) return current;
  let index = current;
  for (let step = 0; step < commands.length; step++) {
    index = (index + delta + commands.length) % commands.length;
    if (isSlashCommandSelectable(commands[index], allowPendingProjectSkillSelection)) return index;
  }
  return current;
}

export type SlashCommandRosterStatus = 'loading' | 'refreshing' | 'ready' | 'error';

export interface SlashCommandRosterState {
  contextKey: string;
  status: SlashCommandRosterStatus;
  commands: UnifiedCommand[];
}

/** Stable empty roster for initial and cross-context renders. */
export const EMPTY_SLASH_COMMANDS: UnifiedCommand[] = [];

export function beginSlashCommandRosterLoad(
  current: SlashCommandRosterState,
  contextKey: string,
): SlashCommandRosterState {
  if (
    current.contextKey === contextKey &&
    (current.status === 'ready' || current.status === 'refreshing')
  ) {
    return { ...current, status: 'refreshing' };
  }
  return { contextKey, status: 'loading', commands: EMPTY_SLASH_COMMANDS };
}

export function failSlashCommandRosterLoad(
  current: SlashCommandRosterState,
  contextKey: string,
): SlashCommandRosterState {
  if (current.contextKey === contextKey && current.status === 'refreshing') {
    return { ...current, status: 'ready' };
  }
  return { contextKey, status: 'error', commands: EMPTY_SLASH_COMMANDS };
}

export function isSlashCommandRosterReady(
  state: SlashCommandRosterState,
  contextKey: string,
): boolean {
  return (
    state.contextKey === contextKey &&
    (state.status === 'ready' || state.status === 'refreshing')
  );
}

// device-link 远程会话下 desktop 命令**全量可用**:业务语义在「会话归属设备」的命令
// (/goal /learn /cmd)由控制端 main(commands/builtins.ts)按 ctx.deviceId 经隧道路由
// 到被控端对应 channel(maker:goal:* / learn:* / desktop-cmd:run,均在 REMOTE_INVOKE_ALLOWLIST);
// 纯控制端 UI 命令(/help /clear /workflows /jump-session /issue)本就与会话归属无关。
// 历史上这里有一张 DEVICE_LINK_UNAVAILABLE 黑名单(goal/learn,reviewer #354 / Codex #483
// 时代控制端还没有隧道路由)—— 隧道链路打通后已删除;被控端版本过旧不支持对应 channel 时,
// main 会广播 error: 'remote-unsupported',renderer toast 提示,不再静默剔除命令。

/**
 * 合并三源 → UnifiedCommand[]。
 * 优先级 (同名时谁覆盖谁) : agent-skill > desktop > agent-builtin。
 *   - agent-skill (用户自定义) 排第一: 体现"用户能盖默认"的语义
 *   - desktop 第二: app 内置功能 (/help, /clear)
 *   - agent-builtin 兜底: agent 自带 (/compact)
 *
 * 同一类目内按 name 字母序; 不同类目之间按上述优先级排。
 */
export function mergeCommands(
  desktop: UnifiedCommand[],
  agentBuiltin: UnifiedCommand[],
  agentSkill: UnifiedCommand[],
): UnifiedCommand[] {
  const seen = new Set<string>();
  const result: UnifiedCommand[] = [];
  const shadowedUnavailableSkills = new Set<string>();
  const availableSkills = agentSkill.filter((command) => !isSlashCommandUnavailable(command));
  const unavailableSkills = agentSkill.filter((command): command is Extract<
    UnifiedCommand,
    { kind: 'agent-skill' }
  > => isSlashCommandUnavailable(command));
  const unavailableProjectSkillPaths = new Map<string, Set<string>>();
  for (const command of unavailableSkills) {
    const normalizedName = command.name.toLowerCase();
    const paths = unavailableProjectSkillPaths.get(normalizedName) ?? new Set<string>();
    paths.add(command.path ?? '');
    unavailableProjectSkillPaths.set(normalizedName, paths);
  }
  const ambiguousUnavailableSkills = new Set(
    [...unavailableProjectSkillPaths]
      .filter(([, paths]) => paths.size > 1 || paths.has(''))
      .map(([name]) => name),
  );
  for (const name of ambiguousUnavailableSkills) shadowedUnavailableSkills.add(name);
  const tiers: UnifiedCommand[][] = [
    availableSkills.sort((a, b) => a.name.localeCompare(b.name)),
    [...desktop].sort((a, b) => a.name.localeCompare(b.name)),
    [...agentBuiltin].sort((a, b) => a.name.localeCompare(b.name)),
    unavailableSkills.sort((a, b) => a.name.localeCompare(b.name)),
  ];
  for (const tier of tiers) {
    for (const cmd of tier) {
      const normalizedName = cmd.name.toLowerCase();
      if (isSlashCommandUnavailable(cmd) && ambiguousUnavailableSkills.has(normalizedName)) {
        continue;
      }
      if (seen.has(normalizedName)) {
        if (isSlashCommandUnavailable(cmd)) {
          shadowedUnavailableSkills.add(normalizedName);
        } else {
          log.warn(`Slash command "/${cmd.name}" already provided by higher-priority tier; skipping ${cmd.kind}.`);
        }
        continue;
      }
      seen.add(normalizedName);
      result.push(cmd);
    }
  }
  if (shadowedUnavailableSkills.size > 0) {
    shadowedUnavailableSkillsByCommands.set(result, shadowedUnavailableSkills);
  }
  const unresolvedAmbiguousSkills = new Set(
    [...ambiguousUnavailableSkills].filter((name) => (
      !result.some((command) => command.name.toLowerCase() === name)
    )),
  );
  if (unresolvedAmbiguousSkills.size > 0) {
    ambiguousUnavailableSkillsByCommands.set(result, unresolvedAmbiguousSkills);
  }
  return result;
}

/** Reject a typed project Skill alias whose source path cannot be selected uniquely. */
export function ambiguousPendingProjectSkillName(
  message: string,
  commands: UnifiedCommand[],
  allowPendingProjectSkillSelection = false,
): string | undefined {
  if (!allowPendingProjectSkillSelection) return undefined;
  const name = leadingSlashInvocation(message)?.name.toLowerCase();
  return name && ambiguousUnavailableSkillsByCommands.get(commands)?.has(name)
    ? name
    : undefined;
}

type PendingProjectSkillCommand = Extract<UnifiedCommand, { kind: 'agent-skill' }> & {
  path: string;
};

/** Resolve a typed or palette-inserted project Skill alias to one exact discovery path. */
export function pendingProjectSkillForMessage(
  message: string,
  commands: UnifiedCommand[],
  allowPendingProjectSkillSelection = false,
): PendingProjectSkillCommand | undefined {
  if (!allowPendingProjectSkillSelection) return undefined;
  const name = leadingSlashInvocation(message)?.name.toLowerCase();
  if (!name || ambiguousPendingProjectSkillName(message, commands, true)) return undefined;
  const matches = commands.filter((command): command is PendingProjectSkillCommand => (
    command.kind === 'agent-skill'
    && isSlashCommandUnavailable(command)
    && command.name.toLowerCase() === name
    && typeof command.path === 'string'
    && command.path.length > 0
  ));
  const sourcePaths = new Set(matches.map((command) => command.path));
  return sourcePaths.size === 1 ? matches[0] : undefined;
}

function hasShadowedUnavailableSkill(
  commands: UnifiedCommand[],
  commandName: string,
): boolean {
  return shadowedUnavailableSkillsByCommands.get(commands)?.has(commandName.toLowerCase()) ?? false;
}

export function hasUnavailableProjectSkillPreview(commands: UnifiedCommand[]): boolean {
  return commands.some(isSlashCommandUnavailable)
    || (shadowedUnavailableSkillsByCommands.get(commands)?.size ?? 0) > 0;
}

/**
 * 包含过滤(case-insensitive); 精确匹配优先,其次是前缀匹配,最后是普通包含匹配。
 *
 * `/`、`$` 两类命令都复用这套筛选，输入命令中间的关键词也能命中，
 * 与 `@` 资源面板的搜索体验保持一致。
 */
export function filterSlashCommands(
  commands: UnifiedCommand[],
  query: string,
  limit = 25,
): UnifiedCommand[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands
        .map((command, index) => {
          const name = command.name.toLowerCase();
          const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
          return { command, index, rank };
        })
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.command)
    : commands;
  return filtered.length > limit ? filtered.slice(0, limit) : filtered;
}

/**
 * 拉三路 IPC, 合并成 UnifiedCommand[]。
 *
 * - 任何一路失败按空列表处理(已在 main 端做 try/catch + 返回 success:false), 不阻塞 palette。
 * - workingDir 为空时 Claude 仍扫描全局 skills。
 * - SSH remote 由 opts.skipAgentSkills 显式禁用扫描,避免读取控制端本机 skills。
 */
export async function loadAllCommands(
  agentKind: AgentKind,
  workingDir: string | null | undefined,
  opts?: { forceReload?: boolean; skipAgentSkills?: boolean; sessionId?: string },
  deviceId?: string,
): Promise<UnifiedCommand[]> {
  const api = window.electronAPI.maker;
  // 用 unknown[] 收口三源的不同原生形状(隧道返 unknown、本地返各自命令/技能类型),
  // 末尾统一 `as UnifiedCommand[]`(与改造前同款收口)。
  type CmdRes = { success: boolean; commands?: unknown[] };
  type SkillRes = { success: boolean; skills?: unknown[] };

  // device-link「以被控端为准」:agent-builtin / agent-skill 是被控端**该会话**的能力,远程时经隧道
  // 从被控端读(channel 已 allowlist,workingDir 是被控端路径,扫描在被控端跑正确)。
  // desktop 命令**始终本地** —— 它是控制端 app 的 UI 动作(execute-desktop-command 不可隧道,见 D2)。
  const desktopP: Promise<CmdRes> = api.listDesktopCommands().catch(() => ({ success: false }));
  const builtinP: Promise<CmdRes> = (
    deviceId
      ? (window.electronAPI.deviceLink.invoke(deviceId, 'maker:list-agent-commands', [agentKind]) as Promise<CmdRes>)
      : api.listAgentCommands(agentKind)
  ).catch(() => ({ success: false }));
  const shouldLoadSkills = !opts?.skipAgentSkills;
  const skillParams = {
    ...(workingDir ? { workingDir } : {}),
    ...(opts?.forceReload !== undefined ? { forceReload: opts.forceReload } : {}),
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
  };
  const skillP: Promise<SkillRes> = shouldLoadSkills
    ? (
        deviceId
          ? (window.electronAPI.deviceLink.invoke(deviceId, 'maker:list-agent-skills', [
              agentKind,
              skillParams,
            ]) as Promise<SkillRes>)
          : api.listAgentSkills(agentKind, skillParams)
      ).catch(() => ({ success: false }))
    : Promise.resolve({ success: true, skills: [] });

  const [desktopRes, builtinRes, skillRes] = await Promise.all([desktopP, builtinP, skillP]);

  const desktop = (desktopRes.success && desktopRes.commands ? desktopRes.commands : []) as UnifiedCommand[];
  const agentBuiltin = (builtinRes.success && builtinRes.commands ? builtinRes.commands : []) as UnifiedCommand[];
  const agentSkill = (skillRes.success && skillRes.skills ? skillRes.skills : []) as UnifiedCommand[];
  return mergeCommands(desktop, agentBuiltin, agentSkill);
}

function isPiUserSkillAwaitingRuntimeProof(
  command: UnifiedCommand | undefined,
): boolean {
  return command?.kind === 'agent-skill'
    && command.scope === 'user'
    && command.runtimeStatus !== 'loaded';
}

/**
 * A Pi runtime catalog may finish after the palette/dispatch snapshot was
 * created. Recheck desktop hits before executing them so a newly loaded
 * same-name project skill keeps command ownership.
 */
export async function reconcilePiRuntimeCommandForDispatch(params: {
  agentKind: AgentKind;
  sessionId?: string;
  commandName: string;
  commands: UnifiedCommand[];
  reload: () => Promise<UnifiedCommand[]>;
}): Promise<{ command: UnifiedCommand | undefined; commands: UnifiedCommand[] }> {
  const findCommand = (commands: UnifiedCommand[]) => commands.find(
    (command) => command.name.toLowerCase() === params.commandName.toLowerCase(),
  );
  const current = findCommand(params.commands);
  const shouldReload = !current
    || current.kind === 'desktop'
    || isSlashCommandUnavailable(current)
    || isPiUserSkillAwaitingRuntimeProof(current);
  if (params.agentKind !== 'pi' || !params.sessionId || !shouldReload) {
    return { command: current, commands: params.commands };
  }
  try {
    const refreshed = await params.reload();
    const refreshedCommand = findCommand(refreshed);
    return refreshedCommand || !current
      ? { command: refreshedCommand, commands: refreshed }
      : { command: current, commands: params.commands };
  } catch {
    return { command: current, commands: params.commands };
  }
}

export async function reconcilePiRuntimeCommandForDispatchWithRetry(params: {
  agentKind: AgentKind;
  sessionId?: string;
  commandName: string;
  commands: UnifiedCommand[];
  reload: () => Promise<UnifiedCommand[]>;
  prepareRuntime?: () => Promise<void>;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<{ command: UnifiedCommand | undefined; commands: UnifiedCommand[] }> {
  if (params.agentKind !== 'pi' || !params.sessionId) {
    return reconcilePiRuntimeCommandForDispatch(params);
  }
  const retryDelaysMs = params.retryDelaysMs ?? PI_RUNTIME_SKILL_RETRY_DELAYS_MS;
  const sleep = params.sleep ?? ((delayMs: number) => new Promise<void>(
    (resolve) => window.setTimeout(resolve, delayMs),
  ));
  const current = params.commands.find(
    (command) => command.name.toLowerCase() === params.commandName.toLowerCase(),
  );
  const shouldPrepareRuntime = !current
    || current.kind === 'desktop'
    || isSlashCommandUnavailable(current)
    || isPiUserSkillAwaitingRuntimeProof(current);
  if (
    params.agentKind === 'pi'
    && params.sessionId
    && params.prepareRuntime
    && shouldPrepareRuntime
  ) {
    await params.prepareRuntime();
  }
  let result = await reconcilePiRuntimeCommandForDispatch(params);
  for (const delayMs of retryDelaysMs) {
    const shouldRetry = result.command !== undefined && (
      isSlashCommandUnavailable(result.command)
      || isPiUserSkillAwaitingRuntimeProof(result.command)
      || (
        result.command.kind === 'desktop'
        && hasShadowedUnavailableSkill(result.commands, params.commandName)
      )
    );
    if (!shouldRetry) return result;
    await sleep(delayMs);
    result = await reconcilePiRuntimeCommandForDispatch({
      ...params,
      commands: result.commands,
    });
  }
  return result;
}

function normalizeProjectSkillPath(value: string): { path: string; windows: boolean } | null {
  if (!value || value.includes('\0')) return null;
  const withoutLongPrefix = value.startsWith('\\\\?\\UNC\\')
    ? `//${value.slice('\\\\?\\UNC\\'.length)}`
    : value.startsWith('\\\\?\\')
      ? value.slice('\\\\?\\'.length)
      : value;
  const windows = /^[A-Za-z]:[\\/]/.test(withoutLongPrefix)
    || withoutLongPrefix.startsWith('\\\\')
    || withoutLongPrefix.startsWith('//');
  let normalized = withoutLongPrefix.replace(/\\/g, '/');
  const prefix = normalized.startsWith('//') ? '//' : '';
  normalized = prefix + normalized.slice(prefix.length).replace(/\/+/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(normalized)) break;
    normalized = normalized.slice(0, -1);
  }
  // No host comparison identity reaches this renderer-only worktree helper.
  // Preserve case so Windows case-sensitive directories fail closed instead
  // of binding a different Skill that differs only by case.
  return { path: normalized, windows };
}

function projectRelativeSkillPath(projectRoot: string, skillPath: string): string | null {
  const root = normalizeProjectSkillPath(projectRoot);
  const skill = normalizeProjectSkillPath(skillPath);
  if (!root || !skill || root.windows !== skill.windows) return null;
  if (skill.path === root.path) return '';
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
  return skill.path.startsWith(prefix) ? skill.path.slice(prefix.length) : null;
}

export function isSameProjectSkillAcrossRoots(params: {
  sourceProjectRoot: string;
  sourceSkillPath: string;
  targetProjectRoot: string;
  targetSkillPath: string;
}): boolean {
  const sourceRelative = projectRelativeSkillPath(
    params.sourceProjectRoot,
    params.sourceSkillPath,
  );
  const targetRelative = projectRelativeSkillPath(
    params.targetProjectRoot,
    params.targetSkillPath,
  );
  return sourceRelative !== null && sourceRelative === targetRelative;
}

/**
 * New Maker can select a discovered Pi project Skill before a runtime exists.
 * Worktree creation changes the physical project root, so that first message
 * must be rebound against the newly created directory instead of trusting the
 * palette snapshot from the base repository.
 */
export async function resolvePendingPiProjectSkillForDispatch(params: {
  sessionId: string;
  commandName: string;
  reload: () => Promise<UnifiedCommand[]>;
  prepareRuntime: () => Promise<void>;
  sourceProjectRoot: string;
  sourceSkillPath: string;
  targetProjectRoot: string;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<AgentSkillInvocation | null> {
  const retryDelaysMs = params.retryDelaysMs ?? PI_RUNTIME_SKILL_RETRY_DELAYS_MS;
  const sleep = params.sleep ?? ((delayMs: number) => new Promise<void>(
    (resolve) => window.setTimeout(resolve, delayMs),
  ));
  type LoadedProjectSkill = Extract<UnifiedCommand, { kind: 'agent-skill' }> & {
    scope: 'repo';
    path: string;
    runtimeCommandName: string;
  };
  const findLoadedTarget = (commands: UnifiedCommand[]) => commands.find((candidate): candidate is LoadedProjectSkill => (
    candidate.kind === 'agent-skill'
    && candidate.name.toLowerCase() === params.commandName.toLowerCase()
    && candidate.scope === 'repo'
    && candidate.runtimeStatus === 'loaded'
    && !!candidate.path
    && isSameProjectSkillAcrossRoots({
      sourceProjectRoot: params.sourceProjectRoot,
      sourceSkillPath: params.sourceSkillPath,
      targetProjectRoot: params.targetProjectRoot,
      targetSkillPath: candidate.path,
    })
  ));

  await params.prepareRuntime();
  let commands = await params.reload();
  let command = findLoadedTarget(commands);
  for (const delayMs of retryDelaysMs) {
    if (command) break;
    await sleep(delayMs);
    commands = await params.reload();
    command = findLoadedTarget(commands);
  }
  if (!command?.runtimeCommandName) return null;
  return {
    name: command.name,
    runtimeCommandName: command.runtimeCommandName,
    scope: command.scope,
    sourcePath: command.path,
  };
}

/**
 * A New Maker worktree sends its first turn directly, before SessionView can
 * reconcile aliases. Bind a selected user Skill to the exact path that the
 * newly started Pi session re-discovers; a same-name Skill from another
 * directory is not an acceptable replacement. Main remains the final loaded
 * provenance authority when the receipt reaches the dispatch fence.
 */
export async function resolvePendingPiUserSkillForDispatch(params: {
  message: string;
  pendingInvocation: AgentSkillInvocation;
  reload: () => Promise<UnifiedCommand[]>;
  prepareRuntime: () => Promise<void>;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<AgentSkillInvocation | null> {
  if (
    params.pendingInvocation.scope !== 'user'
    || !params.pendingInvocation.sourcePath
  ) return null;
  const retryDelaysMs = params.retryDelaysMs ?? PI_RUNTIME_SKILL_RETRY_DELAYS_MS;
  const sleep = params.sleep ?? ((delayMs: number) => new Promise<void>(
    (resolve) => window.setTimeout(resolve, delayMs),
  ));
  const findLoadedTarget = (commands: UnifiedCommand[]) => commands.find((candidate) => (
    candidate.kind === 'agent-skill'
    && candidate.scope === 'user'
    && candidate.name.toLowerCase() === params.pendingInvocation.name.toLowerCase()
    && candidate.path === params.pendingInvocation.sourcePath
    && !!candidate.runtimeCommandName
  ));

  await params.prepareRuntime();
  let command = findLoadedTarget(await params.reload());
  for (const delayMs of retryDelaysMs) {
    if (command) break;
    await sleep(delayMs);
    command = findLoadedTarget(await params.reload());
  }
  return agentSkillInvocationForDispatch(params.message, command) ?? null;
}

/**
 * A draft Pi Skill session is not user-owned until its exact runtime receipt
 * exists. Roll it back durably and in order; never hide a session locally when
 * Main or the database failed to release it.
 */
export async function rollbackUnclaimedPiProjectSkillSession(params: {
  sessionId: string;
  closeRuntime: () => Promise<void>;
  markDeleted: () => Promise<void>;
  patchDeleted: () => void;
  purgeRuntimeState: () => void;
}): Promise<void> {
  await params.closeRuntime();
  await params.markDeleted();
  params.patchDeleted();
  params.purgeRuntimeState();
}

/**
 * Dispatch context —— 调用方(handleSend)透传 session 上下文给 main。
 * desktop 命令的 execute 拿到这些信息决定怎么响应。
 */
export interface DispatchContext {
  sessionId?: string;
  workingDir?: string;
  /** `/name args...` 中 name 后面的剩余文本; 没有则空串。 */
  args?: string;
  /** device-link 远程会话的归属设备 id(本机会话缺省)。main 侧 /goal /learn /cmd
   *  据此把业务体经隧道路由到被控端执行。 */
  deviceId?: string;
}

/**
 * Dispatch 一条命中的命令 ——
 *   - 'desktop'        → executeDesktopCommand IPC, 不 send 给 agent
 *   - 'agent-builtin'  → 调 sendToAgent 把 `/name args` 当 prompt 前缀发出去
 *   - 'agent-skill'    → 同 agent-builtin
 *
 * 返回 'handled-locally' 表示已处理(调用方应阻止默认 send 行为);
 * 返回 'forward-to-agent' 表示让调用方继续走默认 send 路径。
 */
export type DispatchResult = 'handled-locally' | 'forward-to-agent';

export async function dispatchCommand(
  cmd: UnifiedCommand,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  if (cmd.kind === 'desktop') {
    try {
      await window.electronAPI.maker.executeDesktopCommand(cmd.name, {
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
        ...(ctx.args ? { args: ctx.args } : {}),
        ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
      });
    } catch (err) {
      log.warn(
        `executeDesktopCommand /${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return 'handled-locally';
  }
  // agent-builtin / agent-skill —— 让调用方把原文 send 出去, 自己不动
  return 'forward-to-agent';
}
