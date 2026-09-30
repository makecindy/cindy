/**
 * Transport — codex app-server JSON-RPC NDJSON 字节流的双向 transport 抽象。
 *
 * 设计动机:
 *   `AppServerClient` 协议层只跟 "一行行 JSON" 打交道, 跟字节流从哪来无关。把
 *   字节流抽象到这个 interface 后, 同一份 client 能同时驱动:
 *     - StdioTransport: 本地 spawn `codex app-server`, 接 stdin/stdout (历史行为)
 *     - SshDaemonTransport: 远端 `codex app-server daemon` + 本地 ssh exec
 *       `codex app-server proxy --sock <path>` 桥接的 ws stream
 *   两种 transport 对 client 表现完全一致 (writeLine + onLine + onClose)。
 *
 * 协议无关性:
 *   transport 只搬字节流, 不解析 JSON, 不识别 method, 不做 framing 之外的握手。
 *   maxLineBytes / 协议错误处理 全部由 client 层负责。
 *
 * 错误模型:
 *   - writeLine() reject = "这一行没写出去" (caller 自行决定怎么处理)
 *   - onClose 触发 = "transport 已经断了" (重连由上层 / 不在 transport 责任内)
 *   - transport 内部任何异步错误都最终走 onClose(reason)
 */

/**
 * 一条 NDJSON 行 (不含尾部 `\n`)。callback 必须 sync return — 不允许 async
 * 处理时序, 否则消息顺序无法保证。
 */
export type LineHandler = (line: string) => void;

/**
 * Stderr / 协议外诊断行 (transport 看到了, 但不是 NDJSON 协议消息)。
 * StdioTransport 用它把子进程 stderr 暴露上来; SshDaemonTransport 用它把
 * ssh channel 的 stderr (远端 proxy 命令的 stderr) 暴露上来。
 */
export type StderrHandler = (line: string) => void;

export interface TransportCloseInfo {
  /** 人类可读的关闭原因, 上层 toast / 日志 用。 */
  reason: string;
}

export type CloseHandler = (info: TransportCloseInfo) => void;

/**
 * 字节流双向 transport。一个 transport 实例只服务一个 client (1:1)。
 */
export interface Transport {
  /** Local native SQLite bootstrap failed before any stdout, with a confirmed natural exit. */
  nativeSqliteInitializationFailed?(): boolean;
  /**
   * 把一行 NDJSON 异步写到对端。promise resolve 仅表示字节进入了
   * 操作系统 buffer (或 ws send buffer), 不保证对端收到 / 处理。
   * reject = "这一行没写出去"。
   */
  writeLine(line: string): Promise<void>;

  /**
   * 注册逐行 NDJSON 回调。同一个 transport 上可注册多个 handler (fan-out),
   * 返回 unsubscribe 函数。
   */
  onLine(handler: LineHandler): () => void;

  /**
   * (可选) 注册诊断 stderr handler。transport 实现可不提供 (返回空 unsubscribe)。
   */
  onStderr?(handler: StderrHandler): () => void;

  /**
   * 注册关闭回调。transport 主动关 / 对端断开 / 致命错误 都触发, 触发后
   * 此 transport 不再可用 — 再调 writeLine 一律 reject。
   */
  onClose(handler: CloseHandler): () => void;

  /**
   * 主动关闭 transport (我们的 client 想结束 session)。幂等。
   * resolve 后, transport 内部资源 (子进程 / ssh channel / ws 状态) 已释放。
   */
  close(reason?: string): Promise<void>;
}
