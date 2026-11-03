import { beforeEach, describe, expect, it, vi } from "vitest";
import { showActionMenu } from "@/platform/chrome/showActionMenu";

const native = vi.hoisted(() => ({
  os: "ios",
  show: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { get OS() { return native.os; } },
  ActionSheetIOS: { showActionSheetWithOptions: native.fallback },
  Alert: { alert: vi.fn() },
}));
vi.mock("xdt-ios-action-sheet", () => ({
  iosBottomActionSheetAvailable: true,
  showIosBottomActionSheet: native.show,
}));

const request = {
  title: "preview.png",
  cancelLabel: "取消",
  items: [{ key: "open", label: "快速预览" }],
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  native.os = "ios";
  native.show.mockReset();
  native.fallback.mockReset();
});

describe("iOS action menu presentation", () => {
  it("keeps one menu for repeated long-press callbacks and executes the action once", async () => {
    // The native promise settles after dismissal, not when an item starts closing it.
    const dismissal = deferred<number>();
    native.show.mockReturnValue(dismissal.promise);
    const action = vi.fn();
    const open = () => showActionMenu(request).then((result) => {
      if (result.kind === "action") action(result.key);
      return result;
    });
    const first = open();
    const repeated = [open(), open(), open()];
    // Let all requests finish even on the broken implementation (no hanging test).
    dismissal.resolve(0);
    const results = await Promise.all([first, ...repeated]);

    expect(native.show).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { kind: "action", key: "open" },
      { kind: "cancel" }, { kind: "cancel" }, { kind: "cancel" },
    ]);
    expect(action).toHaveBeenCalledExactlyOnceWith("open");
  });

  it("does not replace an open menu with another target or replay ignored requests later", async () => {
    const dismissal = deferred<number>();
    native.show.mockReturnValueOnce(dismissal.promise).mockResolvedValue(0);
    const first = showActionMenu(request);
    const second = showActionMenu({ ...request, title: "another.png" });
    dismissal.resolve(1);
    expect(await first).toEqual({ kind: "cancel" });
    expect(await second).toEqual({ kind: "cancel" });
    expect(native.show).toHaveBeenCalledTimes(1);

    expect(await showActionMenu({ ...request, title: "next.png" }))
      .toEqual({ kind: "action", key: "open" });
    expect(native.show).toHaveBeenCalledTimes(2);
    expect(native.show.mock.calls[1][0].title).toBe("next.png");
  });

  it.each([0, 1, -1])("allows reopening after action/cancel/dismiss (%s)", async (index) => {
    native.show.mockResolvedValueOnce(index).mockResolvedValue(0);
    await showActionMenu(request);
    expect(await showActionMenu(request)).toEqual({ kind: "action", key: "open" });
    expect(native.show).toHaveBeenCalledTimes(2);
  });

  it("releases the menu after an asynchronous presentation failure", async () => {
    const presentation = deferred<number>();
    native.show.mockReturnValueOnce(presentation.promise).mockResolvedValue(0);
    const first = showActionMenu(request);
    const failure = expect(first).rejects.toThrow("No presenter");
    presentation.reject(new Error("No presenter"));
    await failure;
    expect(await showActionMenu(request)).toEqual({ kind: "action", key: "open" });
  });

  it("releases the menu when the native bridge throws synchronously", async () => {
    native.show.mockImplementationOnce(() => { throw new Error("Bridge unavailable"); })
      .mockResolvedValue(0);
    await expect(async () => showActionMenu(request)).rejects.toThrow("Bridge unavailable");
    expect(await showActionMenu(request)).toEqual({ kind: "action", key: "open" });
  });

  it("also suppresses duplicates in the ActionSheetIOS fallback", async () => {
    native.show.mockReturnValue(null);
    const callbacks: Array<(index: number) => void> = [];
    native.fallback.mockImplementation((_options, callback) => { callbacks.push(callback); });
    const first = showActionMenu(request);
    const repeated = showActionMenu(request);
    callbacks.forEach((callback) => callback(0));
    const results = await Promise.all([first, repeated]);
    expect(native.fallback).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ kind: "action", key: "open" }, { kind: "cancel" }]);

    const next = showActionMenu(request);
    callbacks.at(-1)!(1);
    expect(await next).toEqual({ kind: "cancel" });
    expect(native.fallback).toHaveBeenCalledTimes(2);
  });

  it("leaves Android on its existing in-page menu path", async () => {
    native.os = "android";
    expect(await showActionMenu(request)).toEqual({ kind: "cancel" });
    expect(native.show).not.toHaveBeenCalled();
    expect(native.fallback).not.toHaveBeenCalled();
    native.os = "ios";
    native.show.mockResolvedValue(0);
    expect(await showActionMenu(request)).toEqual({ kind: "action", key: "open" });
  });
});
