import { errorPayload } from './xdt-helper/_payload.js';

/**
 * Host decision for one tool call. Tool lists stay stable for a whole session
 * (prompt-cache rule), so a turn-dependent limit is enforced when the call runs.
 */
export type ToolCallAuthorization =
  | { ok: true }
  | { ok: false; errorCode: string; message: string };

export type ToolCallAuthorizer = (input: {
  sessionId: string | undefined;
  server: 'cindy_helper' | 'cindy_scheduler';
  tool: string;
  args: unknown;
}) => Promise<ToolCallAuthorization>;

/** Run `operation` only when the host allows this call; a failing host check denies it. */
export async function withToolCallAuthority<T>(
  authorize: ToolCallAuthorizer | undefined,
  input: Parameters<ToolCallAuthorizer>[0],
  operation: () => Promise<T>,
): Promise<T | ReturnType<typeof errorPayload>> {
  if (!authorize) return operation();
  let decision: ToolCallAuthorization;
  try {
    decision = await authorize(input);
  } catch {
    decision = { ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: '暂时无法确认这次调用的权限，请稍后重试。' };
  }
  if (!decision.ok) return errorPayload(decision.errorCode, decision.message);
  return operation();
}
