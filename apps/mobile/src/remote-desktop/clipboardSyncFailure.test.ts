import { expect, it } from "vitest";
import {
  clipboardSyncFailure,
  clipboardSyncErrorCode,
} from "./clipboardSyncFailure";

it("backs off transient failures without changing preferences", () => {
  expect(clipboardSyncFailure(new Error("INVOKE_TIMEOUT"), 0).delay).toBe(1500);
  expect(clipboardSyncFailure({ code: "INVOKE_TIMEOUT" }, 99).delay).toBe(
    30000,
  );
});
it("waits for deliberate retry after permission denial", () => {
  expect(clipboardSyncFailure(new Error("PASTE_DENIED"), 0)).toMatchObject({
    notice: "clipboardSyncPermission",
    delay: null,
  });
});

it.each([
  "CLIPBOARD_NOT_ALLOWED",
  "CLIPBOARD_UNSUPPORTED",
  "CLIPBOARD_CHANGED",
])("prefers native %s inside a generic Expo error", (code) => {
  const error = Object.assign(new Error(`Native failure: ${code}`), {
    code: "ERR_UNEXPECTED",
  });
  expect(clipboardSyncErrorCode(error)).toBe(code);
});
