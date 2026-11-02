import { beforeEach, describe, expect, it, vi } from "vitest";

const { ignoreLogs, configureReanimatedLogger } = vi.hoisted(() => ({
  ignoreLogs: vi.fn(),
  configureReanimatedLogger: vi.fn(),
}));

vi.mock("react-native", () => ({ LogBox: { ignoreLogs } }));
vi.mock("react-native-reanimated", () => ({
  configureReanimatedLogger,
  ReanimatedLogLevel: { warn: 1 },
}));

describe("quietDevLogs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does nothing outside dev builds", async () => {
    vi.stubGlobal("__DEV__", false);
    await import("./quietDevLogs");
    expect(ignoreLogs).not.toHaveBeenCalled();
    expect(configureReanimatedLogger).not.toHaveBeenCalled();
  });

  it("hides only the debugger hint and keeps other warnings and errors visible", async () => {
    vi.stubGlobal("__DEV__", true);
    await import("./quietDevLogs");
    expect(ignoreLogs).toHaveBeenCalledExactlyOnceWith([
      "Open debugger to view warnings.",
    ]);
    expect(configureReanimatedLogger).toHaveBeenCalledExactlyOnceWith({
      level: 1,
      strict: false,
    });
  });
});
