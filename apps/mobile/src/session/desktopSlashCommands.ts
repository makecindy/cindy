/**
 * desktopSlashCommands.ts — 移动端「desktop 自有 slash 命令」的纯逻辑层。
 * ---------------------------------------------------------------------------
 * 背景:palette 的 `/` 命令有三源(agent-builtin / agent-skill / desktop)。前两类
 * 移动端一直支持(原样转发给 agent,SDK 认识);desktop 命令(/learn /goal /cmd 等)
 * 由宿主执行、绝不发给 agent——移动端此前完全没有这一类:面板不展示,手打
 * `/learn xxx` 会被当普通文本透传给 agent 静默无效。
 *
 * 移动端不能走桌面的 `maker:execute-desktop-command`(device-link allowlist 永久
 * 禁止,UI 副作用),必须像桌面远程会话一样按命令名直调具体业务通道(/learn →
 * `learn:start`)。因此这里维护一份「移动端可执行」白名单:palette 只展示白名单内
 * 的 desktop 命令,发送侧按白名单分流——列表加载失败/未加载不影响白名单判定
 * (代码确定性优先);已加载清单只用于「同名 agent-skill 优先让行」的重名仲裁。
 *
 * 纯函数、无 RN 依赖,node 可单测。
 */
import type { MobileLearnStartRequest, MobileSlashCommand } from '@/device-link/mobileMakerTransport';

/**
 * 移动端可执行的 desktop 命令白名单。只放行已实现分流的命令:
 * - learn:直调被控端 `learn:start`(评审 UI 暂在桌面端,移动端出系统卡提示)。
 * 其余 desktop 命令(/help /clear /issue /workflows /jump-session 等)是控制端
 * UI 动作,移动端没有对应实现,展示了也执行不了 → 不放行。
 */
export const MOBILE_SUPPORTED_DESKTOP_COMMANDS: ReadonlySet<string> = new Set(['learn']);

/** palette 展示用:被控端 desktop 命令清单 → 只保留移动端可执行子集。 */
export function filterMobileDesktopCommands(
  commands: readonly MobileSlashCommand[],
): MobileSlashCommand[] {
  return commands.filter(
    (command) => command.kind === 'desktop' && MOBILE_SUPPORTED_DESKTOP_COMMANDS.has(command.name),
  );
}

export interface ParsedDesktopSlashCommand {
  name: string;
  /** `/name` 之后的剩余参数文本(去掉首个空白,可为空串)。 */
  args: string;
}

/**
 * 发送侧分流判定:文本是否命中移动端可执行的 desktop 命令。
 * 只认「/名字 + 可选参数」形态;名字不在白名单 → null(照常走 enqueue)。
 * 重名让行:用户自装的同名 agent-skill 优先(与桌面 dispatch 语义一致——palette
 * 合并展示的也是 skill),已加载清单里有同名 skill 时返回 null 让文本原样转发给
 * agent;清单未加载 / 拉取失败时(空数组)按白名单拦截,保证 /learn 不静默失效。
 */
export function parseMobileDesktopCommand(
  text: string,
  loadedCommands: readonly MobileSlashCommand[] = [],
): ParsedDesktopSlashCommand | null {
  const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !MOBILE_SUPPORTED_DESKTOP_COMMANDS.has(match[1])) return null;
  const name = match[1];
  const shadowedBySkill = loadedCommands.some(
    (command) => command.kind === 'agent-skill' && command.name.toLowerCase() === name,
  );
  if (shadowedBySkill) return null;
  return { name, args: (match[2] ?? '').trim() };
}

/**
 * `/learn [hub:[market|team:]<slug>] [要求]` → learn:start 请求。语义对齐桌面 builtins.ts:
 * - `hub:<slug>` 前缀 → 公开目录 hub 蒸馏(slug 规则 [a-z0-9-],与市场一致);
 * - `hub:<scope>:<slug>` → 显式目录 hub 蒸馏;
 * - 有参数 → freetext;无参数 → 蒸馏当前会话(session)。
 * 移动端总在会话内触发,originSessionId 恒有值,因此裸 /learn 不需要桌面
 * 草稿态的 usage 报错分支。
 */
export function buildLearnStartRequest(args: string, sessionId: string): MobileLearnStartRequest {
  const arg = args.trim();
  const hubMatch = /^hub:(?:(market|team):)?([a-z0-9][a-z0-9-]*)\s*/.exec(arg);
  if (hubMatch) {
    return {
      input: arg.slice(hubMatch[0].length).trim(),
      sourceKind: 'hub',
      hubSlug: hubMatch[2],
      hubCatalogScope: (hubMatch[1] as 'market' | 'team' | undefined) ?? 'market',
      originSessionId: sessionId,
    };
  }
  return {
    input: arg,
    sourceKind: arg ? 'freetext' : 'session',
    originSessionId: sessionId,
  };
}

/**
 * learn 启动结果 → 系统卡数据。错误码从隧道 message 的 `[CODE] ...` 编码里抽
 * (learn-host 的 LearnError 经 device-link 序列化为该形态)。
 */
export function buildLearnCardData(
  outcome: { runId: string } | { errorMessage: string },
): Record<string, unknown> {
  if ('runId' in outcome) {
    return { runId: outcome.runId };
  }
  const codeMatch = /^\[([A-Z0-9_]+)\]/.exec(outcome.errorMessage.trim());
  return {
    error: codeMatch?.[1] === 'LEARN_BUSY' ? 'learn-busy' : 'learn-failed',
    detail: outcome.errorMessage,
  };
}
