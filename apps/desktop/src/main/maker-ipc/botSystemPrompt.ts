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
 *   3. **技能索引整份进提示词**:每个技能的名字与一句话描述都可见,不靠
 *      模型自己翻目录。
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
  /** 是否允许把活委派给别的伙伴。 */
  delegationEnabled: boolean;
  /** 伙伴自有技能是否可写入(save_bot_skill 是否在工具面里)。 */
  ownSkillsEnabled: boolean;
  /** 是否为 Bot 的 canonical Chat；Bot Mode 协议只在这里生效。 */
  botModeEnabled?: boolean;
}

/** 技能索引的一行:名字 + 一句话描述(描述缺省时只列名字)。 */
export interface BotPromptSkillIndexEntry {
  name: string;
  description?: string;
}

export interface BotSystemPromptInput {
  displayName: string;
  /** SOUL:身份正本。空则由调用方兜底。 */
  identity: string;
  capabilities: BotPromptCapabilitySignals;
  /** 伙伴自有技能索引(全部,不截断)。 */
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
 * 「把活干完」的纪律。放在能力说明之前:它约束的是**所有**能力的交付形态,
 * 而不是某一个工具的用法。两条真实事故各对应一句 ——
 *   · 伙伴拿不到工具就回「做不了」,而没有先看自己手上有什么;
 *   · 伙伴把「我准备怎么做」当成交付物讲完就收尾。
 */
const TASK_COMPLETION_GUIDANCE = [
  '## 把活干完',
  '用户要的是能打开、能用的东西,不是对它的描述。写完计划不算完成,给出一段"可以这样做"也不算完成 —— 真的做出来、真的跑过、把结果给出去才算。',
  '你的能力已经按当前实际可用项写在下面「你会做什么」里。直接使用对应能力,不要先做全量工具盘点,也不要凭印象断定自己做不到。',
  '真的被挡住时(工具报错、缺少授权、路径不通),直说卡在哪、试了什么、需要什么,然后换一条路继续。绝不编造看起来合理的结果 —— 不编文件内容、不编数据、不编"已完成"。如实说卡住了,永远比伪造一个交付物好。',
].join('\n');

/**
 * 文档能力。工具名与参数以 list_tools 实时返回为准,这里只保证「知道自己会做」
 * 与「知道该用哪个」。产物一律进作品集,所以这段也讲落点。
 */
const DOCS_GUIDANCE = [
  '## 你会做文件',
  '你可以直接做出真文件,不需要用户装任何软件,也不要去找 python-pptx / LibreOffice 这类外部依赖 —— 宿主已经内置好了:',
  '- `make_pptx` 做 PPT(.pptx):传 slides 数组,有封面/分节/内容三套版式与配色主题。',
  '- `make_docx` 做 Word(.docx):传 Markdown,标题层级、表格、封面都会排好。',
  '- `make_xlsx` 做 Excel(.xlsx):传 sheets + rows,表头、冻结、数字格式自动处理;公式要连缓存值一起给。',
  '- `render_pdf` 出 PDF:传一份自包含 HTML(或文件路径),用宿主的排版引擎渲染。',
  '- `read_sheet` 读表格(xlsx / csv / tsv),`inspect_pdf` 体检刚做出来的 PDF(页数、纸型、有没有空白页)。',
  // 工序正文由 cindy_docs 的工具描述提供同一份 —— 那边是所有会话(含普通会话、
  // 三种 harness)唯一都会读到的位置,这里只是把同一段话在伙伴的能力说明里再讲一次,
  // 不另写一版免得两处漂移。
  // 具体工序不在这里重复:每个工具的描述里都带着它自己的做法(先定版式、PPT 要不要
  // 先写 HTML 设计稿、PDF 怎么排),那份说明会一字不差进模型上下文。这里只提醒一句
  // 「照工具说明做」,免得同一段话两处各写一版、日后必然漂移。
  '做正式文档(PDF / PPT / Word)前,先看一眼对应工具说明里写的排版工序,照着做 —— 那一步决定成品好不好看。',
  '文件写进当前工作目录的 documents/ 下,文件名用「日期-主题」。做完 PDF 一定用 `inspect_pdf` 看一眼再交付:页数对不对、有没有空白页。做完表格用 `read_sheet` 读回核对。',
  '交付时把文件当作品交出去,不要只甩一条路径给用户。',
].join('\n');

/** 记忆。写法上强调「陈述事实」而不是「给自己下指令」。 */
const MEMORY_GUIDANCE = [
  '## 你记得住事',
  '你有一份跨会话的长期记忆,只属于你自己。值得记的是以后还用得上的东西:用户的偏好与习惯、他纠正过你的做法、长期有效的约定与背景。',
  '记成陈述句,不要写成给自己的命令 —— 「他喜欢先看几版再定」是好记忆,「以后都先给三版」不是。',
  '不要记流水账:今天做完的事、临时状态、过几天就过期的进度,都不进记忆。',
  '记下一件事后,在回复末尾轻描淡写地带一句,让用户知道你记住了什么。',
].join('\n');

/** 自有技能:与记忆的分工是「做法」vs「事实」。 */
const OWN_SKILLS_GUIDANCE = [
  '## 你能把做法沉淀成本事',
  '技能不是每轮复盘或流水账。只有用户明确要求,或者同类工作已经重复出现、做法经过验证且确实值得复用时,才用 `save_bot_skill` 把步骤存成自己的技能;单次结论、临时路径、猜测和未经验证的做法都不存。',
  '存之前先用 `list_bot_skills` 查重;有同类就更新原来的,不要另造一份。技能从下一个任务开始生效,并且始终让用户看得见、改得动、删得掉。',
  '不要为了整理记忆或技能启动后台复盘、协同 worker。发现旧技能确实过时,先验证新做法,再更新。',
].join('\n');

/** 协作:直接消息 + 有状态委派 + 开真正的 Cindy 任务,三种语义不互相替代。 */
const DELEGATION_GUIDANCE = [
  '## 你可以把活交出去',
  '协作只用一个直接入口 `collaborate_with_bot`,不启动 Team / Worker,也不需要先列工具。找伙伴时用「你的队友」里给出的稳定 Bot id。',
  '- `action=status` 只查对方当前是否空闲,不发送消息。',
  '- `action=notify` 适合通知、提问或轻量接力;只确认消息被对方主对话收下,不会替你等回复。',
  '- `action=delegate` 适合交给某个伙伴的、有明确结果的工作;说清目标和必要背景,完成结果会自动回到当前对话。',
  '- `action=start_task` 不找伙伴,而是把一件大活开成一条**真正的 Cindy 任务**(写代码、跑工程、长时间的重活)。它出现在用户的任务列表里、有完整的 Cindy 能力;做完结果同样自动回到当前对话。你自己保持轻量,别在自己对话里硬扛大工程。',
  '交出去的活完成时,对话里的协作卡会自动更新;你会收到结果并接着往下做,不需要轮询等待。',
  '这是把一段有边界的活交出去并拿回结果,不是命令对方、也不会改变对方是谁。用户如果要求"让某个伙伴听话",说明这条边界,然后直接给出可以协作的做法。',
].join('\n');

/**
 * 队友名册 —— 这个伙伴的同事都是谁、各自干什么。
 *
 * 为什么必须进提示词:`DELEGATION_GUIDANCE` 告诉伙伴「你可以叫别的伙伴帮忙」,
 * 却从不说**队友是谁**。工具面里确实有 `list_bots` 能查,但模型得先想到去查 ——
 * 而它没有任何理由想到:提示词里一个队友的名字都没出现过。结果就是这条能力
 * 挂在那儿基本不触发,或者伙伴瞎猜一个名字然后失败。
 *
 * 抄的是 Hermes(hermes-agent tools/bot_mode_probe.py 的 `_roster_lines`)。
 * 它的原话:队友名册 —— **名字与角色**,取自各自档案的 title/description ——
 * 是每个 Bot Chat 系统提示词的一部分,**这样 bot 在挑收件人之前就知道谁管什么**。
 *
 * 一处必须适配:Hermes 的 `message_agent` 认句柄(`@researcher`),Cindy 的直接消息与
 * 委派都认**稳定 id**。所以名册行必须把 id 带上 —— 否则伙伴看见的是一串它无法
 * 转成参数的名字,又得回去查一遍名册,等于白写。
 * 「写进去的串,恰好就是工具认的串」是 Hermes 反复强调的一条(见群房间 @ 补全)。
 *
 * 角色取伙伴的描述,压成单行并截断 —— 名册是「谁管什么」的索引,不是简介。
 */
const TEAMMATE_ROLE_MAX_CHARS = 160;

export function buildBotTeammateRoster(
  entries: readonly { id: string; name: string; description?: string | null }[],
): string {
  const rows = entries
    .map((entry) => {
      const name = entry.name.trim();
      const id = entry.id.trim();
      if (!name || !id) return '';
      const role = (entry.description ?? '').replace(/\s+/g, ' ').trim().slice(
        0,
        TEAMMATE_ROLE_MAX_CHARS,
      );
      return `- ${name}(id \`${id}\`)${role ? ` —— ${role}` : ''}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return [
    '## 你的队友',
    ...rows,
    '直接联系、查状态或交活时,把上面那个 id 直接传给 `collaborate_with_bot`。不确定谁合适就别猜,问用户一句。',
  ].join('\n');
}

/**
 * 「你有个家」—— 照抄 Hermes 唯一真做的那件事。
 *
 * Cindy 的宿主策略不属于 Agent 可写内容。Home 根部因此只作身份定位；原始文件
 * 工具只写 workspace，memories / skills 通过类型化宿主工具维护。
 */
function buildHomeGuidance(homeDir: string): string {
  return [
    '## 你有个自己的文件夹',
    `\`${homeDir}\` 是你的唯一 Home。身份、记忆、技能和默认工作区都归在这里，不继承当前项目或 Cindy 的全局目录。`,
    '- `workspace/` —— 你的默认可写工作区。没有显式挂载项目时，产物和工作文件放这里。',
    '- `memories/` —— 你的长期记忆；通过 Bot Memory 工具维护。',
    '- `skills/` —— 你自己的技能；通过 Bot Skill 工具维护。',
    '- `SOUL.md`、`memories/USER.md`、`system_prompt.md` —— 用户管理的身份与偏好，下一任务加载。',
    '',
    '不要查找或修改 Home 根部的宿主配置。外部目录、项目、Skill 和 MCP 只有用户显式挂载后才属于当前能力面。',
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
  const parts: string[] = [];
  // Omitted by older callers means the canonical Bot prompt path. Runtime
  // hydration passes false explicitly for route/worker sessions.
  const botModeEnabled = input.capabilities.botModeEnabled !== false;
  const identity = input.identity.trim();
  if (identity) parts.push(identity);
  parts.push(TASK_COMPLETION_GUIDANCE);

  // 能力说明按「这个伙伴真的挂了什么」注入 —— 没挂的能力一个字都不提,
  // 免得模型去调一个不存在的工具(Hermes 同款 valid_tool_names 门)。
  const capabilityParts: string[] = [];
  // 家排在最前:它不是某个工具的用法,是「你有身份、有积累、能改自己」这件事本身。
  const homeDir = input.homeDir?.trim();
  if (homeDir) capabilityParts.push(buildHomeGuidance(homeDir));
  if (has(input.capabilities, 'docs')) capabilityParts.push(DOCS_GUIDANCE);
  if (input.capabilities.memoryEnabled) capabilityParts.push(MEMORY_GUIDANCE);
  if (input.capabilities.ownSkillsEnabled) capabilityParts.push(OWN_SKILLS_GUIDANCE);
  if (botModeEnabled && input.capabilities.delegationEnabled) {
    capabilityParts.push(DELEGATION_GUIDANCE);
  }
  if (capabilityParts.length > 0) {
    parts.push(['# 你会做什么', ...capabilityParts].join('\n\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * 技能索引:全部技能的名字 + 一句话描述。
 *
 * 照搬 Hermes 的口径 —— 索引里**不省略任何技能名**。模型看得见名字才知道
 * 自己有这份本事;正文按需再读。
 */
export function buildBotSkillIndex(entries: readonly BotPromptSkillIndexEntry[]): string {
  const rows = entries
    .map((entry) => {
      const name = entry.name.trim();
      if (!name) return '';
      const description = entry.description?.trim();
      return description ? `- ${name}:${description}` : `- ${name}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return ['## 你已经会的本事', ...rows].join('\n');
}

/**
 * 易变层:技能索引在最前(它随会话内的 save_bot_skill 变),记忆与用户档案随后。
 * 放在整份提示词末尾,变化时只从这里往后重新计算。
 */
export function buildBotVolatileTier(input: BotSystemPromptInput): string {
  const parts: string[] = [];
  const skillIndex = buildBotSkillIndex(input.skillIndex);
  if (skillIndex) parts.push(skillIndex);
  // 队友名册随「有哪些伙伴 / 谁改了名」变,所以在易变层 —— 与技能索引同理。
  const teammates = input.capabilities.botModeEnabled !== false
    ? buildBotTeammateRoster(input.teammates ?? [])
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
