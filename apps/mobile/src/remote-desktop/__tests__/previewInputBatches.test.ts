import { describe, expect, it } from "vitest";
import {
  parseRemoteDesktopRequest,
  PREVIEW_MAX_INPUT_BYTES,
  PREVIEW_MAX_INPUT_EVENTS,
  type PreviewInputEvent,
} from "@cindy/device-link";
import { splitPreviewInput } from "../previewInputBatches";

const text = (value: string): PreviewInputEvent => ({ kind: "text", text: value });
const touch = (id: number): PreviewInputEvent => ({
  kind: "touch",
  phase: "move",
  points: [{ id, x: 0.5, y: 0.5 }],
});
const size = (batch: readonly PreviewInputEvent[]) => JSON.stringify(batch).length;
/** What the host's parser would make of one batch. */
const accepted = (batch: PreviewInputEvent[]) =>
  parseRemoteDesktopRequest({
    op: "previewInput",
    lease: "l",
    sequence: 1,
    events: batch,
  });

describe("splitting preview input into batches the host accepts", () => {
  it("keeps a small batch whole and in order", () => {
    const events = [touch(0), text("hi"), { kind: "key", code: "Enter", down: true } as const];
    expect(splitPreviewInput(events)).toEqual([events]);
    expect(splitPreviewInput([])).toEqual([]);
  });

  it("splits pasted text that would pass 16 KiB in one batch, without losing or reordering any", () => {
    // Four full text events of one paste: 4 x ~4.1 KB is over the 16 KiB limit.
    const events = ["a", "b", "c", "d", "e"].map((c) => text(c.repeat(4096)));
    expect(size(events)).toBeGreaterThan(PREVIEW_MAX_INPUT_BYTES);
    expect(() => accepted(events)).toThrow("INVALID_REQUEST");
    const batches = splitPreviewInput(events);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(size(batch)).toBeLessThanOrEqual(PREVIEW_MAX_INPUT_BYTES);
      expect(() => accepted(batch)).not.toThrow();
    }
    expect(batches.flat()).toEqual(events);
  });

  it("starts a new batch at the 64-event limit", () => {
    const events = Array.from({ length: 130 }, (_, id) => touch(id));
    const batches = splitPreviewInput(events);
    expect(batches.map((batch) => batch.length)).toEqual([
      PREVIEW_MAX_INPUT_EVENTS,
      PREVIEW_MAX_INPUT_EVENTS,
      2,
    ]);
    expect(batches.flat()).toEqual(events);
  });

  it("cuts a single event that is itself too large for the host, on character boundaries", () => {
    // Control characters grow to six characters when JSON escapes them.
    const heavy = "\u0001".repeat(2000) + "😀" + "\u0002\"".repeat(1000);
    expect(heavy.length).toBeLessThanOrEqual(4096);
    expect(size([text(heavy)])).toBeGreaterThan(PREVIEW_MAX_INPUT_BYTES);
    const batches = splitPreviewInput([touch(0), text(heavy), touch(1)]);
    for (const batch of batches) {
      expect(size(batch)).toBeLessThanOrEqual(PREVIEW_MAX_INPUT_BYTES);
      expect(() => accepted(batch)).not.toThrow();
    }
    const flat = batches.flat();
    expect(flat[0]).toEqual(touch(0));
    expect(flat.at(-1)).toEqual(touch(1));
    const pieces = flat.filter((event) => event.kind === "text");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((event) => (event as { text: string }).text).join("")).toBe(heavy);
    // No piece splits the emoji's surrogate pair.
    for (const piece of pieces)
      expect(Array.from((piece as { text: string }).text).join("")).toBe(
        (piece as { text: string }).text,
      );
  });
});
