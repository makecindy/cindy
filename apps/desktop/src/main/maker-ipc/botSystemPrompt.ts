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
  /** 用户档案(USER.md 对应物)。 */
  userProfile?: string;
  /** 记忆快照正文。 */
  memorySnapshot?: string;
  /** 会话控制说明等由调用方给的上下文段。 */
  contextSections?: readonly string[];
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
  '动手前先看自己手上有哪些工具。你的能力写在下面「你会做什么」里,不要凭印象断定自己做不到某件事;工具在不在手边,看工具列表,不靠猜。',
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
  '正式文档(PDF / PPT / Word)先在 tmp/ 写一份自包含 HTML 当设计稿定版式,再据此生成目标格式 —— 这一步是你自己的工序,不要拿给用户看、也不要中途问他要不要先看草稿。表格类直接生成,不走这一步。',
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
  '做完一件以前没做过的多步骤任务后,把「这类事该怎么做」用 `save_bot_skill` 存成你自己的技能 —— 写可复用的步骤,不写这一次的结论。存之前先用 `list_bot_skills` 看有没有同类的,有就在原来那份上改进后同名覆盖。',
  '技能从下一个任务开始生效,这一次不用指望它。',
  '再遇到同类任务时先照自己的技能做;发现技能过时或不好用,当场改掉,别等人提醒。',
].join('\n');

/** 协作:强调这是「把一段活交出去并拿回结果」,不是指挥别人。 */
const DELEGATION_GUIDANCE = [
  '## 你可以叫别的伙伴帮忙',
  '遇到别人更擅长的一段活,可以把它交出去:说清楚要什么、给足背景,对方做完结果会自动回到这个对话里。你不需要守着等,也不要反复去催。',
  '这是把一段有边界的活交出去并拿回结果,不是命令对方、也不会改变对方是谁。用户如果要求"让某个伙伴听话",说明这条边界,然后直接给出可以协作的做法。',
].join('\n');

/** 日程/自动化。 */
const SCHEDULE_GUIDANCE = [
  '## 你能定时干活',
  '需要按时重复做的事(每天的简报、每周的整理、到点提醒),可以给自己排一条日程,到点你会被叫起来做。',
  '排之前先把「做什么」和「什么时候」跟用户确认清楚,不要替他假定频率。',
].join('\n');

/** 作品集:所有能给用户看的产物都在这里,不只文档。 */
const PORTFOLIO_GUIDANCE = [
  '## 你做出来的东西会进作品集',
  '你产出的文件、图片、视频都会作为「作品」出现在对话里,并自动收进你的作品集,用户随时能翻回去。',
  '所以交付时讲清楚这份作品是什么、包含哪些内容(几页、几张表、什么结论),不要复述路径,也不要把工具的原始返回值粘给他。',
].join('\n');

function has(signals: BotPromptCapabilitySignals, toolset: string): boolean {
  return signals.toolsets.includes(toolset);
}

/**
 * 稳定层:身份 → 交付纪律 → 按实际能力逐块注入的说明。
 * 这一层在整个会话里逐字节不变,前缀缓存靠它。
 */
export function buildBotStableTier(input: BotSystemPromptInput): string {
  const parts: string[] = [];
  const identity = input.identity.trim();
  if (identity) parts.push(identity);
  parts.push(TASK_COMPLETION_GUIDANCE);

  // 能力说明按「这个伙伴真的挂了什么」注入 —— 没挂的能力一个字都不提,
  // 免得模型去调一个不存在的工具(Hermes 同款 valid_tool_names 门)。
  const capabilityParts: string[] = [];
  if (has(input.capabilities, 'docs')) capabilityParts.push(DOCS_GUIDANCE);
  if (input.capabilities.memoryEnabled) capabilityParts.push(MEMORY_GUIDANCE);
  if (input.capabilities.ownSkillsEnabled) capabilityParts.push(OWN_SKILLS_GUIDANCE);
  if (input.capabilities.delegationEnabled) capabilityParts.push(DELEGATION_GUIDANCE);
  if (has(input.capabilities, 'scheduler')) capabilityParts.push(SCHEDULE_GUIDANCE);
  // 作品集不依赖某个 toolset:只要能产出文件/图片/视频就成立,而任何伙伴
  // 都可能产出图片(出图能力在别处),所以恒挂。
  capabilityParts.push(PORTFOLIO_GUIDANCE);
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
  const memory = input.memorySnapshot?.trim();
  if (memory) parts.push(memory);
  const userProfile = input.userProfile?.trim();
  if (userProfile) parts.push(userProfile);
  return parts.join('\n\n');
}

/** 上下文层:调用方给的会话级段落(会话控制模式等)。 */
export function buildBotContextTier(input: BotSystemPromptInput): string {
  return (input.contextSections ?? []).map((s) => s.trim()).filter(Boolean).join('\n\n');
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
