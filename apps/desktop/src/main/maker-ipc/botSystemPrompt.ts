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
  /** 是否启用伙伴消息与后台 Session 任务。 */
  partnerActionsEnabled: boolean;
  /** 是否能直接创建新的伙伴；与消息/任务能力独立。 */
  botCreationEnabled?: boolean;
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
  '交付文件用能说清内容的名字，不用 index、final、output 这类让人猜的名字。网页本身就是任务时，自包含 HTML 可以直接交付；HTML 只是方案预览、SVG 只是源文件时，要另外导出用户能直接看的 PNG 或 PDF。最后只把真正的成品列在「交付物」下，把源码、预览页和中间文件另列为相关文件，并说清如何打开、验证过什么。',
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
  '用户第一次明确说出一条稳定偏好、纠正或长期背景时,确认它足够具体且不是临时状态,就主动记下,不要等他重复第二次,也不要让他再去设置页手填。拿不准是否长期有效时才问一句。',
  '记成陈述句,不要写成给自己的命令 —— 「他喜欢先看几版再定」是好记忆,「以后都先给三版」不是。',
  '不要记流水账:今天做完的事、临时状态、过几天就过期的进度,都不进记忆。',
  '记下一件事后,在回复末尾轻描淡写地带一句,让用户知道你记住了什么。',
].join('\n');

/** 自有技能:与记忆的分工是「做法」vs「事实」。 */
const OWN_SKILLS_GUIDANCE = [
  '## 你能把做法沉淀成本事',
  '技能不是每轮复盘或流水账。用户明确要求时直接沉淀;或者一套完整做法已经在真实任务里验证成功、以后明显还会复用时,第一次验证完就用 `save_bot_skill` 存成自己的技能,不要等用户去设置页手填。单次结论、临时路径、猜测和未经验证的做法都不存。',
  '存之前先用 `list_bot_skills` 查重;有同类就更新原来的,不要另造一份。技能从下一个任务开始生效,并且始终让用户看得见、改得动、删得掉。',
  '不要为了整理记忆或技能启动后台复盘、协同 worker。发现旧技能确实过时,先验证新做法,再更新。',
].join('\n');

/** 后台任务与伙伴消息是两种不同能力。 */
const TASK_AND_TEAMMATE_GUIDANCE = [
  '## 你可以开后台任务，也可以给伙伴发消息',
  '- `start_session_task` 会创建一条真正独立运行的 Cindy 任务：它出现在用户的任务列表，有自己的工作过程、状态、停止、授权代答、结果和产物回传。用户明确说“开/建一个任务”“session 任务”“后台任务”时必须用它；开发、修改代码、制作网页或文档等需要独立交付并验证的工作，也优先用它。它不会唤起任何伙伴。一次请求只启动一次。',
  '- `check_session_task` 查看指定任务的实时状态；只有用户追问进度或自动回传疑似丢失时才查，不要定时轮询。',
  '- `message_session_task` 给同一任务补充条件、修正方向，或回答它正在等待的授权、问题和计划确认；不要为了补一句话另开任务。',
  '- `stop_session_task` 停止指定任务及其子任务。只有用户要求停止，或继续执行会不安全时才使用。',
  '- 后台任务完成、失败或停止时，当前时间线里的任务卡会更新，结果和文件会自动回到这里。',
  '- `send_to_agent` 只给「你的队友」里明确存在的伙伴发一条异步消息，不启动任务，也没有进度、停止或自动交付。只有用户明确点名某个伙伴，或当前工作确实需要那个伙伴的身份和信息时，才用名册里的稳定 Bot id。需要独立交付物或验证时必须用 `start_session_task`。',
  '- 收到 `[Direct message from Cindy Bot ...]` 时，在自己的当前主任务里处理。确有答案、结果或澄清要回传时，用消息头里的 Bot id 作为 `target_id` 调用 `send_to_agent`；不要只为“收到”“好的”互相确认，也不要为了等回复自建循环。',
  '后台任务负责独立工作并回传结果；伙伴消息只负责沟通，不保证对方执行或交付。它们都不是命令对方，也不会改变对方是谁。用户如果要求"让某个伙伴听话",说明这条边界,然后直接给出可以协作的做法。',
].join('\n');

const BOT_CREATION_GUIDANCE = [
  '## 你可以创建伙伴',
  '用户要求新增、创建或添加一个伙伴时，直接调用 `create_teammate` 完成创建。根据用户描述推断名称、职责、简洁身份和一句与用户同语言的自然开场白；不要写资料包、模板文件，也不要让用户手动去设置页重做一遍。',
].join('\n');

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
): string {
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
    '## 你的队友',
    ...rows,
    '只有明确要联系某个伙伴时，才把上面的 id 传给 `send_to_agent`。开后台任务用 `start_session_task`，不要从名册挑人。不确定该找谁就别猜，问用户一句。',
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
    '- `SOUL.md`、`memories/USER.md`、`system_prompt.md` —— 身份和高级覆盖，用户需要纠正你时可以直接编辑，下一任务加载。不要自行改写 SOUL 或 system_prompt；日常积累写进记忆和技能。',
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
  const botCreationEnabled =
    input.capabilities.botCreationEnabled ?? input.capabilities.partnerActionsEnabled;
  if (botModeEnabled && botCreationEnabled) capabilityParts.push(BOT_CREATION_GUIDANCE);
  if (botModeEnabled && input.capabilities.partnerActionsEnabled) {
    capabilityParts.push(TASK_AND_TEAMMATE_GUIDANCE);
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
  const teammates =
    input.capabilities.botModeEnabled !== false
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
