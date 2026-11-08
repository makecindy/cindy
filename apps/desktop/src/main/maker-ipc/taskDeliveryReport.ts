/**
 * The `report_task_delivery` handshake for tasks with a recorded origin (taskCompletionDeliveryHost.ts):
 * the host asks the executing model to say whether a turn delivers the requested result, and a
 * true report followed by normal completion is delivered back to the original conversation.
 *
 * register.ts binds the live owner-scoped delivery host and session executions; the message path
 * and the cindy_helper tool read through here without importing register.ts.
 */
import type { BotAutonomyExecution } from '../../shared/botAutonomy.js';

export interface TaskDeliveryReportHost {
  readSessionExecution(sessionId: string): BotAutonomyExecution | null;
  /** The task has an origin delivery waiting on the model's report (not a notify_when_done result). */
  wantsReport(sessionId: string): Promise<boolean>;
  /** Records the report for the running execution; false when it cannot be recorded. */
  report(sessionId: string, execution: BotAutonomyExecution, final: boolean): boolean;
}

let host: TaskDeliveryReportHost | null = null;

export function configureTaskDeliveryReport(next: TaskDeliveryReportHost | null): void {
  host = next;
}

export const TASK_DELIVERY_NOTE = '[Task delivery] Host bookkeeping, not a user message: before your final answer in every turn, call cindy_helper.call_tool({name:"report_task_delivery",args:{final_delivery:true|false}}). Judge whether this turn newly delivers the requested result: PR delivered for human review, merged/closed, or goal achieved is true; intermediate review fixes, waiting for CI, or repeated status is false. A true report followed by normal completion is delivered by the host to the recorded original conversation.';

/** Only tasks whose origin delivery waits on the model's report get the note. */
export async function readTaskDeliveryNote(sessionId: string): Promise<string | null> {
  const current = host;
  if (!current) return null;
  return await current.wantsReport(sessionId) && host === current ? TASK_DELIVERY_NOTE : null;
}

export function reportTaskDelivery(sessionId: string, finalDelivery: boolean, sessionInstanceId?: string):
  { ok: true } | { ok: false; errorCode: string; message: string } {
  const execution = host?.readSessionExecution(sessionId);
  if (!host || !execution || (sessionInstanceId !== undefined && sessionInstanceId !== execution.instanceId)
    || !host.report(sessionId, execution, finalDelivery)) {
    return { ok: false, errorCode: 'PRECONDITION_FAILED', message: 'The current task execution is not running.' };
  }
  return { ok: true };
}
