import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIOSSimulatorNativeSidecarSandboxLaunchPlan,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  createIOSSimulatorNativeSidecarSandboxProfile,
  IOSSimulatorNativeSidecarSandboxError,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);
const UDID = "A1B2C3D4-1111-2222-3333-444455556666";
const DARWIN_TEMPORARY_ROOT = "/private/tmp";
const DARWIN_TEMPORARY_DIRECTORY = `${DARWIN_TEMPORARY_ROOT}/cindy-ios-sandbox-test`;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cindy-ios-sandbox-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("IOSSimulator native sidecar sandbox", () => {
  it("builds a deny-by-default, stdio-only profile without network or broad user-data access", async () => {
    const temp = DARWIN_TEMPORARY_DIRECTORY;
    const policy = createIOSSimulatorNativeSidecarSandboxPolicy({
      platform: "darwin",
      homeDirectory: "/Users/example",
      temporaryRoot: DARWIN_TEMPORARY_ROOT,
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
    });
    const profile = createIOSSimulatorNativeSidecarSandboxProfile({
      policy,
      binaryPath: "/opt/cindy/ios-simulator-sidecar",
      simulatorUdid: UDID,
      architecture: "arm64",
      temporaryDirectory: temp,
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain(
      '(global-name "com.apple.CoreSimulator.SimDevice.A1B2C3D4-1111-2222-3333-444455556666")',
    );
    expect(profile).toContain(
      '(global-name "com.apple.CoreSimulator.SimLaunchHost-arm64")',
    );
    expect(profile).toContain('(iokit-user-client-class "AGXDeviceUserClient"');
    expect(profile).toContain(
      `(subpath ${JSON.stringify(path.posix.join("/Users/example", "Library", "Developer", "CoreSimulator"))})`,
    );
    expect(profile).not.toContain("(allow network");
    expect(profile).not.toContain("com.apple.bsd.dirhelper");
    expect(profile).not.toMatch(/\(allow mach-lookup\)\s*$/m);
    expect(profile).not.toMatch(/\(allow iokit-open\)\s*$/m);
    expect(profile).not.toContain("(allow signal");
    expect(profile).not.toContain("(allow task");
    expect(profile).not.toContain("(allow iokit-set-properties");
    expect(profile).not.toContain('(subpath "/Users/example")');
    expect(profile).not.toContain('(subpath "/opt/cindy")');
    expect(profile).not.toContain("Library/Preferences");
  });

  it("rejects non-macOS hosts, ambiguous device identities, and temp-directory escapes", async () => {
    const temp = DARWIN_TEMPORARY_DIRECTORY;
    const policy = createIOSSimulatorNativeSidecarSandboxPolicy({
      platform: "linux",
      homeDirectory: "/home/example",
      temporaryRoot: os.tmpdir(),
    });
    expect(() =>
      createIOSSimulatorNativeSidecarSandboxProfile({
        policy,
        binaryPath: "/opt/cindy/ios-simulator-sidecar",
        simulatorUdid: UDID,
        architecture: "arm64",
        temporaryDirectory: temp,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SANDBOX_UNSUPPORTED_PLATFORM",
      }),
    );

    const macPolicy = createIOSSimulatorNativeSidecarSandboxPolicy({
      platform: "darwin",
      homeDirectory: "/Users/example",
      temporaryRoot: DARWIN_TEMPORARY_ROOT,
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
    });
    expect(() =>
      createIOSSimulatorNativeSidecarSandboxProfile({
        policy: macPolicy,
        binaryPath: "/opt/cindy/ios-simulator-sidecar",
        simulatorUdid: "booted",
        architecture: "arm64",
        temporaryDirectory: temp,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SANDBOX_PROFILE_INVALID" }),
    );
    expect(() =>
      createIOSSimulatorNativeSidecarSandboxProfile({
        policy: macPolicy,
        binaryPath: "/opt/cindy/ios-simulator-sidecar",
        simulatorUdid: UDID,
        architecture: "arm64",
        temporaryDirectory: "/private/not-owned-by-cindy",
      }),
    ).toThrow(IOSSimulatorNativeSidecarSandboxError);
  });

  it("passes only the private temp directory and selected developer directory to the sandboxed process", async () => {
    const temp = DARWIN_TEMPORARY_DIRECTORY;
    const plan = createIOSSimulatorNativeSidecarSandboxLaunchPlan({
      policy: createIOSSimulatorNativeSidecarSandboxPolicy({
        platform: "darwin",
        homeDirectory: "/Users/example",
        temporaryRoot: DARWIN_TEMPORARY_ROOT,
        developerDirectory: "/Applications/Xcode.app/Contents/Developer",
      }),
      binaryPath: "/opt/cindy/ios-simulator-sidecar",
      simulatorUdid: UDID,
      architecture: "x86_64",
      temporaryDirectory: temp,
      args: ["--stdio"],
      environment: {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        SECRET_TOKEN: "must-not-cross-process-boundary",
      },
    });

    expect(plan.command).toBe("/usr/bin/sandbox-exec");
    expect(plan.args.at(-2)).toBe("/opt/cindy/ios-simulator-sidecar");
    expect(plan.args.at(-1)).toBe("--stdio");
    expect(plan.cwd).toBe(temp);
    expect(plan.environment).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/Users/example",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      TMPDIR: `${temp}${path.posix.sep}`,
      CINDY_IOS_SIDECAR_METAL_CACHE_DIR: path.posix.join(temp, "metal-cache"),
    });
    expect(plan.diagnostics).toMatchObject({
      required: true,
      enforced: true,
      reasonCode: "SANDBOX_ENFORCED",
    });
  });

  it.runIf(process.platform === "darwin")(
    "is accepted by the host sandbox compiler and denies arbitrary file reads",
    async () => {
      const temp = await temporaryDirectory();
      const deniedFile = path.join(
        path.dirname(temp),
        "cindy-ios-sandbox-denied.txt",
      );
      await writeFile(deniedFile, "must-not-be-readable", { mode: 0o600 });
      try {
        const plan = createIOSSimulatorNativeSidecarSandboxLaunchPlan({
          policy: createIOSSimulatorNativeSidecarSandboxPolicy({
            platform: "darwin",
            temporaryRoot: os.tmpdir(),
          }),
          binaryPath: "/bin/cat",
          simulatorUdid: UDID,
          architecture: process.arch === "x64" ? "x86_64" : "arm64",
          temporaryDirectory: temp,
          args: [deniedFile],
          environment: {
            PATH: "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
          },
        });
        await expect(
          execFileAsync(plan.command, plan.args, {
            cwd: plan.cwd,
            env: plan.environment,
          }),
        ).rejects.toBeDefined();
      } finally {
        await rm(deniedFile, { force: true });
      }
    },
  );
});
