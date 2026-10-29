import { getBotPromptCopy } from './botSystemPromptCopy.js';

/**
 * botSystemPrompt —— 伙伴系统提示词的三层装配。
 * ---------------------------------------------------------------------------
 * 结构照搬 Hermes Agent(MIT, Nous Research)的 system-prompt 装配法,文本全部
 * 是 Cindy 自己的。照搬的是这三条机制,不是它的 prompt 内容:
 *
 *   1. **三层分离**:stable(身份 + 长期不变的行为准则与能力说明) /
 *      context(本次会话的上下文) / volatile(技能索引、记忆快照这些会变的)。
 *      易变的排在最后,前缀缓存才不会被一次技能改动整段冲掉。
 *   2. **能力说明按「实际挂载的工具」逐块注入**:有文档工具才讲怎么做文档,
 *      有记忆才讲怎么记。伙伴不需要先去「发现」自己会什么 —— 开局就写在
 *      提示词里。判定信号用 runtime 已解析的 toolset id(等价于 Hermes 的
 *      valid_tool_names)。
 *   3. **技能入口进提示词**:小目录直接可见，大目录提供完整检索入口，正文按需读。
 *
 * 为什么必须这么做(2026-08-21 真机实证):伙伴会话里 cindy_docs 明明挂载成功
 * (日志 instance_resolved),但 make_pptx / list_tools 的调用次数是 0 —— 模型
 * 不知道自己有这套工具,于是去找 python 库、没找到、回了句「做不了」。工具
 * 挂载 ≠ 能力可用;能力必须写进提示词才算数。
 */

/** 伙伴运行时已解析的能力信号(plugin id),等价于 Hermes 的 valid_tool_names。 */
export interface BotPromptCapabilitySignals {
  /** 已生效的 toolset(内置插件 id):'docs' | 'memory' | 'scheduler' | … */
  toolsets: readonly string[];
  /** 记忆引擎是否真的可用(挂了 toolset 不等于引擎起得来)。 */
  memoryEnabled: boolean;
  /** 是否启用伙伴消息与后台 Session 任务。 */
  partnerActionsEnabled: boolean;
  /** 是否能直接创建新的伙伴；与消息/任务能力独立。 */
  botCreationEnabled?: boolean;
  routinesEnabled?: boolean;
  /** 伙伴自有技能是否可写入(save_teammate_skill 是否在工具面里)。 */
  ownSkillsEnabled: boolean;
  /** 是否为 Bot 的 canonical Chat；Bot Mode 协议只在这里生效。 */
  botModeEnabled?: boolean;
  /**
   * 是否已挂载普通任务的 session 工具。权限与同环境的普通 Agent 一致。
   */
  sessionControlEnabled?: boolean;
  /** 是否已挂载 cindy_scheduler；操作沿用当前 Agent 权限。 */
  automationEnabled?: boolean;
}

/** 技能索引的一行:名字 + 一句话描述(描述缺省时只列名字)。 */
export interface BotPromptSkillIndexEntry {
  name: string;
  description?: string;
}

export interface BotSystemPromptInput {
  /** Frozen by the host for this runtime instance. */
  locale?: string;
  displayName: string;
  /** SOUL:身份正本。空则由调用方兜底。 */
  identity: string;
  capabilities: BotPromptCapabilitySignals;
  /** 宿主投影的技能入口；原文件与完整目录由存储层保留。 */
  skillIndex: readonly BotPromptSkillIndexEntry[];
  /** 队友名册(见 buildBotTeammateRoster)。没有队友时不传。 */
  teammates?: readonly { id: string; name: string; description?: string | null }[];
  /** 用户档案(USER.md 对应物)。 */
  userProfile?: string;
  /** 记忆快照正文。 */
  memorySnapshot?: string;
  /** 会话控制说明等由调用方给的上下文段。 */
  contextSections?: readonly string[];
  /**
   * 用户维护的 `system_prompt.md` overlay。它是独立上下文段，不能替换
   * SOUL、Cindy 核心协议或按真实工具装配出的能力说明。
   */
  systemPromptOverride?: string;
  /**
   * 伙伴自己那个文件夹的绝对路径。给了才会告诉它「你有个家」——
   * 远端会话没有本机 userData,这时不给,也就一个字都不提。
   */
  homeDir?: string;
}

/**
 * 队友名册 —— 这个伙伴的同事都是谁、各自干什么。
 *
 * 为什么必须进提示词:`TASK_AND_TEAMMATE_GUIDANCE` 定义了后台任务和伙伴消息的边界，
 * 名册直接放进系统提示，让伙伴在需要联系队友时已经知道对方的名字、职责和稳定 id，
 * 不必额外扫描或猜测收件人。
 *
 * 角色取伙伴的描述,压成单行并截断 —— 名册是「谁管什么」的索引,不是简介。
 */
const TEAMMATE_ROLE_MAX_CHARS = 160;

export function buildBotTeammateRoster(
  entries: readonly { id: string; name: string; description?: string | null }[],
  locale?: string,
): string {
  const copy = getBotPromptCopy(locale);
  const rows = entries
    .map((entry) => {
      const name = entry.name.trim();
      const id = entry.id.trim();
      if (!name || !id) return '';
      const role = (entry.description ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TEAMMATE_ROLE_MAX_CHARS);
      return `- ${name}(id \`${id}\`)${role ? ` —— ${role}` : ''}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return [
    copy.teammatesTitle,
    ...rows,
    copy.teammatesHint,
  ].join('\n');
}

function has(signals: BotPromptCapabilitySignals, toolset: string): boolean {
  return signals.toolsets.includes(toolset);
}

/**
 * 稳定层:身份 → 交付纪律 → 按实际能力逐块注入的说明。
 * 这一层在整个会话里逐字节不变,前缀缓存靠它。
 */
export function buildBotStableTier(input: BotSystemPromptInput): string {
  const copy = getBotPromptCopy(input.locale);
  const parts: string[] = [];
  // Omitted by older callers means the canonical Bot prompt path. Runtime
  // hydration passes false explicitly for route/worker sessions.
  const botModeEnabled = input.capabilities.botModeEnabled !== false;
  const identity = input.identity.trim();
  if (identity) parts.push(identity);
  parts.push(copy.TASK_COMPLETION_GUIDANCE);

  // 能力说明按「这个伙伴真的挂了什么」注入 —— 没挂的能力一个字都不提,
  // 免得模型去调一个不存在的工具(Hermes 同款 valid_tool_names 门)。
  const capabilityParts: string[] = [];
  // 家排在最前:它不是某个工具的用法,是「你有身份、有积累、能改自己」这件事本身。
  const homeDir = input.homeDir?.trim();
  if (homeDir) capabilityParts.push(copy.home(homeDir));
  if (has(input.capabilities, 'docs')) capabilityParts.push(copy.DOCS_GUIDANCE);
  if (input.capabilities.memoryEnabled) capabilityParts.push(copy.MEMORY_GUIDANCE);
  if (botModeEnabled && input.capabilities.routinesEnabled) {
    capabilityParts.push(copy.routines);
  }
  if (input.capabilities.ownSkillsEnabled) capabilityParts.push(copy.OWN_SKILLS_GUIDANCE);
  const botCreationEnabled =
    input.capabilities.botCreationEnabled ?? input.capabilities.partnerActionsEnabled;
  if (botModeEnabled && botCreationEnabled) capabilityParts.push(copy.BOT_CREATION_GUIDANCE);
  if (botModeEnabled && input.capabilities.partnerActionsEnabled) {
    capabilityParts.push(copy.TASK_AND_TEAMMATE_GUIDANCE);
  }
  if (botModeEnabled && input.capabilities.sessionControlEnabled) {
    capabilityParts.push(copy.SESSION_CONTROL_GUIDANCE);
    if (input.capabilities.automationEnabled) capabilityParts.push(copy.AUTOMATION_GUIDANCE);
  }
  if (capabilityParts.length > 0) {
    parts.push([copy.capabilitiesTitle, ...capabilityParts].join('\n\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * 技能索引:宿主提供的有界运行时目录。大目录由原生检索 Skill 引导按需
 * 读取完整目录与原文件；此处不再次展开整个存储目录。
 */
export function buildBotSkillIndex(entries: readonly BotPromptSkillIndexEntry[], locale?: string): string {
  const copy = getBotPromptCopy(locale);
  const rows = entries
    .map((entry) => {
      const name = entry.name.trim();
      if (!name) return '';
      const description = entry.description?.trim();
      return description ? `- ${name}:${description}` : `- ${name}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return [copy.skillsTitle, ...rows].join('\n');
}

/**
 * 易变层:技能索引在最前(它随会话内的 save_teammate_skill 变),记忆与用户档案随后。
 * 放在整份提示词末尾,变化时只从这里往后重新计算。
 */
export function buildBotVolatileTier(input: BotSystemPromptInput): string {
  const parts: string[] = [];
  const skillIndex = buildBotSkillIndex(input.skillIndex, input.locale);
  if (skillIndex) parts.push(skillIndex);
  // 队友名册随「有哪些伙伴 / 谁改了名」变,所以在易变层 —— 与技能索引同理。
  const teammates =
    input.capabilities.botModeEnabled !== false
      ? buildBotTeammateRoster(input.teammates ?? [], input.locale)
      : '';
  if (teammates) parts.push(teammates);
  const memory = input.memorySnapshot?.trim();
  if (memory) parts.push(memory);
  const userProfile = input.userProfile?.trim();
  if (userProfile) parts.push(userProfile);
  return parts.join('\n\n');
}

/** 上下文层:调用方给的会话级段落(会话控制模式等)。 */
export function buildBotContextTier(input: BotSystemPromptInput): string {
  const sections = (input.contextSections ?? []).map((s) => s.trim()).filter(Boolean);
  const overlay = input.systemPromptOverride?.trim();
  if (overlay) sections.push(overlay);
  return sections.join('\n\n');
}

/**
 * 三层合并。调用方通常分开取(身份段与上下文段走不同注入位),
 * 这里给一个整体形态便于测试与调试。
 */
export function buildBotSystemPrompt(input: BotSystemPromptInput): {
  stable: string;
  context: string;
  volatile: string;
  full: string;
} {
  const stable = buildBotStableTier(input);
  const context = buildBotContextTier(input);
  const volatile = buildBotVolatileTier(input);
  return {
    stable,
    context,
    volatile,
    full: [stable, context, volatile].filter(Boolean).join('\n\n'),
  };
}
