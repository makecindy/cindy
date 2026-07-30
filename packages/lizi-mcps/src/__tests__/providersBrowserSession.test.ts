// cindy_browser provider 的 __mcpSessionId 注入契约:
//  - sessionId 必须在 tool-call 时解析(AsyncLocalStorage 优先,闭包 ctx 兜底),
//    不能在 server factory 期绑死 —— Codex HTTP bridge 的 factory 阶段 ctx 是
//    全局空值,绑死会让 Codex agent 的浏览器请求退回 host 端 UI-焦点推断,
//    tab 落进用户正在看的无关 session(跨会话串扰的主根因)。
//  - 两条路径都解析不到 sessionId 时原样透传请求(host 端 fallback 生效)。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';

// 捕获 createBrowserMcpServer 收到的 deps(含 wrap 后的 getRuntime),
// 不真的起 McpServer。
const capturedDeps: Array<{ getRuntime(): { call(req: unknown): unknown } }> = [];
vi.mock('../browser/index.js', () => ({
  createBrowserMcpServer: (deps: { getRuntime(): { call(req: unknown): unknown } }) => {
    capturedDeps.push(deps);
    return { __fake: 'mcp-server' };
  },
}));

// capturedDeps 是模块级的,必须每条用例前清空:某条用例在 pop 之前就失败退出
// 时会留下残条,后续用例 pop 到上一条的 deps → 顺序依赖 / 偶发失败。
beforeEach(() => {
  capturedDeps.length = 0;
  vi.clearAllMocks();
});

function buildWrappedRuntime(factoryCtx: {
  agentKind: string;
  workingDir: string;
  sessionId?: string;
}) {
  const innerCall = vi.fn(async (req: unknown) => ({ ok: true, req }));
  const provider = createLiziMcpProviders({
    browser: { getRuntime: () => ({ call: innerCall }) as never },
  }).find((p) => p.name === 'cindy_browser');
  expect(provider).toBeDefined();
  provider!.toClaudeSdkConfig(factoryCtx);
  // 恰好一条:配合 beforeEach 的清空,断言本次 factory 调用就是这条 deps 的来源,
  // 而不是盲目 pop 一个可能来自别处的残留。
  expect(capturedDeps).toHaveLength(1);
  return { runtime: capturedDeps[0]!.getRuntime(), innerCall };
}

describe('cindy_browser provider — __mcpSessionId 注入', () => {
  it('Claude 路径:factory ctx 自带 sessionId,直接注入', async () => {
    const { runtime, innerCall } = buildWrappedRuntime({
      agentKind: 'claude-code',
      workingDir: '/w',
      sessionId: 'claude-session',
    });
    await runtime.call({ action: 'status' });
    expect(innerCall).toHaveBeenCalledWith({
      action: 'status',
      __mcpSessionId: 'claude-session',
    });
  });

  it('Codex 路径:factory ctx 为空,tool-call 时从 AsyncLocalStorage 取', async () => {
    const { runtime, innerCall } = buildWrappedRuntime({
      agentKind: 'codex',
      workingDir: '',
      // Codex HTTP bridge factory 阶段没有 sessionId。
    });
    await runWithLiziMcpSessionContext(
      { agentKind: 'codex', workingDir: '/w', sessionId: 'codex-thread-session' },
      () => runtime.call({ action: 'open', url: 'https://x.test' }),
    );
    expect(innerCall).toHaveBeenCalledWith({
      action: 'open',
      url: 'https://x.test',
      __mcpSessionId: 'codex-thread-session',
    });
  });

  it('两条路径都无 sessionId 时原样透传(host 端 fallback 生效)', async () => {
    const { runtime, innerCall } = buildWrappedRuntime({
      agentKind: 'codex',
      workingDir: '',
    });
    await runtime.call({ action: 'status' });
    expect(innerCall).toHaveBeenCalledWith({ action: 'status' });
  });
});
