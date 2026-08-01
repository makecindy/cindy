/**
 * Host-owned confirmation cards must settle before the 600-second MCP tool deadline.
 * The grace period lets the structured timeout result reach the Agent instead of racing
 * the transport's generic timeout.
 */
export const HOST_CONFIRM_TIMEOUT_MS = 9 * 60 * 1000;
