/**
 * xAI(SuperGrok 订阅)的**服务端工具**声明 —— 当前只有 `x_search`(Grok 原生搜 X)。
 *
 * 背景:Grok 本身没有实时 X 数据权限,能不能搜 X 完全取决于请求 `tools[]` 里有没有
 * `{ type: 'x_search' }`。这是 xAI 在**上游**执行的服务端工具:模型自己发起关键词 /
 * 语义 / 用户 / thread 检索,客户端既收不到 tool call、也不需要回 tool_result,结果直接
 * 融进回答与 citations。少了这条声明,同样的 Grok 模型就只是个没有 X 实时视野的普通模型。
 *
 * 因此 Cindy 对 xAI 会话恒定附加该声明,让「选了 Grok」= 「能搜 X」,而不是要求用户自己
 * 想办法把工具塞进请求。两条到 api.x.ai 的链路共用本模块,避免两处门控漂移:
 *   - Codex agent  → `codex-proxy-host.ts` 的 xAI compat transform
 *   - Claude Code  → `anthropic-responses-bridge-host.ts` 的 xai provider 配置
 *
 * 稳定性约束:声明只由 model 决定,不掺任何会话态或每轮变化的内容,且恒定排在 function
 * tools 之后 —— 请求前缀逐轮一致,不破坏 prompt 缓存(见
 * `docs/dev-rules/maker-core-and-agent-behavior.md` §3.1「会话中途不得增删/重排 tool」)。
 */

import type { ResponsesServerTool } from '@cindy/anthropic-responses-bridge';

/** xAI 原生 X 搜索工具的 wire 形态(参数全省略 = 由模型自行决定检索范围与时间窗)。 */
export const XAI_X_SEARCH_TOOL_TYPE = 'x_search';

/**
 * 该(去前缀后的)xAI model 是否暴露服务端搜索工具。
 *
 * grok-code / grok-build 系列是编码特化模型,不提供 agentic 搜索工具面(与本仓
 * `supportsReasoning` 的门控口径一致:同一批模型也不吃 reasoningEffort);给它们带上
 * `x_search` 只会让上游 400,拖垮本来正常的编码会话。
 *
 * 刻意用**黑名单**而不是「只放行目录里已知的模型」:未知的新 Grok 通用模型默认当作能搜 X。
 * 白名单意味着 xAI 每发一个新模型,用户都要等本地目录更新才恢复搜 X —— 而搜 X 正是选 Grok
 * 的主要理由,静默丢能力比偶发的上游报错更难被发现。新出的编码系模型若沿用 grok-code /
 * grok-build 命名会自动落进排除区;万一 xAI 换了命名,在这里补一条即可。
 */
export function xaiSupportsServerSideSearch(model: string): boolean {
  return !(model.startsWith('grok-code') || model.startsWith('grok-build'));
}

/**
 * 某个 xAI model 恒定附加的服务端工具列表(不支持的模型返回空数组)。
 * 每次返回新对象,调用方可以安全地并入自己的 tools 数组而不共享引用。
 */
export function xaiServerSideTools(model: string): ResponsesServerTool[] {
  return xaiSupportsServerSideSearch(model) ? [{ type: XAI_X_SEARCH_TOOL_TYPE }] : [];
}
