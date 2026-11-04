/**
 * 任务导入器（session-import）的公共类型。
 *
 * 每个来源一个适配器（sources/*.ts），是唯一懂该来源格式的代码：发现、列出、识别、
 * 读取、复制原生资料、加载验证都在里面完成。扫描、导入、显示与续做全部共用同一个
 * 适配器给出的结论，不再各写一套判断。
 */

import type { ImportSourceId, NativeHarness } from '../../shared/sessionImport.js';

export {
  IMPORT_SOURCE_IDS,
  isImportSourceId,
  type HiddenCategory,
  type ImportCandidate,
  type ImportItemIssue,
  type ImportItemStatus,
  type ImportItemStep,
  type ImportItemView,
  type ImportJobView,
  type ImportScanResult,
  type ImportSourceId,
  type NativeHarness,
} from '../../shared/sessionImport.js';

/** 适配器列出的一条来源任务。locator 只在主进程内使用，不发给界面。 */
export interface SourceSession {
  source: ImportSourceId;
  /** 来源内稳定的任务身份；每个来源只有一处识别代码产出它。 */
  sourceSessionId: string;
  title: string;
  /** 原工作目录；来源没有记录时为 null。 */
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** 需要读取/复制的原始资料总字节数（用于预估时间与磁盘）。 */
  sizeBytes: number;
  /** 适配器私有定位信息（文件路径、数据库主键等）。 */
  locator: string;
  /** 来源自己标记为「不属于任何项目」的对话。 */
  dialogue?: boolean;
  /** 来源格式版本未适配：列出但不允许导入。 */
  unsupportedVersion?: string;
  /** 记录是某个 Cindy 自己运行的任务（带 Cindy 附加的说明），默认隐藏。 */
  ranByCindy?: boolean;
}

/** 扫描时的上下文。 */
export interface ScanContext {
  homeDir: string;
  /** 来源被 Cindy 自己当作运行目录时（例如 Cindy 的私有 codex-home）要排除。 */
  cindyUserDataDir: string | null;
  signal?: AbortSignal;
}

export interface SourceListResult {
  sessions: SourceSession[];
  /** 来源内部会话（自动审查、子 Agent 等），只计数。 */
  internalCount: number;
  /** 发现但读取失败的数量。 */
  unreadableCount: number;
}

/** 写入 Cindy 前的统一消息形态。images 由写入层入统一媒体库后换成地址。 */
export interface NormalizedImage {
  mimeType: string;
  base64Data?: string;
  filePath?: string;
}

export type NormalizedRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';

export interface NormalizedMessage {
  /** 本任务内稳定的行键（同一来源行重复读取得到相同的键），用于幂等写入。 */
  key: string;
  role: NormalizedRole;
  /**
   * user：文本字符串；assistant：文本；tool_use：{ toolUseId, toolName, input }；
   * tool_result：文本；thinking：{ text, durationMs, isRedacted }。
   */
  content: unknown;
  images?: NormalizedImage[];
  toolUseId?: string | null;
  agentMeta?: Record<string, unknown> | null;
  createdAt: number;
}

export interface ReadContext {
  /** 目标 Cindy 任务 id。 */
  cindySessionId: string;
  /** 原生续做副本的编号（Claude Code 换了新编号）；消息元数据按它记录。 */
  nativeSessionId?: string;
  signal?: AbortSignal;
  /** 已读取的原始字节数，用于真实进度。 */
  onBytes?: (bytes: number) => void;
  /** 发起导入的账号。原生副本的新编号按账号与目标任务生成，别的账号或重新导入不会覆盖已续做的副本。 */
  ownerId?: string;
  /** 原生续做时任务的路由；Codex 按它写入 Cindy 恢复时会用的 provider 身份。 */
  route?: { providerId: string | null; model: string };
}

export interface NativeMaterialization {
  /** Cindy 侧原生会话编号（Pi 为会话文件绝对路径）。 */
  sdkSessionId: string;
  /** 由原生记录推断的模型；缺省用新任务默认。 */
  model?: string;
  /** 由原生记录统计的用量。 */
  tokensUsed?: number;
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing-dir' | 'native-unloadable'; detail?: string };

export interface SourceAdapter {
  id: ImportSourceId;
  /** 界面显示名（不翻译）。 */
  label: string;
  /** 能原样续做时对应的 Cindy 引擎；未设置 = 换引擎续做。 */
  native?: NativeHarness;
  list(ctx: ScanContext): Promise<SourceListResult>;
  /** 流式读取完整历史。 */
  read(session: SourceSession, ctx: ReadContext): AsyncIterable<NormalizedMessage>;
  /** 原生续做：把原生资料复制到 Cindy 自管位置（原文件一个字节都不改）。 */
  materialize?(session: SourceSession, ctx: ReadContext): Promise<NativeMaterialization>;
  /** 原生续做：用对应引擎的读取方式实际加载一次（不调用模型）。 */
  verify?(materialized: NativeMaterialization, session: SourceSession): Promise<VerifyOutcome>;
}
