/**
 * RSB terminal tab 在 main / preload / renderer 之间共享的 typing。
 *
 * preload 把 main 进程的 TERMINAL_INVOKE / TERMINAL_PUSH 通道再封装一层 `window.electronAPI.terminal`，
 * renderer 走类型走这里。channel 字符串常量本身保留在 `main/maker-ipc/channels.ts`，
 * preload 内联字面量；这里只定义 payload / 入参 shape。
 */

export type ShellId =
  | 'auto'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'gitbash'
  | 'wsl';

export interface AvailableShell {
  id: Exclude<ShellId, 'auto'>;
  command: string;
  displayName: string;
  isAutoDetectTarget: boolean;
}

/** Task location; omitted deviceId means a task stored on this desktop. */
export interface RemoteTerminalContext {
  sessionId: string;
  deviceId?: string | null;
}

/** Prepare a tab's launch; an explicit connection submits and saves its non-secret binding. */
export interface TerminalDescribeRemoteParams extends RemoteTerminalContext {
  id: string;
  connection?: RemoteTerminalConnection;
}

/** Non-secret OpenSSH settings. Authentication happens inside the terminal. */
export interface RemoteTerminalConnection {
  host: string;
  user?: string;
  port?: number;
  /** Opaque main-issued reference; credential paths never cross this bridge. */
  hostRef?: string;
}

/** Main resolves the task's directory and suggests controller-local SSH aliases. */
export interface RemoteTerminalDescription {
  context: RemoteTerminalContext;
  target: { key: string; label: string; cwd: string };
  connection: RemoteTerminalConnection | null;
  candidates: RemoteTerminalConnection[];
}

export interface TerminalCreateParams {
  /** 跟 RSB tabId 一致（1:1 关系）。 */
  id: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Settings 用户偏好；不传走 main 端的 GET_DEFAULT_SHELL_PREF。 */
  shellPref?: ShellId | null;
  /** Uses the task's authoritative remote cwd; cwd above is never used locally. */
  remote?: RemoteTerminalContext & { ticket?: string };
}

export interface TerminalCreateResult {
  shellId: Exclude<ShellId, 'auto'>;
  shellDisplayName: string;
  pid: number;
}

export interface TerminalExitInfo {
  code: number | null;
  signal: string | null;
}

/** main → renderer 推送的 data event payload。 */
export interface TerminalDataEvent {
  id: string;
  chunk: string;
}

/** main → renderer 推送的 exit event payload。 */
export interface TerminalExitEvent {
  id: string;
  exit: TerminalExitInfo;
}

/** preload 暴露给 renderer 的 terminal API 形状。 */
export interface TerminalBridge {
  /** Async preparation; explicit connection saves a binding. Tickets expire after 30 seconds. */
  describeRemote(params: TerminalDescribeRemoteParams): Promise<RemoteTerminalDescription & { ticket?: string }>;
  /** Main attaches by id and original remote context, or consumes this window/tab's launch ticket. */
  create(params: TerminalCreateParams): Promise<TerminalCreateResult>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  /** Closing from another window requires the original task/device context. */
  dispose(id: string, context?: RemoteTerminalContext): Promise<void>;
  restart(id: string): Promise<TerminalCreateResult>;
  listAvailableShells(): Promise<AvailableShell[]>;
  getDefaultShellPref(): Promise<ShellId>;
  setDefaultShellPref(value: ShellId): Promise<void>;
  /** 订阅 PTY 输出。回调每条 onData 都会被调；renderer 自己按 id filter。 */
  onData(callback: (event: TerminalDataEvent) => void): () => void;
  /** 订阅 PTY 退出。 */
  onExit(callback: (event: TerminalExitEvent) => void): () => void;
}
