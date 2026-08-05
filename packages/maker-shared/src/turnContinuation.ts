/**
 * Shared lifecycle predicates for SDK turns that automatically continue.
 *
 * A provider may emit a `status(isRunning=false)` and `done` for the SDK turn
 * that just finished while a background task keeps the product turn alive.
 * Those boundary events carry `turnContinuationId`; consumers must keep their
 * product-level running/finalization state until a later boundary without a
 * claim arrives.
 */

export interface TurnContinuationEventLike {
  type?: unknown;
  data?: unknown;
  turnContinuationId?: unknown;
}

export function isTurnContinuationBoundaryEvent(
  event: TurnContinuationEventLike | null | undefined,
): boolean {
  return (
    typeof event?.turnContinuationId === 'number' &&
    Number.isSafeInteger(event.turnContinuationId) &&
    event.turnContinuationId >= 0
  );
}

export function isProductTurnDoneEvent(
  event: TurnContinuationEventLike | null | undefined,
): boolean {
  return event?.type === 'done' && !isTurnContinuationBoundaryEvent(event);
}

export function isProductTurnCompletionTailEvent(
  event: TurnContinuationEventLike | null | undefined,
): boolean {
  if (!event || isTurnContinuationBoundaryEvent(event)) return false;
  if (event.type === 'done') return true;
  if (event.type !== 'status' || !isRecord(event.data)) return false;
  return event.data.isRunning === false && event.data.status === 'Done';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
