/**
 * fakeClaudeAgentSdk — 打桩的 `@anthropic-ai/claude-agent-sdk`,只供 SSH 生命周期
 * 集成测试打包「真实 cc-mgr daemon」时使用。
 *
 * 真实 daemon(`packages/maker-cc-manager/src/bin/cc-mgr.ts`)在运行时 import 这个
 * 包来创建 SDK Query。集成测试用 esbuild 把本文件 alias 进**生产 daemon 包体**:
 * 除了 SDK 之外,daemon 主循环、SessionRegistry、NDJSON 协议、`cc-mgr bridge`
 * 子命令全部是生产代码路径,唯一被替换的是「会 spawn claude CLI 并联网」的那一层。
 *
 * 为什么不直接用真 SDK:真 SDK 会拉起 claude 子进程并需要真实账号凭据,既违反
 * 隔离要求,也会让「回合结束」依赖网络。本文件只回放固定事件:
 *   - 建连即产出 system/init(daemon 据此认定 session 已就绪)
 *   - 每收到一条用户消息,产出 assistant + result(result = 一回合结束)
 *
 * 不读环境变量里的任何凭据,不发任何网络请求,不 spawn 任何子进程。
 */

/** 真 SDK `query()` 的入参形状(只声明本测试关心的字段)。 */
export interface FakeSdkQueryArgs {
  /** 真 SDK 接受 string 或 AsyncIterable;daemon 传的是 push 队列。 */
  prompt: unknown;
  options?: Record<string, unknown>;
}

/** daemon 侧 registry 用到的 Query 能力子集(与 SdkQueryLike 对齐)。 */
export interface FakeSdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  getContextUsage(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}

/**
 * 造一个假 Query:先给 init,之后每条输入回一条 assistant + 一条 result。
 *
 * 生成器在输入流结束时自然结束 —— daemon 的 kill 路径(interrupt → 输入队列
 * end → 生成器 return)因此能真的把 consume loop 退出,而不是靠超时兜底。
 */
export function query(args: FakeSdkQueryArgs): FakeSdkQuery {
  const inputStream = args.prompt as AsyncIterable<unknown>;
  const options = args.options ?? {};
  let closed = false;

  async function* events(): AsyncGenerator<unknown> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-fake-0001',
      cwd: typeof options.cwd === 'string' ? options.cwd : '',
      model: typeof options.model === 'string' ? options.model : '',
      mcp_servers: [],
    };
    for await (const userMessage of inputStream) {
      if (closed) break;
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo: ${JSON.stringify(userMessage)}` }],
        },
      };
      yield { type: 'result', subtype: 'success', result: 'done' };
    }
  }

  const iterator = events();
  return {
    [Symbol.asyncIterator]: () => iterator,
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    async applyFlagSettings() {},
    async getContextUsage() {
      return {
        categories: [],
        totalTokens: 0,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 0,
        gridRows: [],
        model: typeof options.model === 'string' ? options.model : '',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: false,
        apiUsage: null,
      };
    },
    async stopTask() {},
    close() {
      closed = true;
    },
  };
}
