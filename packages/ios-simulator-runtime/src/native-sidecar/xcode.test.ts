import { describe, expect, it, vi } from "vitest";

import {
  iosSimulatorKitFrameworkDirectories,
  normalizeIOSSimulatorDeveloperDirectory,
  resolveIOSSimulatorDeveloperDirectory,
  resolveIOSSimulatorKitBinary,
} from "./xcode.js";

describe("selected Xcode for native SimulatorKit", () => {
  it.each([
    "/Applications/Xcode.app/",
    " /Applications/Xcode.app/Contents/Developer/ ",
  ])(
    "normalizes valid selections with trailing separators: %s",
    (selection) => {
      expect(normalizeIOSSimulatorDeveloperDirectory(selection)).toBe(
        "/Applications/Xcode.app/Contents/Developer",
      );
    },
  );

  it.each(["Library/PrivateFrameworks", "../SharedFrameworks"])(
    "finds the selected installation's %s layout",
    async (layout) => {
      const selected = "/Volumes/Tools/Xcode Beta.app/Contents/Developer";
      const binary = layout.startsWith("..")
        ? "/Volumes/Tools/Xcode Beta.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit"
        : `${selected}/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit`;
      expect(
        await resolveIOSSimulatorKitBinary(
          selected,
          async (file) => file === binary,
        ),
      ).toBe(binary);
    },
  );

  it("does not borrow another Xcode when the selected installation has no SimulatorKit", async () => {
    const readable = vi.fn().mockResolvedValue(false);
    await expect(
      resolveIOSSimulatorKitBinary(
        "/Volumes/Tools/Xcode.app/Contents/Developer",
        readable,
      ),
    ).rejects.toThrow("no SimulatorKit");
    expect(readable).toHaveBeenCalledTimes(2);
    expect(
      readable.mock.calls.every(([file]) =>
        file.startsWith("/Volumes/Tools/Xcode.app/"),
      ),
    ).toBe(true);
  });

  it("honors DEVELOPER_DIR including app bundles and spaces without probing other Xcodes", async () => {
    const run = vi.fn();
    const directory = await resolveIOSSimulatorDeveloperDirectory({
      environment: { DEVELOPER_DIR: "/Volumes/Tools/Xcode Beta.app" },
      commandRunner: { run },
    });
    expect(directory).toBe("/Volumes/Tools/Xcode Beta.app/Contents/Developer");
    expect(iosSimulatorKitFrameworkDirectories(directory)).toEqual([
      "/Volumes/Tools/Xcode Beta.app/Contents/Developer/Library/PrivateFrameworks",
      "/Volumes/Tools/Xcode Beta.app/Contents/SharedFrameworks",
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("resolves xcode-select again after the active toolchain changes", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/Applications/Xcode.app/Contents/Developer\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/Volumes/Tools/Xcode 27.app/Contents/Developer\n",
      });
    const options = { environment: {}, commandRunner: { run } };
    expect(await resolveIOSSimulatorDeveloperDirectory(options)).toBe(
      "/Applications/Xcode.app/Contents/Developer",
    );
    expect(await resolveIOSSimulatorDeveloperDirectory(options)).toBe(
      "/Volumes/Tools/Xcode 27.app/Contents/Developer",
    );
    expect(run).toHaveBeenCalledWith("/usr/bin/xcode-select", ["-p"], {
      timeoutMs: 5_000,
      maxBufferBytes: 16_384,
    });
  });

  it.each([
    "relative/Xcode.app",
    "/Library/Developer/CommandLineTools",
    "/",
    "",
  ])(
    "rejects invalid selections instead of falling back to another Xcode: %s",
    (directory) =>
      expect(() =>
        normalizeIOSSimulatorDeveloperDirectory(directory),
      ).toThrow(),
  );

  it("fails closed when xcode-select fails or returns truncated output", async () => {
    for (const result of [
      { exitCode: 1, stdout: "" },
      {
        exitCode: 0,
        stdout: "/Applications/Xcode.app/Contents/Developer",
        outputTruncated: true,
      },
    ]) {
      await expect(
        resolveIOSSimulatorDeveloperDirectory({
          environment: {},
          commandRunner: { run: vi.fn().mockResolvedValue(result) },
        }),
      ).rejects.toThrow("unavailable");
    }
  });
});
