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

import { installDevLogFilters } from "./quietDevLogs";

describe("quietDevLogs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing outside dev builds", () => {
    installDevLogFilters(false);
    expect(ignoreLogs).not.toHaveBeenCalled();
    expect(configureReanimatedLogger).not.toHaveBeenCalled();
  });

  it("hides only the debugger hint and keeps other warnings and errors visible", () => {
    installDevLogFilters(true);
    expect(ignoreLogs).toHaveBeenCalledExactlyOnceWith([
      "Open debugger to view warnings.",
    ]);
    expect(configureReanimatedLogger).toHaveBeenCalledExactlyOnceWith({
      level: 1,
      strict: false,
    });
  });
});
