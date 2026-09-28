/**
 * 伙伴记忆页的跨进程线型(main / preload / renderer 共用一份)。
 *
 * 磁盘事实在 Bot Home 的 `memories/`,由 maker-core 的 MakerMemoryStore 维护
 * (文件 + MEMORY.md 索引 + FTS)。这里只放设置页要的字段:不含绝对路径,也不含
 * 摘要(description)——摘要是给模型看的目录钩子,界面不展示,由 main 在保存时维护。
 */

/** 设置页展示的四类。Pi 压缩沉淀的 `digest` 是系统内部类型,不进这里。 */
export const BOT_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type BotMemoryType = (typeof BOT_MEMORY_TYPES)[number];

/** 与 maker-core DEFAULT_MEMORY_CONFIG 对齐:标题字符数上限、正文字节硬上限。 */
export const BOT_MEMORY_TITLE_MAX = 100;
export const BOT_MEMORY_BODY_MAX_BYTES = 8192;

/** 列表里的一条:正文只带开头一段,够显示两行预览。 */
export interface BotMemorySummary {
  /** `<type>_<slug>.md`,读 / 改 / 删的稳定标识。 */
  filename: string;
  type: BotMemoryType;
  title: string;
  preview: string;
  /** ISO 串;同时是保存 / 删除时的并发比对基准。 */
  updatedAt: string;
}

export interface BotMemoryDetail {
  filename: string;
  type: BotMemoryType;
  title: string;
  body: string;
  updatedAt: string;
}

export interface BotMemoryUpdateInput {
  botId: string;
  filename: string;
  title: string;
  body: string;
  /** 打开编辑时看到的 updatedAt;不一致说明伙伴刚改过,拒绝覆盖。 */
  expectedUpdatedAt: string;
}

export interface BotMemoryDeleteInput {
  botId: string;
  filename: string;
  expectedUpdatedAt: string;
}

/**
 * 「伙伴在你打开之后改过这条」的拒绝原因。走 PRECONDITION_FAILED,message 固定为此值,
 * renderer 据此重新读取并展示最新内容;账号切换等其它前置失败不带它。
 */
export const BOT_MEMORY_CHANGED = 'bot-memory-changed';
