/**
 * Bot 交付物(artifact)的共享形态与分类。
 * ---------------------------------------------------------------------------
 * 「交付物」= 一个伙伴做出来的、用户能打开的东西。它有三条真实来源,全部是**既有
 * 持久化数据的只读投影**,不新增 schema:
 *
 *   1. `delegation` —— `bot_delegations.output_artifacts_json`(委派子任务回传的
 *      Cindy 协议引用,形态见 botOutputArtifact.ts:只有 `ref` + `kind`,没有标题、
 *      没有体积、没有磁盘路径)。
 *   2. `generated`  —— 伙伴会话里 `tool_use` 消息记录的**新建**文件(Write / write /
 *      codex file_change add)。这是「TA 做出来的文件」的主力来源,与聊天里
 *      GeneratedFilesCard 的口径同源(只收新建,不收编辑/读取/删除/移动)。
 *   3. `attachment` —— 伙伴会话消息里的文件附件(`content.files[]`,形态 FileRef)。
 *
 * 分类只看**扩展名**(协议引用先看 scheme)。四型对应定稿原型的四张卡:
 * 文档 / 表格 / 图片 / 演示,其余一律 `other` 走通用文件卡。
 */

/** 定稿原型的四型交付物 + 兜底。 */
export type BotArtifactCategory = 'doc' | 'sheet' | 'image' | 'deck' | 'other';

export const BOT_ARTIFACT_CATEGORIES: readonly BotArtifactCategory[] = [
  'doc',
  'sheet',
  'image',
  'deck',
  'other',
];

/** 交付物来源。决定归属判定与降级口径,不进 UI 文案。 */
export type BotArtifactSource = 'delegation' | 'generated' | 'attachment';

export interface BotArtifactItem {
  /** 稳定标识:同一件东西在多次投影里必须得到同一个 id(用于去重 + 高亮定位)。 */
  id: string;
  source: BotArtifactSource;
  category: BotArtifactCategory;
  /** 展示标题(文件名 / 协议引用末段)。 */
  name: string;
  /** 小写扩展名,不带点;拿不到时为空串。 */
  ext: string;
  /**
   * 本机绝对路径。协议引用类交付物为 null —— 媒体仓绝对路径不出主进程
   * (media-storage-and-protocols.md「不把媒体仓绝对路径直接暴露给 Renderer」)。
   */
  path: string | null;
  /** Cindy 协议地址(cindy-media:// / xdt-*://);非协议来源为 null。 */
  ref: string | null;
  /** 字节数;取不到为 null。 */
  sizeBytes: number | null;
  /** 交付时间(unix ms)。委派取终态时间,消息来源取消息落库时间。 */
  createdAt: number;
  /** 产出该件的会话;委派来源取子任务 id(可能为 null)。 */
  sessionId: string | null;
  /** 委派来源的委派 id;其余为 null。 */
  delegationId: string | null;
}

export interface BotArtifactProjection {
  botId: string;
  items: BotArtifactItem[];
  /** 命中上限、更早的交付物被截断。 */
  truncated: boolean;
}

/** 单次投影返回的交付物上限。超出按时间倒序截断,老的丢弃。 */
export const BOT_ARTIFACT_LIMIT = 200;

/** 扫描伙伴会话消息的行数上限。投影是右栏面板,不是全量索引。 */
export const BOT_ARTIFACT_MESSAGE_SCAN_LIMIT = 4000;

const DOC_EXTS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'odt', 'pages',
]);
const SHEET_EXTS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'ods', 'numbers']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif']);
const DECK_EXTS = new Set(['ppt', 'pptx', 'odp', 'key']);

/**
 * 取展示名:路径 / 协议地址的最后一段,去掉 query 与 hash。
 * 拿不到时回原串(截断到可读长度),绝不返回空串。
 */
export function botArtifactDisplayName(refOrPath: string): string {
  const raw = refOrPath.trim();
  if (!raw) return '';
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? raw;
  const segments = withoutQuery.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const tail = segments.length > 0 ? segments[segments.length - 1]! : withoutQuery;
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    // 非法百分号转义:原样用,不因为一个坏名字丢掉整件交付物。
  }
  return decoded.slice(0, 200) || raw.slice(0, 200);
}

/** 取小写扩展名(不带点);无扩展名返回空串。 */
export function botArtifactExtension(refOrPath: string): string {
  const name = botArtifactDisplayName(refOrPath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  // 扩展名形态:纯字母数字且不过长。`v1.2` / `report.2026` 这类不算扩展名。
  return /^[a-z0-9]{1,8}$/.test(ext) && /[a-z]/.test(ext) ? ext : '';
}

/**
 * 分类。协议 scheme 优先(`xdt-image://` 一定是图片,哪怕地址没有扩展名),
 * 否则按扩展名走四型表,都不中则 `other`。
 */
export function classifyBotArtifact(refOrPath: string): BotArtifactCategory {
  const raw = refOrPath.trim();
  if (raw.startsWith('xdt-image://')) return 'image';
  if (raw.startsWith('xdt-video://') || raw.startsWith('xdt-audio://')) return 'other';
  const ext = botArtifactExtension(raw);
  if (!ext) return 'other';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (SHEET_EXTS.has(ext)) return 'sheet';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (DECK_EXTS.has(ext)) return 'deck';
  return 'other';
}

export interface MakeBotArtifactInput {
  source: BotArtifactSource;
  /** 本机绝对路径,或 Cindy 协议地址(由 `isRef` 区分)。 */
  target: string;
  isRef: boolean;
  /** 展示名;不给则从 target 末段推。 */
  name?: string | undefined;
  sizeBytes?: number | null | undefined;
  createdAt: number;
  sessionId?: string | null | undefined;
  delegationId?: string | null | undefined;
}

/** 唯一的 BotArtifactItem 构造口:main 投影与 renderer 就地构造共用,分类口径不漂。 */
export function makeBotArtifact(input: MakeBotArtifactInput): BotArtifactItem {
  const name = input.name && input.name.trim()
    ? input.name.trim()
    : botArtifactDisplayName(input.target);
  const item: BotArtifactItem = {
    id: '',
    source: input.source,
    category: classifyBotArtifact(input.target),
    name,
    ext: botArtifactExtension(input.target),
    path: input.isRef ? null : input.target,
    ref: input.isRef ? input.target : null,
    sizeBytes: input.sizeBytes ?? null,
    createdAt: input.createdAt,
    sessionId: input.sessionId ?? null,
    delegationId: input.delegationId ?? null,
  };
  item.id = botArtifactDedupeKey(item);
  return item;
}

/**
 * 去重 key。同一件东西可能同时被两条来源看到(例如伙伴写出一个文件、又把它
 * 作为委派产物回传),仓库里只应出现一次。
 *
 * Windows 形态路径大小写不敏感折叠,POSIX 保留原大小写 —— 与 generatedFiles.ts
 * 的 dedupeKeyForPath 同一取舍:宁可 macOS 偶尔多一件,也不能在 Linux 上丢文件。
 */
export function botArtifactDedupeKey(item: Pick<BotArtifactItem, 'path' | 'ref'>): string {
  const target = item.ref ?? item.path ?? '';
  const isWindowsShape = /^[a-zA-Z]:[\\/]/.test(target) || target.includes('\\');
  if (!isWindowsShape) return target;
  return target.replace(/\//g, '\\').replace(/(?<!^)\\{2,}/g, '\\').toLowerCase();
}
