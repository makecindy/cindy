/**
 * apps/desktop/src/main/agent-binaries/types.ts
 *
 * Agent 二进制下载/管理相关类型定义。
 *
 * 历史: 这些类型原本在 vendor/types.ts (Boss 1 抽象骨架, frozen v1.0 2026-04-29 §5.1-5.2),
 * 跟 binary 无关的 VendorSession / UsageExtractor / AuthAdapter 还留在 vendor/types.ts,
 * 等飞书 bot 切 maker.* 后跟 agentManager 一起退役。
 */

// ===== §5.1 VendorKey =====
/** @frozen v1.0(additive: 2026-08 增补 'pi') */
export type VendorKey = 'claude' | 'codex' | 'pi';

// ===== §5.2 BinaryProvisionerConfig =====
/** @frozen v1.0(additive: 2026-08 增补 tar-gz-dir artifact 与 optionalAsset) */
export interface BinaryProvisionerConfig {
  vendorKey: VendorKey;
  manifestField: string;            // manifest 中该 vendor 的字段名 e.g. <vendor-field>
  installSubdir: string;            // userData 下的安装目录名 e.g. <install-subdir>
  artifact:
    | { kind: 'gz'; binaryName: string }
    | { kind: 'raw'; binaryName: string }
    /**
     * 整目录分发:CDN 资产是 tar.gz,解压后归档根即完整运行时目录
     * (主执行文件 + 旁侧资产,与 apps/<vendor>-bin/<platform>/ 同布局)。
     * 归档根若嵌套一层与主执行文件同名的目录(上游 Unix 包习惯),解压时容错上移。
     */
    | { kind: 'tar-gz-dir'; binaryName: string };
  /**
   * true = 该 vendor 是可选资产:manifest 缺字段时 peekNeedsDownload 返回 false
   * (不存在可下载的资产,不该计入 splash 下载步数),prepare 仍会以 asset_missing
   * 失败交由调用方降级。cc/codex 这类必装 vendor 缺省 false(缺字段视为需要下载,
   * 走 prepare 的完整错误流程)。
   */
  optionalAsset?: boolean;
}

// ===== §5.2 VendorRuntimeState =====
/** @frozen v1.0 */
export interface VendorRuntimeState {
  status: 'not_installed' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'failed';
  installedVersion?: string;
  availableVersion?: string;
  binaryPath?: string;
  downloadProgress?: { received: number; total: number; speedBps: number };
  error?: { code: string; message: string };
}

// ===== §5.2 BinaryProvisioner =====
/** @frozen v1.0 */
export interface BinaryProvisioner {
  /** 不触发下载，仅返回当前状态。Renderer 用来决定是否需要触发 prepare */
  getState(): Promise<VendorRuntimeState>;

  /** 显式触发安装/升级流程；幂等：本地已有正确版本时立即返回 ready: true */
  prepare(opts?: {
    onProgress?: (p: VendorRuntimeState) => void;
    /** 取消排队、下载或重试等待；已完成的本地命中不受影响。 */
    signal?: AbortSignal;
  }): Promise<{ ready: boolean; binaryPath: string; error?: string }>;

  /**
   * 不触发任何下载，仅判断"如果调 prepare() 是否会发生 OSS 下载"。
   * 复用 cached manifest（splash phase 1 已 fetch）+ 本地 isInstalled+.verified 检查。
   * dev 模式下 host 包壳层应在调用前自行短路（dev 永不走 OSS）。
   */
  peekNeedsDownload(): Promise<boolean>;

  /** 清理旧版本 */
  cleanup(keepVersion: string): Promise<void>;
}

// ── 上层包壳类型 (供 prepare(kind, opts) 使用) ──────────────────────────────

export interface PrepareOpts {
  /** D 场景顺序下载阶段标记，会写进 IPC payload 给 splash 显示 (x/y) 文案。 */
  step?: 1 | 2 | 3;
  /** D 场景 = 本次需要下载的 vendor 数(2 或 3);B/C 场景缺省。 */
  totalSteps?: 2 | 3;
  /** false 时不广播 'binary-download-progress' (lazy 调用路径)。缺省 true (splash 路径)。 */
  broadcastProgress?: boolean;
  /**
   * false 时失败不广播 failed payload(splash 收到 failed 会立即进失败态)。
   * 供可选 vendor(pi)使用:下载失败时本次禁用 pi,不打断启动。
   * 缺省 true(cc/codex 必装,失败要让 splash 显示重试)。
   */
  broadcastFailure?: boolean;
  /** 允许宿主在退出或启动 deadline 到期时取消受管下载或 Linux 私有安装。 */
  signal?: AbortSignal;
}

export interface PrepareResult {
  ready: boolean;
  path?: string;
  error?: string;
  /** 本次 prepare 是否触发了真实下载 (true=下了; false=cache 命中或 dev 短路)。 */
  downloaded?: boolean;
}

/** Splash 进度 IPC payload (channel: 'binary-download-progress')。 */
export interface BinaryDownloadProgressPayload {
  progress: number;
  speed?: string;
  downloaded?: string;
  total?: string;
  failed?: boolean;
  error?: string;
  step?: 1 | 2 | 3;
  totalSteps?: 2 | 3;
  reset?: boolean;
  vendor?: VendorKey;
}

/** 同步 binary 状态快查结果 (DropdownMenu / maker-host 用)。 */
export interface CachedBinaryStatus {
  binaryReady: boolean;
  binaryPath?: string;
}
