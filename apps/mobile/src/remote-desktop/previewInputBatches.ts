import {
  PREVIEW_MAX_INPUT_BYTES,
  PREVIEW_MAX_INPUT_EVENTS,
  type PreviewInputEvent,
} from "@cindy/device-link";

const json = (value: unknown) => JSON.stringify(value).length;
// The host measures `JSON.stringify(events).length`, brackets and commas included.
const EMPTY_BATCH = 2;
const TEXT_OVERHEAD = json({ kind: "text", text: "" });

/**
 * Cuts a text event whose JSON is too large for one batch (escaped quotes,
 * control characters) into pieces that each fit, on code point boundaries so no
 * surrogate pair is torn apart.
 */
function fitText(event: PreviewInputEvent): PreviewInputEvent[] {
  if (event.kind !== "text" || EMPTY_BATCH + json(event) <= PREVIEW_MAX_INPUT_BYTES)
    return [event];
  const budget = PREVIEW_MAX_INPUT_BYTES - EMPTY_BATCH - TEXT_OVERHEAD;
  const pieces: PreviewInputEvent[] = [];
  let piece = "";
  let used = 0;
  for (const point of event.text) {
    const cost = json(point) - 2;
    if (piece && used + cost > budget) {
      pieces.push({ kind: "text", text: piece });
      piece = "";
      used = 0;
    }
    piece += point;
    used += cost;
  }
  if (piece) pieces.push({ kind: "text", text: piece });
  return pieces;
}

/**
 * Splits one viewer batch into `previewInput` batches the host's parser takes:
 * at most 64 events and 16 KiB of JSON each, in the original order. A paste of
 * several full text events is the usual reason to split; one that still does
 * not fit is cut into smaller text events rather than dropped.
 */
export function splitPreviewInput(
  events: readonly PreviewInputEvent[],
): PreviewInputEvent[][] {
  const batches: PreviewInputEvent[][] = [];
  let current: PreviewInputEvent[] = [];
  let size = EMPTY_BATCH;
  for (const event of events.flatMap(fitText)) {
    const length = json(event);
    let next = size + length + (current.length ? 1 : 0);
    if (
      current.length &&
      (current.length >= PREVIEW_MAX_INPUT_EVENTS || next > PREVIEW_MAX_INPUT_BYTES)
    ) {
      batches.push(current);
      current = [];
      next = EMPTY_BATCH + length;
    }
    current.push(event);
    size = next;
  }
  if (current.length) batches.push(current);
  return batches;
}
