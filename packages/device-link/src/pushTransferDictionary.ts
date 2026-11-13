/**
 * push-deflate-v1 的预置字典（raw DEFLATE 的 preset dictionary，见 pushTransfer.ts）。
 *
 * 推送大多是几百字节的小 JSON，其中一半以上是重复的字段名与枚举值；逐条独立压缩时
 * 这些骨架每条都要重新编码。字典把它们预先放进压缩窗口，小推送因此也能压缩，
 * 而每条推送仍然独立可解（不依赖前一条是否送达，丢弃 / 重放 / 降级都不受影响）。
 *
 * 约束：
 * - 只放字段名、枚举值与固定标记，不放任何正文、ID 或用户数据；
 * - 只用 ASCII，各平台把字符串转字节的结果必然一致；
 * - 越常见的骨架越靠后（DEFLATE 匹配距离越短越便宜）；
 * - **发布后不得修改**：两端按字节使用同一份字典，改动等于改协议。要换字典就在
 *   pushTransfer.ts 的 PUSH_TRANSFER_DICTIONARIES 追加新的 id 与能力名（字段仍是
 *   deflateBase64），旧版本保留到不再有对端声明它为止。
 */
const FRAGMENTS: readonly string[] = [
  // 低频：其它 Agent 与投影标记。
  '"source":"pi"', '"source":"codex"', '"agentKind":"codex"', '"agentKind":"pi"',
  '"remoteContentTruncated":true', '"mobileToolResultProjected":true', '\\n[remote content truncated]',
  '"outputOmitted":true', '"inputSummary":"', '"processMedia":[',
  // 任务列表与状态推送。
  '{"sessionId":"","patch":{"title":"","status":"archived"}}',
  '{"sessionId":"","activity":{"status":"idle","isRunning":false,"updatedAt":,"unread":false,"title":"","lastMessagePreview":""}}',
  '{"sessionId":"","status":"idle"}', '{"sessionId":"","status":"running"}', '{"sessionId":""}',
  // 轮次收尾与用量。
  '{"type":"done","data":{"type":"result","subtype":"success","is_error":false,"duration_ms":,"num_turns":,"result":"","stop_reason":"end_turn","total_cost_usd":,"usage":{"input_tokens":,"output_tokens":,"cache_read_input_tokens":,"cache_creation_input_tokens":},"modelUsage":{},"requestUsage":{},"usageSegments":[],"usageSegmentsComplete":true},"source":"claude-code"}',
  '{"type":"status","data":{"status":"Done","tokenUsage":,"contextTokens":,"contextWindow":,"outputTokens":,"durationMs":,"tokenSpeed":,"generationReliable":false,"generationActive":false,"requestUsage":{"epoch":,"models":[{"model":"claude-","inputTokens":,"outputTokens":,"cacheReadTokens":,"cacheCreateTokens":}]},"isRunning":false},"source":"claude-code"}',
  '{"type":"usage","data":{"inputTokens":,"outputTokens":,"cacheReadTokens":,"cacheCreationTokens":,"contextTokens":,"contextWindow":}}',
  // 消息行（local-db:messages:created）。
  '{"sessionId":"","message":{"id":"","rowid":,"clientId":"","sessionId":"","role":"tool_result","content":"","toolUseId":"toolu_","agentMeta":{"uuid":"","sdkSessionId":"","model":"claude-","requestId":"req_"},"agentKind":"cc","createdAt":"2026-"}}',
  '"role":"user"', '"role":"thinking"', '"role":"tool_use","content":{"toolName":"","input":{}}', '"role":"assistant"',
  // 工具事件。
  '{"type":"tool_result_full","data":{"toolUseId":"toolu_","fullText":""}}',
  '{"type":"tool_result","data":{"summary":"","toolUseIds":["toolu_"]}}',
  '{"type":"tool_result","data":{"toolUseId":"toolu_","content":"","isError":false},"source":"claude-code"}',
  '"toolName":"TodoWrite","input":{"todos":[{"content":"","status":"pending","activeForm":""}]}',
  '"toolName":"Write","input":{"file_path":"","content":""}',
  '"toolName":"Edit","input":{"file_path":"","old_string":"","new_string":"","replace_all":false}',
  '"toolName":"Grep","input":{"pattern":"","path":"","output_mode":"content","-n":true}',
  '"toolName":"Read","input":{"file_path":""}',
  '{"type":"tool_use","data":{"toolUseId":"toolu_","toolName":"Bash","input":{"command":"","description":""}},"source":"claude-code"}',
  // 思考与正文增量（最常见，放在最后）。
  '{"type":"status","data":{"status":"Generating...","isRunning":true},"source":"claude-code"}',
  '{"type":"thinking","data":{"stage":"start","blockId":"thinking-","startedAt":}',
  '{"type":"thinking","data":{"stage":"final","blockId":"thinking-","text":"","durationMs":}',
  '{"type":"thinking","data":{"stage":"delta","blockId":"thinking-","text":""},"source":"claude-code"',
  '{"type":"text","data":{"text":"","isFinal":true},"source":"claude-code"',
  '{"sessionId":"","events":[{"sessionId":"","event":{"type":"text","data":{"text":"","isFinal":false},"source":"claude-code","agentMeta":{"uuid":"","sdkSessionId":"","model":"claude-","requestId":"req_"},"turnOrigin":{"kind":"user"},"turnAttemptToken":},"persistId":""}]}',
];

export const PUSH_TRANSFER_DICTIONARY_V1: string = FRAGMENTS.join('');

// Node 按 latin1、pako 按 UTF-8 把字典转成字节；只有纯可见 ASCII 两者才逐字节相同。
// 违反时在加载期就失败，而不是上线后让手机解不开每一条推送。
if (!/^[\x20-\x7e]*$/.test(PUSH_TRANSFER_DICTIONARY_V1)) {
  throw new Error('PUSH_TRANSFER_DICTIONARY_V1 must be printable ASCII');
}
