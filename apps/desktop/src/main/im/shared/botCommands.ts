/**
 * Telegram bot 命令注册表 —— 官方 bot 与个人 bot 共用的**唯一命令世界观**。
 * ---------------------------------------------------------------------------
 * 为什么两个 bot 要写进同一张表:
 *
 * 用户侧两个 bot 的命令面事实上不同(个人 bot 缺 /agent /effort /settings
 * /status /unbind, 官方缺 /start), 但这个差异过去没有任何单一事实来源 ——
 * 官方那 16 条在服务端 `TELEGRAM_COMMANDS`, 个人那 10 条在本文件, 两边各自
 * 漂移, 报 bug 的人得先被问「你用的是哪个 bot」。
 *
 * 于是这里把两边的命令**全部**登记进来, 用 `surfaces` 标注谁有谁没有;
 * 任何只存在于单侧的命令必须写 `parityNote` 讲清楚为什么 —— 缺了 CI 红。
 * 差异本身不消失, 但它从此是**写下来的、拦得住的**, 而不是靠人记。
 *
 * 当前接线边界(#1855 第二刀):
 *   - 个人 bot: 本表是运行时事实来源(菜单渲染 + 命令分发都读它)。
 *   - 官方 bot: 命令仍由服务端下发, 本表对官方侧是**声明性镜像**, 不接线。
 *     镜像与服务端的一致性由 `botCommands.test.ts` 里的内联清单断言守住。
 */

import type { ImChannelName } from './types';

export const PERSONAL_BOT_COMMAND_LOCALE_POLICY = 'desktop-app' as const;

/** 命令出现在哪个 bot 上。两个都有 = 用户在两边看到同一条命令。 */
export type BotCommandSurface = 'personal' | 'official';

export interface BotCommandDefinition {
  /** 不带前导斜杠的规范命令名。 */
  command: string;
  /** 这条命令在哪些 bot 上存在。长度为 1 时 `parityNote` 必填。 */
  surfaces: readonly BotCommandSurface[];
  /**
   * 只存在于单侧时, 说明为什么另一侧没有 —— 是有意的产品差异, 还是尚未实现。
   * 这是本表存在的理由: 让「两边不一样」变成一句写下来的话。
   */
  parityNote?: string;
  /**
   * 渲染 Telegram owner 命令菜单用的 desktop i18n key。
   *
   * 只有 Telegram 有 `setMyCommands` 这种平台级命令菜单, 别的渠道不消费它,
   * 所以字段名直接带上 telegram —— 不是命名空间没解耦, 是它本来就只服务 Telegram。
   * `surfaces` 含 `personal` 的命令必填(菜单要渲染); 官方独有的命令留空,
   * 因为它们的菜单文案在服务端 `TELEGRAM_COMMANDS` 里。
   */
  telegramMenuDescriptionKey?: `settings.telegramBot.commandMenu.${string}`;
  /**
   * 这条命令是否需要渠道支持富交互卡。
   *
   * (原名 `interactive` —— 字段名说的是「交互」, 判据却是「渠道能不能发卡」,
   * 名实不符; 这里按真实判据改名。)
   * 为 true 时, `chunked-text` 渠道会直接回「该渠道不支持此命令」。
   */
  requiresRichCards: boolean;
  /**
   * 尽管需要富卡, 但在这些渠道上有纯文本降级实现, 因此照常放行。
   *
   * 过去这条知识硬编码在 dispatcher 里(`channel === 'wecom' && cmd === '/permission'`),
   * 渠道能力散落在分发逻辑中; 收进表里, 新增降级只改数据。
   */
  textFallbackChannels?: readonly ImChannelName[];
  /** 接受但不在 Telegram 命令菜单里露出的拼写。 */
  aliases?: readonly string[];
}

/**
 * 表的顺序即个人 bot 菜单的顺序 —— 前 10 条是个人 bot 的既有顺序, 一行不能动
 * (`buildPersonalBotCommandMenu` 直接按表序渲染)。官方独有的排在其后。
 */
export const BOT_COMMANDS = [
  {
    command: 'start',
    surfaces: ['personal'],
    parityNote:
      'Telegram 私聊首次交互必发 /start(START 按钮); 官方 bot 的首次交互走服务端 deep-link 绑定流程, 不需要这条命令。',
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.start',
    requiresRichCards: false,
  },
  {
    command: 'new',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.new',
    requiresRichCards: false,
  },
  {
    command: 'help',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.help',
    requiresRichCards: false,
  },
  {
    command: 'stop',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.stop',
    requiresRichCards: false,
  },
  {
    command: 'session',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.session',
    requiresRichCards: true,
  },
  {
    command: 'project',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.project',
    requiresRichCards: true,
    // 官方 bot 的 /workspace 是同义命令(服务端两条菜单文案逐字相同)。个人侧用
    // 别名接住这个拼写: 用户从官方 bot 沿用过来不会撞「未知命令」, 也不多占一个
    // 菜单位。下面 workspace 那条 official-only 定义的 parityNote 说的就是这里。
    aliases: ['workspace'],
  },
  {
    command: 'model',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.model',
    requiresRichCards: true,
  },
  {
    command: 'permission',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.permission',
    requiresRichCards: true,
    textFallbackChannels: ['wecom'],
  },
  {
    command: 'settings',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.settings',
    requiresRichCards: false,
  },
  {
    command: 'ctr',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.ctr',
    requiresRichCards: true,
  },
  {
    command: 'exctr',
    surfaces: ['personal', 'official'],
    telegramMenuDescriptionKey: 'settings.telegramBot.commandMenu.exctr',
    requiresRichCards: false,
    aliases: ['exitctr'],
  },

  // ── 官方 bot 独有 —— 个人 bot 的能力缺口, 每条各自独立成 PR 补齐 ──────────
  {
    command: 'workspace',
    surfaces: ['official'],
    parityNote:
      '/project 的同义命令(服务端两条菜单文案逐字相同)。个人 bot 用 aliases 表达同义拼写, 不重复占一个菜单位, 因此不登记为独立命令。',
    requiresRichCards: true,
  },
  {
    command: 'unbind',
    surfaces: ['official'],
    parityNote: '清除当前 chat 的项目映射。个人 bot 尚未实现 —— 目前只能在桌面设置页解绑。',
    requiresRichCards: false,
  },
  {
    command: 'effort',
    surfaces: ['official'],
    parityNote: '选择思考强度。个人 bot 尚未实现 —— 只能在桌面端改。',
    requiresRichCards: true,
  },
  {
    command: 'agent',
    surfaces: ['official'],
    parityNote: '切换 Agent(Claude Code / Codex / Pi)。个人 bot 尚未实现 —— 只能在桌面端改。',
    requiresRichCards: true,
  },
  {
    command: 'status',
    surfaces: ['official'],
    parityNote:
      '查看关联状态。官方 bot 经服务端中继, 链路可断; 个人 bot 由桌面端直连 Bot API, 没有等价的「关联状态」概念 —— 这是有意的产品差异, 不是缺口。',
    requiresRichCards: false,
  },
  {
    command: 'unlink',
    surfaces: ['official'],
    parityNote:
      '解除 Telegram 关联。个人 bot 的 token 由用户自填, 解绑入口在桌面设置页 —— 有意的产品差异。',
    requiresRichCards: false,
  },
] as const satisfies readonly BotCommandDefinition[];

export type BotCommandName = (typeof BOT_COMMANDS)[number]['command'];

/**
 * 派生子集统一按 `BotCommandDefinition` 暴露(而非各条的字面量类型): 子集里各条
 * 的可选字段不一样(只有 exctr 有 aliases、只有单侧命令有 parityNote), 保留字面量
 * 会让调用方在联合类型上读不到这些字段。命令名的字面量精度由 `BotCommandName` 提供。
 */
const withSurface = (surface: BotCommandSurface): readonly BotCommandDefinition[] =>
  BOT_COMMANDS.filter((definition) =>
    (definition.surfaces as readonly BotCommandSurface[]).includes(surface),
  );

/** 个人 bot 的命令子集 —— 顺序即 Telegram owner 菜单顺序。 */
export const PERSONAL_BOT_COMMANDS = withSurface('personal');

/** 官方 bot 的命令子集 —— 声明性镜像, 当前不接线。 */
export const OFFICIAL_BOT_COMMANDS = withSurface('official');

const personalCommandByInvocation = new Map<string, BotCommandDefinition>();
for (const definition of PERSONAL_BOT_COMMANDS) {
  personalCommandByInvocation.set(`/${definition.command}`, definition);
  for (const alias of definition.aliases ?? []) {
    personalCommandByInvocation.set(`/${alias}`, definition);
  }
}

/** 分词结果 —— `definition` 为 null 表示不是本表登记的个人 bot 命令。 */
export interface TokenizedBotCommand {
  definition: BotCommandDefinition | null;
  /** 用户输入的原始拼写, 含前导斜杠。 */
  invocation: string;
  args: readonly string[];
}

/**
 * 分词 + 查表, 一次走完。
 *
 * dispatcher 过去自己 `split(/\s+/)` 一遍、再调注册表内部又 split 一遍 —— 两套
 * 分词一旦漂移(比如一边处理全角空格另一边不处理), 命令名与参数就会对不上。
 * 这里合成唯一入口, 未登记的命令也照常返回分词结果, 让调用方拿一份就够。
 */
export function tokenizeBotCommand(text: string): TokenizedBotCommand {
  const [invocation, ...args] = text.trim().split(/\s+/);
  return { definition: personalCommandByInvocation.get(invocation) ?? null, invocation, args };
}

export interface ParsedPersonalBotCommand {
  definition: BotCommandDefinition;
  /** 用户输入的原始拼写, 含前导斜杠。 */
  invocation: string;
  args: readonly string[];
}

/** 解析个人 bot 的已知命令; 大小写敏感度保持历史行为不变。 */
export function parsePersonalBotCommand(text: string): ParsedPersonalBotCommand | null {
  const { definition, invocation, args } = tokenizeBotCommand(text);
  return definition ? { definition, invocation, args } : null;
}

/**
 * 判断某条命令在指定渠道上是否可用。
 *
 * 富卡命令在纯文本渠道默认不可用, 除非该渠道登记了文本降级实现。
 */
export function isBotCommandAvailableOnChannel(
  definition: Pick<BotCommandDefinition, 'requiresRichCards' | 'textFallbackChannels'>,
  channel: ImChannelName,
  channelSupportsRichCards: boolean,
): boolean {
  if (!definition.requiresRichCards || channelSupportsRichCards) return true;
  return (definition.textFallbackChannels ?? []).includes(channel);
}

/** 按桌面端语言渲染 owner 作用域的 Telegram 命令菜单。 */
export function buildPersonalBotCommandMenu(
  translate: (key: NonNullable<BotCommandDefinition['telegramMenuDescriptionKey']>) => string,
): ReadonlyArray<{ command: string; description: string }> {
  return PERSONAL_BOT_COMMANDS.map(({ command, telegramMenuDescriptionKey }) => ({
    command,
    // 个人 bot 的每条命令都有菜单 key(botCommands.test.ts 守门), 非空断言安全。
    description: translate(telegramMenuDescriptionKey!),
  }));
}
