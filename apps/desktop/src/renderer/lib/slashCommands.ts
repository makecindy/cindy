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

import { createLogger } from '@/lib/logger';

const log = createLogger('SlashCommands');

export type { UnifiedCommand } from '@cindy/maker-core';

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
  const tiers: UnifiedCommand[][] = [
    [...agentSkill].sort((a, b) => a.name.localeCompare(b.name)),
    [...desktop].sort((a, b) => a.name.localeCompare(b.name)),
    [...agentBuiltin].sort((a, b) => a.name.localeCompare(b.name)),
  ];
  for (const tier of tiers) {
    for (const cmd of tier) {
      if (seen.has(cmd.name)) {
        log.warn(`Slash command "/${cmd.name}" already provided by higher-priority tier; skipping ${cmd.kind}.`);
        continue;
      }
      seen.add(cmd.name);
      result.push(cmd);
    }
  }
  return result;
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
  opts?: { forceReload?: boolean; skipAgentSkills?: boolean },
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
