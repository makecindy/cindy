# Orca 换路线工具：上下文与前缀实测

日期：2026-11-18（Pacific/Auckland）。对应 PR #11071 的 tool/MCP 暴露审查。
基线 `a01ed660fe79f5803d99224f604bd885f5f14b15`，功能提交
`b4ab95c48789b20c46a6914f315a20ebefa2f98b`。
环境：macOS ARM64，Node 22.21.1，Claude Code 2.1.322，模型标识 `claude-opus-5-5`。

## 方法与范围

使用两版实际 `createOrcaMcpServer` 工厂，通过 MCP SDK 的 `StdioServerTransport`
启动真实 server。会话上下文固定为测试用 Lead；Host 业务回调替换为返回
`{ok:false,error:'MEASUREMENT_ONLY'}` 的函数，故不会创建团队、派活或修改用户任务。
生产注册函数与 JSON schema 未替换。基线源码用 `git archive` 解出，使用同一套已安装依赖。

Claude 原生进程通过 stdio 完成 MCP 初始化后，在 `stream-json` 输入里执行 `/context`；
先检查 init 回执 `cindy_orca.status=connected`，避免把未加载 MCP 的空上下文计为结果。
两版各启动两次，模型、工作目录、权限配置及工具配置保持相同，关闭原生工具与工具搜索，
只加载 `cindy_orca`。这是原生 `/context` 的估算 token 对比，不是厂商账单或缓存命中率采样。
所有有效回执 `duration_api_ms=0`、`total_cost_usd=0`，未发送推理请求。

另用真实 MCP Client 在同一连接内连续调用 `tools/list` 各 20 次，测完整清单的 UTF-8 字节数、
SHA-256、顺序与往返耗时。helper 用实际 `createXdtHelperMcpServer` 与内存 MCP transport，
只注入 sessionControl 测试回调，对比顶层 `tools/list` 及按名称读取 `set_session_runtime` 的结果。
这是最小工具暴露环境，未启动完整 Desktop，也不代表全部插件启用时的总上下文。

## 数据

| 指标 | 改动前 | 改动后 | 结论 |
| --- | --- | --- | --- |
| Orca 顶层工具数 | 21 | 22 | 仅增加 `set_worker_runtime` |
| `/context` MCP tools | 17k | 18k | 固定上下文增加约 1k，原生输出有舍入 |
| `/context` 总上下文 | 19.5k | 20.5k | 1M 窗口显示均为 2% |
| 新工具单项估算 | 无 | 1.1k | 新增固定 schema 成本 |
| 系统提示 / 消息 | 2.5k / 10 | 2.5k / 10 | 未增加易变 system 内容 |
| 完整 Orca manifest 字节 | 41517 | 43969 | 增加 2452 字节 |
| 每版 20 次 manifest 的不同 hash 数 | 1 | 1 | 同一版清单稳定 |
| `tools/list` p50 | 0.967 ms | 1.108 ms | 差 0.141 ms，仅为本地清单读取样本 |
| `tools/list` p95 | 1.396 ms | 1.466 ms | 差 0.070 ms；不推断模型首字延迟 |
| helper 顶层清单字节 | 2027 | 2027 | 字节与 hash 均相同 |

两次 `/context` 运行在每一版上得到相同的上述 token 分类与单项工具估算。
21 个既有 Orca 工具的定义逐项相同，插入新工具后既有工具的相对顺序不变。
helper 顶层仍仅 `list_tools` / `call_tool`，hash 为
`a8c9b0cbdb020b6919f13cbfe8af7a6cb261d68e4e3e3552569ea368671a82c8`；
更新后的 `set_session_runtime` 描述在按名称发现时返回，不进入顶层 tool schema。
具体样本与两个 Orca hash 见 [results.json](results.json)，原生输出正文见
[改动前](before-context.md) / [改动后](after-context.md)。这些文件只保留测量数据，
不包含原生回执里的会话身份、凭证状态或本机路径。

## 指标评估与限制

- **上下文 / 输入成本**：实测增加约 1k 固定 token。工具不在每轮新增或换序；首次使用新版本
  的前缀会改变，不能宣称新增工具零成本。
- **缓存率**：按规则允许的 `/context` 对比，量化了固定前缀增量；20 次清单及两次原生
  上下文读数验证同版本前缀稳定。没有测服务端 cache-read/create，故不声称命中率不变，
  也不据此预测长期会话命中率；这些运行没有推理请求，零 cache-read 不是零命中率证据。
- **性能 / 返回速度**：工具发现的本地 p50 / p95 如上，没有足够样本证明速度提升或回退。
  没有测模型首字延迟或跨电脑调用延迟；本次不修改 translator / event loop。
- **内容准确性 / 工具暴露**：真实初始化确认只新增一个目标工具，旧工具内容与顺序保留；
  `sessionContext.test.ts` 实跑 41/41 通过，覆盖新工具的参数、同团队转发与错误返回。
  没有运行自由生成任务，不能将协议测试等同于模型选工具成功率。

## 复现入口

临时目录内准备两版 `packages/lizi-mcps/src` 与相同依赖，并以如下最小入口启动各自源码：

```js
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const { createOrcaMcpServer } = await import(pathToFileURL(process.argv[2]));
const deps = new Proxy({}, {
  get: (_, key) => key === 'authorizeCall' ? undefined
    : async () => ({ ok: false, error: 'MEASUREMENT_ONLY' }),
});
await createOrcaMcpServer(deps, {
  sessionId: 'measurement-lead', vendorOptions: { orcaRole: 'lead' },
}).connect(new StdioServerTransport());
```

MCP 配置的 server 名称为 `cindy_orca`，命令为 `node --import <tsx-loader> <入口文件> <该版server.ts>`。
在相同空目录分别执行（保留 stdin 直至命令完成）：

```sh
printf '%s\n' '{"type":"user","message":{"role":"user","content":"/context"}}' |
  ENABLE_TOOL_SEARCH=false claude --setting-sources '' --tools '' --strict-mcp-config \
    --mcp-config <该版配置.json> --no-session-persistence --model claude-opus-5-5 \
    --input-format stream-json --output-format stream-json --verbose -p
```

不要把完整原生回执直接放入仓库；仅保留 init 的连接成功状态与工具数量、
context result 的正文及测量数值。若 MCP 未连接成功，该次测量无效。
