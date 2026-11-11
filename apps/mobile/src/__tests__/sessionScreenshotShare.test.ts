// guard: engineering-conventions.md 3.2 race contract: selection revisions fence
// the asynchronous exporter across renderer/page boundaries.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile conversation share guards", () => {
  it("invalidates an export when the share selection revision changes", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const shareSelectionRevisionRef = useRef(shareSelectionRevision);",
    );
    expect(source).toContain(
      "shareSelectionRevisionRef.current = shareSelectionRevision;",
    );
    expect(source).toContain(
      "const operationSelectionRevision = shareSelectionRevisionRef.current;",
    );
    expect(source).toContain(
      "shareSelectionRevisionRef.current === operationSelectionRevision",
    );
    expect(source).not.toContain("conversationShareHtmlRef");
    expect(source).not.toContain("operationShareHtml");
  });
});
