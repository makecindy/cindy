/**
 * xdt-helper/index.ts
 *
 * Bundle export for the xdt-helper tool family. lizi_xdtHelperMcpServer.ts imports
 * from here and registers everything in one go (mirrors scheduler/index.ts).
 *
 * Note: handoff 工具 send_to_session 注册在 cindy_helper 的 handoff 类目(走 call_tool,essential 常开)。
 * 协同 team 工具由 cindy_orca server(src/orca/)托管,通过本目录的 register*Tool 注册。
 */

export { registerGetCapabilitiesTool } from './get_capabilities.js';
export {
  registerGetCurrentSessionIdTool,
  type GetCurrentSessionIdDeps,
} from './get_current_session_id.js';
export {
  registerSetCurrentSessionTitleTool,
  type SetCurrentSessionTitleDeps,
  type SetCurrentSessionTitleResult,
} from './set_current_session_title.js';
export {
  registerRenameSessionsTool,
  type RenameSessionChange,
  type RenameSessionPreviewItem,
  type RenameSessionsDeps,
  type RenameSessionsResult,
} from './rename_sessions.js';
export {
  registerSendToSessionTool,
  type SendToSessionCallback,
  type SendToSessionDeps,
} from './send_to_session.js';
export {
  registerArchiveSessionsTool,
  registerUnarchiveSessionsTool,
  type ArchiveSessionsDeps,
  type SessionStatus,
  type SessionStatusChangeItem,
  type SetSessionsStatusResult,
} from './archive_sessions.js';
// multi-worker Phase 1 control tools
export {
  registerStartTeamTool,
  type StartTeamDeps,
} from './start_team.js';
export {
  registerCreateWorkerTool,
  type CreateWorkerDeps,
} from './create_worker.js';
export { registerCreateWorkersTool } from './create_workers.js';
export {
  registerListWorkersTool,
  type ListWorkersDeps,
  type WorkerSummary,
} from './list_workers.js';
export {
  registerSwitchFocusTool,
  type SwitchFocusDeps,
} from './switch_focus.js';
export {
  registerSendToWorkerTool,
  type SendToWorkerDeps,
} from './send_to_worker.js';
export {
  registerListWorkerQueueTool,
  type ListWorkerQueueDeps,
  type WorkerQueuedMessageEntry,
} from './list_worker_queue.js';
export {
  registerUpdateQueuedMessageTool,
  type QueuedMessageControlErrorCode,
  type UpdateQueuedMessageDeps,
} from './update_queued_message.js';
export {
  registerCancelQueuedMessageTool,
  type CancelQueuedMessageDeps,
} from './cancel_queued_message.js';
export {
  registerIdleWorkerTool,
  type IdleWorkerDeps,
} from './idle_worker.js';
export {
  registerEndTeamTool,
  type EndTeamDeps,
} from './end_team.js';
export {
  registerArchiveWorkerTool,
  type ArchiveWorkerDeps,
} from './archive_worker.js';
export {
  registerListAvailableModelsTool,
  type ListAvailableModelsDeps,
  type ModelDescriptor,
} from './list_available_models.js';
// history tools (split out from xdt-helper but kept exports here)
export {
  registerListWorkdirsTool,
  type ListWorkdirsToolDeps,
} from './list_workdirs.js';
export {
  registerListSessionsTool,
  type ListSessionsToolDeps,
} from './list_sessions.js';
export {
  registerListSessionQueueTool,
  type SessionQueueDeps,
  type SessionQueuedMessageEntry,
} from './list_session_queue.js';
export {
  registerUpdateSessionQueuedMessageTool,
  registerCancelSessionQueuedMessageTool,
  registerSteerSessionTool,
  registerStopSessionTurnTool,
  registerGetSessionRuntimeTool,
  registerSetSessionRuntimeTool,
  type SessionControlDeps,
  type SessionQueueControlErrorCode,
  type SessionRuntimeProfile,
  type SessionRuntimeSnapshot,
  type SessionSteerErrorCode,
  type SessionStopErrorCode,
} from './session_control.js';
export {
  registerGetChatHistoryTool,
  type GetChatHistoryToolDeps,
} from './get_chat_history.js';
export {
  registerSearchChatHistoryTool,
  type SearchChatHistoryToolDeps,
} from './search_chat_history.js';
export {
  registerSubmitGithubIssueTool,
  type SubmitGithubIssueDeps,
  type SubmitGithubIssueHostResult,
  type SubmitGithubIssueHostOk,
  type SubmitGithubIssueHostErr,
  type SubmitGithubIssueHostErrorCode,
} from './submit_github_issue.js';
export type {
  XdtHelperHistoryDeps,
  HistoryAgentKind,
  HistoryOrder,
  HistoryReadErrorCode,
  HistoryRole,
  HistoryCursor,
  HistoryPage,
  HistoryWorkdir,
  HistorySession,
  HistoryMessage,
  ListWorkdirsArgs,
  ListSessionsArgs,
  GetMessagesArgs,
  SearchChatHistoryArgs,
  SearchChatHistoryHit,
  SearchChatHistoryContextMessage,
  SearchChatHistorySessionMeta,
  SearchChatHistoryResult,
} from './_history_types.js';
export {
  CAPABILITIES,
  findCapability,
  listCapabilityIndex,
} from './capabilities.js';
export type { CapabilityEntry } from './capabilities.js';
