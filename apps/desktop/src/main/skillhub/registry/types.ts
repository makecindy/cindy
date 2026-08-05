// ── 核心存储类型 ─────────────────────────────────────────────────────────────

import type { LearnProvenance } from '../../../shared/learnTypes';

export interface StoredInstall {
  /** 市场版本号字符串。注意:与 server latestVersion 类型对齐(string,非 number)。
   *  install 流程内部 String(info.version) 转换。空字符串视作"未知版本"。 */
  version: string;
  /** 该 skill 在 server 上记录的作者 userId。设备级事实，与登录用户无关。
   *  install/sync/publish 时由 server 数据写入；老 manifest 缺失时 IO 层兜底为空串。
   *  空串视作"未知作者"——任何 currentUserId 都不会与之匹配。 */
  authorId: string;
  /** sha256 hex(64 字符,无前缀),沿用 folderHash 算法。 */
  folderHash: string;
  /** unix seconds(非毫秒)。 */
  installedAt: number;
  /** unix seconds。update / publish 同步时刷新。 */
  updatedAt: number;
  /** 本地来源：'installed' = 从市场安装,'published' = 本地创建后发布,
   *  'learned' = /learn 蒸馏产物(经 diff 审查确认后落盘)。
   *  影响 UI 是否显示"卸载"按钮（只有 installed 才有卸载概念）。
   *  历史遗留数据可能缺此字段；读取层不强制补默认值。
   *  renderer 会结合 server isMine 做保守推断：明确是别人的历史 registry 才视作
   *  installed，自己的会通过 reconcile 回填为 published，本地手写 / 市场不存在的 skill
   *  不因此显示卸载。 */
  origin?: 'installed' | 'published' | 'learned';
  /** 是否由产品自动同步流程安装。用于区分普通市场安装与用户可 opt-out 的自动同步安装。 */
  autoSynced?: boolean;
  /** /learn 蒸馏产物的溯源(仅 origin='learned' 时存在)。
   *  provenance.personal=true ⇒ 含本地会话衍生内容。当前不拦截发布 ——
   *  作为将来「发布前泛化」流程(另行独立 PR)的判定依据保留。 */
  provenance?: LearnProvenance;
}

export interface StoredManifest {
  schemaVersion: 1;
  /** 自校验:必须等于文件名(去 .json)。不一致即抛 RegistryCorruptedError。 */
  skillName: string;
  /** key = path.normalize 后的绝对 installPath。 */
  installs: Record<string, StoredInstall>;
}

// ── 错误类 ───────────────────────────────────────────────────────────────────

export class RegistryError extends Error {
  constructor(
    public code:
      | 'REGISTRY_CORRUPTED'    // 文件 skillName 与传入参数不符 / JSON 损坏
      | 'REGISTRY_INVALID_NAME' // skillName 不通过 sanitization 校验
      | 'REGISTRY_IO_FAILED',   // 文件系统底层错误
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

// ── 派生类型(纯函数,不写盘) ──────────────────────────────────────────────────

export type SkillScope = 'global' | 'project';
