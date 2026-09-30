import { describe, expect, it } from "vitest";
import {
  composerSelectionToNative,
  nativeComposerNodes,
  nativeSelectionToComposer,
  composerOffsetToNative,
} from "@/session/composerNativeDocument";
import {
  composerDocumentProjectedText,
  serializeComposerDocument,
  type ComposerDocument,
} from "@/session/composerDocument";

describe("native composer document projection", () => {
  const document: ComposerDocument = {
    version: 1,
    nodes: [
      { type: "text", text: "前🙂" },
      { type: "quote", quote: { text: "quoted source" } },
      { type: "pasted-text", text: "log\n".repeat(1000), display: "日志" },
      { type: "mention", kind: "project", raw: "@project", label: "项目" },
      { type: "text", text: "尾" },
    ],
  };
  it("keeps full semantic payloads behind compact labels", () => {
    const result = nativeComposerNodes(document);
    expect(result.map((row) => row.node)).toEqual(document.nodes);
    expect(result[2].label).toBe("日志");
    expect(result[2].wire).toBe(
      serializeComposerDocument({ version: 1, nodes: [document.nodes[2]] })
        .text,
    );
  });
  it("maps UTF-16 selection across emoji and zero-width quote atoms", () => {
    expect(nativeSelectionToComposer(document, 3, 4)).toEqual({
      start: 3,
      end: 3,
      atomRange: { start: 0, end: 1 },
    });
    expect(nativeSelectionToComposer(document, 4, 5)).toEqual({
      start: 3,
      end: 4003,
      atomRange: { start: 1, end: 2 },
    });
  });
  it("restores caret after the full long-paste projection without expanding its label", () => {
    expect(composerOffsetToNative(document, 4003)).toBe(5);
    const end = composerDocumentProjectedText(document).length;
    expect(composerOffsetToNative(document, end)).toBe(7);
    expect(nativeSelectionToComposer(document, 7, 7).start).toBe(end);
  });
  it("clamps out-of-range caret positions and supports empty drafts", () => {
    expect(composerOffsetToNative(document, 99999)).toBe(7);
    expect(nativeSelectionToComposer({ version: 1, nodes: [] }, 9, 12)).toEqual(
      { start: 0, end: 0, atomRange: { start: 0, end: 0 } },
    );
  });
});

it('round-trips both sides of adjacent quotes when voice remembers selection', () => {
  const document: ComposerDocument = { version: 1, nodes: [
    { type: 'text', text: '前' }, { type: 'quote', quote: { text: 'a' } },
    { type: 'quote', quote: { text: 'b' } }, { type: 'text', text: '后' },
  ] };
  for (let start = 0; start <= 4; start++) {
    for (let end = start; end <= 4; end++) {
      expect(composerSelectionToNative(document, nativeSelectionToComposer(document, start, end))).toEqual({ start, end });
    }
  }
});
