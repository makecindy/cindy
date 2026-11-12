// Only the primitives needed by bundled adapters. Navigation, tabs and file
// uploads use the normal runtime routes and their existing policy checks.
const METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.focus",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getContentQuads",
  "DOM.getBoxModel",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Network.getCookies",
  "Storage.getCookies",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "Page.handleJavaScriptDialog",
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
]);

export function assertRecipeCommand(method: string): void {
  if (!METHODS.has(method))
    throw new Error(`Unsupported bundled recipe browser command: ${method}`);
}
