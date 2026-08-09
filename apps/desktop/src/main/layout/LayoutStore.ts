import fs from 'node:fs';

import {
  coerceLayout,
  createDefaultLayoutPreservingGhostPanels,
  validateLayout,
  type Layout,
} from '../../shared/layoutTree.js';

/** 布局存档文件名(userData 下)。v1 后缀跟随 schemaVersion,未来迁移换文件名。 */
export const LAYOUT_FILE_NAME = 'layout.v1.json';

/** 注入式日志接口 —— store 不直接依赖 main/logger,单测零 electron。 */
export interface LayoutStoreLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface LayoutStoreOptions {
  /** 存档文件绝对路径(生产:userData/layout.v1.json;测试:os.tmpdir 下临时目录)。 */
  getFilePath: () => string;
  /** 布局变化时通知(index.ts 用它广播 layout:changed 到所有窗口)。 */
  onChanged?: (layout: Layout) => void;
  log?: LayoutStoreLogger;
}

export interface LayoutMutationResult {
  layout: Layout;
  /** 内存布局已应用；该标记只说明同一布局是否也成功写入用户存档。 */
  persisted: boolean;
}

/**
 * 主界面布局树的 main 端持久化 source of truth。
 *
 * 持久化契约(docs/dev-rules/architecture-invariants.md):
 * - 全局**一份**布局,不随 session 变形;
 * - 同步 R/W(文件极小,不卡 UI;renderer 首帧靠 sendSync 拉取,遵守规则 7
 *   「第一帧就是用户布局,禁止先默认后跳变」);
 * - 读路径**自愈**:文件缺失 / 损坏 / 校验失败一律回退默认树,并立即把合法
 *   默认树重写回磁盘 —— 「把存档改坏 → 重启自动复原」的行为来源;
 * - 写路径**严格**:setLayout 收到非法树是调用方 bug,拒绝并返回原因,
 *   绝不悄悄写默认(与读路径的宽容语义刻意相反);
 * - 原子写:tmp + rename,防写一半断电产生半截 JSON;
 * - 校验逻辑全部来自 shared/layoutTree,与 renderer 同一份,不漂移。
 */
export class LayoutStore {
  private cached: Layout | null = null;

  constructor(private readonly options: LayoutStoreOptions) {}

  /** 读取当前布局(带内存缓存)。任何异常路径都返回合法树,永不抛。 */
  getLayout(): Layout {
    if (this.cached) return this.cached;
    const file = this.options.getFilePath();
    let raw: unknown = null;
    let readError: string | null = null;
    try {
      if (fs.existsSync(file)) {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } else {
        readError = 'file missing';
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    const { layout, fallback, reason } = coerceLayout(raw);
    this.cached = layout;
    if (fallback) {
      // 自愈:损坏 / 缺失的存档立即重写为合法默认树。
      this.options.log?.warn('layout store falling back to default layout', {
        path: file,
        readError,
        reason,
      });
      this.persist(layout);
    }
    return layout;
  }

  /**
   * 写入新布局。输入非法时拒绝(返回 rejection 原因,文件与缓存均不变)——
   * IPC 层负责把 rejection 映射为 throwIpcError,store 保持纯业务返回。
   */
  setLayout(raw: unknown): LayoutMutationResult | { rejection: string } {
    let cloned: Layout;
    try {
      cloned = structuredClone(raw) as Layout;
    } catch {
      return { rejection: 'layout is not cloneable' };
    }
    const v = validateLayout(cloned);
    if (!v.ok) return { rejection: v.reason };

    this.cached = cloned;
    const persisted = this.persist(cloned);
    this.options.onChanged?.(cloned);
    return { layout: cloned, persisted };
  }

  /** 重置为默认布局(等价 WoW /resetui):写盘 + 广播。 */
  reset(): LayoutMutationResult {
    const layout = createDefaultLayoutPreservingGhostPanels(this.getLayout());
    this.cached = layout;
    const persisted = this.persist(layout);
    this.options.onChanged?.(layout);
    return { layout, persisted };
  }

  /** 启动时调用:文件不存在则落一份默认树(QA 口径:启动后 userData 出现 layout.v1.json)。 */
  ensurePersisted(): void {
    const file = this.options.getFilePath();
    if (fs.existsSync(file)) {
      // 顺便触发一次读取:损坏文件在启动时即自愈,而不是等首个消费方。
      this.getLayout();
      return;
    }
    this.persist(this.getLayout());
  }

  /** 原子写盘。失败只记日志并返回 false —— 调用方可反馈，但不打断布局内存态。 */
  private persist(layout: Layout): boolean {
    const file = this.options.getFilePath();
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(layout, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      this.options.log?.warn('layout store persist failed', {
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件可能从未创建，或清理本身被文件系统拒绝；两者都不掩盖原始失败。
      }
      return false;
    }
  }
}
