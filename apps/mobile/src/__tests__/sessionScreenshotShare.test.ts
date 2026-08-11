import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile screenshot-triggered share guards", () => {
  it("blocks screenshot activation while any session overlay is visible", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const screenshotBlockedByOverlayRef = useRef(false);",
    );
    expect(source).toContain("settingsOpen");
    expect(source).toContain("searchOpen");
    expect(source).toContain(
      "sessionTreeOpen && currentSession?.agentKind === 'pi'",
    );
    expect(source).toContain("contextSheetOpen");
    expect(source).toContain("chipMenuTarget !== null");
    expect(source).toContain("modelSheetOpen && canUseComposer");
    expect(source).toContain("permissionSheetOpen && canUseComposer");
    expect(source).toContain("composerPreviewAttachmentId !== null");
    expect(source).toContain("sessionListDrawerOverlayMounted");
    expect(source).toContain(
      "onBlockingOverlayChange={handleMessageBlockingOverlayChange}",
    );

    const listenerStart = source.indexOf(
      "const subscription = addScreenshotListener",
    );
    const listenerEnd = source.indexOf("return () => {", listenerStart);
    const listenerSource = source.slice(listenerStart, listenerEnd);
    expect(listenerSource).toContain("screenshotBlockedByOverlayRef.current");
    expect(
      listenerSource.match(/screenshotBlockedByOverlayRef\.current/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("reports message payload viewers and action sheets as blocking overlays", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/session/MessageRenderer.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "onBlockingOverlayChange?: (blocked: boolean) => void;",
    );
    expect(source).toContain("const openMessageActionSheetsRef = useRef(new Set<string>());");
    expect(source).toContain("onMessageActionSheetOpenChange: handleMessageActionSheetOpenChange,");
    expect(source).toContain("actions.onMessageActionSheetOpenChange?.(clientId, true);");
    expect(source).toContain("actions.onMessageActionSheetOpenChange?.(clientId, false);");
    expect(source).toContain(
      "payload !== null || openMessageActionSheetsRef.current.size > 0",
    );
  });

  it("recomputes the screenshot guard from message overlay state", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const [messageBlockingOverlay, setMessageBlockingOverlay] = useState(false);",
    );
    expect(source).toContain("setMessageBlockingOverlay(blocked);");
    expect(source).toContain("|| messageBlockingOverlay");
    expect(source).not.toContain("messageBlockingOverlayRef");
  });

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
