/**
 * The controller accepts a size-limited live tool result
 * (docs/dev-rules/protocol-compatibility/device-link-tool-result-live-limit.md). For an ordinary
 * tool result over the Host's live limit, the Host sends the head of the text plus a truncation
 * marker in `resolvedContent` (and in `data.fullText` / `data.summary` when those are still sent),
 * as the persisted 8 KB copy and the Mobile preview do.
 * Persisted rows and history reads are unchanged. Results with cards, media, files, process media
 * or MCP App views, and interaction / plan / agent / edit / plugin tools, stay whole.
 */
export const CONTROLLER_CAPABILITY_TOOL_RESULT_LIVE_LIMIT_V1 = 'tool-result-live-limit-v1';
