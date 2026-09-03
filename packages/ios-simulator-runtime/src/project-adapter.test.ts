import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IOSSimulatorProjectBuildError,
  IOSSimulatorProjectBuilder,
} from "./project-adapter.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

const roots: string[] = [];
const SIMULATOR_UDID = "A1B2C3D4-E5F6-47A8-9B0C-D1E2F3A4B5C6";
const RESOLVED_FILE_PIN = "-onlyUsePackageVersionsFromResolvedFile";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("IOSSimulatorProjectBuilder", () => {
  it("detects Cindy Mobile before generic nested dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    await expect(
      new IOSSimulatorProjectBuilder().inspect(root),
    ).resolves.toMatchObject({
      kind: "cindy-mobile",
      projectRoot: await realpath(mobile),
    });
  });

  it("binds a Cindy Mobile build to the exact simulator destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    const appPath = path.join(
      mobile,
      "ios",
      "build",
      "Build",
      "Products",
      "Debug-iphonesimulator",
      "Cindy.app",
    );
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID.toLowerCase(),
      }),
    ).resolves.toMatchObject({
      kind: "cindy-mobile",
      appPath: await realpath(appPath),
    });
    expect(run).toHaveBeenCalledWith(
      "pnpm",
      [
        "mobile:sim:rebuild",
        "--",
        "--force-build",
        "--build-only",
        "--udid",
        SIMULATOR_UDID,
      ],
      expect.objectContaining({ cwd: await realpath(root) }),
    );
  });

  it("reuses the repository Metro ownership check for Cindy Mobile launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("--json")) {
        return {
          stdout: `${JSON.stringify({
            healthy: true,
            expectedPort: 8081,
            expectedSource: "branch@commit",
            currentSourceOnExpectedPort: true,
            anyMetro: true,
            targetSimulatorUdid: SIMULATOR_UDID,
            targetBooted: true,
          })}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: { run },
      environment: {
        PATH: "/safe/bin",
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        GH_TOKEN: "ghp_should_not_reach_builds",
        XDT_CODEX_API_KEY: "should-not-reach-builds",
      },
    });
    const signal = new AbortController().signal;
    await expect(
      builder.validateLaunch(root, SIMULATOR_UDID.toLowerCase(), signal),
    ).resolves.toMatchObject({
      healthy: true,
      expectedPort: 8081,
    });
    expect(run).toHaveBeenCalledWith(
      "pnpm",
      ["mobile:sim:whoami", "--", "--json", "--udid", SIMULATOR_UDID],
      expect.objectContaining({
        cwd: await realpath(root),
        signal,
        env: {
          DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
          PATH: "/safe/bin",
        },
      }),
    );
  });

  it("rejects a non-exact Simulator target before launch validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const run = vi.fn();
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });

    await expect(builder.validateLaunch(root, "booted")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when whoami reports a different booted Simulator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: JSON.stringify({
            healthy: true,
            expectedPort: 8081,
            expectedSource: "branch@commit",
            currentSourceOnExpectedPort: true,
            anyMetro: true,
            targetSimulatorUdid: "11111111-2222-4333-8444-555555555555",
            targetBooted: true,
          }),
          stderr: "",
          exitCode: 0,
        })),
      },
    });

    await expect(
      builder.validateLaunch(root, SIMULATOR_UDID),
    ).rejects.toMatchObject({ code: "METRO_NOT_READY" });
  });

  it("fails closed when Cindy Mobile Metro is missing or stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: JSON.stringify({
            healthy: false,
            expectedPort: 8081,
            expectedSource: "branch@commit",
            currentSourceOnExpectedPort: false,
            anyMetro: false,
            targetSimulatorUdid: SIMULATOR_UDID,
            targetBooted: true,
          }),
          stderr: "",
          exitCode: 1,
        })),
      },
    });
    await expect(
      builder.validateLaunch(root, SIMULATOR_UDID),
    ).rejects.toMatchObject({
      code: "METRO_NOT_READY",
    });
  });

  it("fails closed when multiple workspaces are present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "One.xcworkspace"));
    await mkdir(path.join(root, "Two.xcworkspace"));
    await expect(
      new IOSSimulatorProjectBuilder().inspect(root),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_XCODE_PROJECT",
      message: expect.stringContaining("One.xcworkspace"),
    });
  });

  it("builds an explicitly selected Xcode container without repository-specific rules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const selected = path.join(root, "Examples", "Selected.xcworkspace");
    const other = path.join(root, "Other.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Selected.app");
    await mkdir(selected, { recursive: true });
    await mkdir(other);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Selected"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("-showBuildSettings")) {
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR: path.dirname(appPath),
                WRAPPER_NAME: "Selected.app",
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        containerPath: "Examples/Selected.xcworkspace",
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      }),
    ).resolves.toMatchObject({
      kind: "xcode-workspace",
      containerPath: await realpath(selected),
      scheme: "Selected",
    });
    expect(run).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-workspace", await realpath(selected)]),
      expect.objectContaining({ cwd: await realpath(path.dirname(selected)) }),
    );
  });

  it("rejects invalid, missing, and worktree-external explicit containers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-project-"));
    roots.push(root, outside);
    const outsideWorkspace = path.join(outside, "Outside.xcworkspace");
    await mkdir(outsideWorkspace);
    // Windows 上目录符号链接走 junction（无需管理员/开发者模式），
    // 其他平台走 'dir'。junction escape 同样会被 inspect() 的 realpath 检测到。
    await symlink(
      outsideWorkspace,
      path.join(root, "Escape.xcworkspace"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const builder = new IOSSimulatorProjectBuilder();

    await expect(builder.inspect(root, "README.md")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      builder.inspect(root, "Missing.xcodeproj"),
    ).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(builder.inspect(root, outsideWorkspace)).rejects.toMatchObject(
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await expect(
      builder.inspect(root, "Escape.xcworkspace"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("reports a bounded list of available schemes instead of requiring guesses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const schemes = Array.from(
      { length: 12 },
      (_, index) => `Scheme-${String(index + 1).padStart(2, "0")}`,
    );
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: JSON.stringify({ workspace: { schemes } }),
          stderr: "",
          exitCode: 0,
        })),
      },
    });

    await expect(
      builder.build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_XCODE_PROJECT",
      message: expect.stringMatching(/Scheme-01.*Scheme-08.*and 4 more/),
    });
  });

  it("rejects a non-exact simulator destination before invoking Xcode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>();

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: "booted",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "simulatorUdid must be an exact simulator UUID",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("builds one shared scheme for the exact simulator and resolves its app product", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  TARGET_BUILD_DIR: path.dirname(appPath),
                  WRAPPER_NAME: "Example.app",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const result = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
      environment: {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        GH_TOKEN: "ghp_should_not_reach_xcode",
        NODE_OPTIONS: "--require=/tmp/untrusted.js",
      },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID.toLowerCase(),
    });
    expect(result).toMatchObject({
      kind: "xcode-workspace",
      scheme: "Example",
      appPath: await realpath(appPath),
    });
    expect(run).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining([
        "-destination",
        `platform=iOS Simulator,id=${SIMULATOR_UDID}`,
        "build",
      ]),
      expect.any(Object),
    );
    const settingsCall = run.mock.calls.find(([, args]) =>
      args.includes("-showBuildSettings"),
    );
    expect(settingsCall?.[1]).not.toContain("-resultBundlePath");
    for (const [, , options] of run.mock.calls) {
      expect(options?.env).toEqual({
        HOME: "/safe/home",
        PATH: "/safe/bin",
      });
      expect(options?.env).not.toHaveProperty("GH_TOKEN");
      expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
    }
  });

  it("uses a fresh xcresult bundle for each build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("-showBuildSettings")) {
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR: path.dirname(appPath),
                WRAPPER_NAME: "Example.app",
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      const resultBundleIndex = args.indexOf("-resultBundlePath");
      if (resultBundleIndex >= 0) {
        await mkdir(args[resultBundleIndex + 1]!, { recursive: true });
      }
      return { stdout: "build succeeded", stderr: "", exitCode: 0 };
    });
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });
    const input = {
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
    };

    const first = await builder.build(input);
    const second = await builder.build(input);

    expect(first.resultBundlePath).toMatch(/CindyBuild-[0-9a-f-]+\.xcresult$/);
    expect(second.resultBundlePath).toMatch(/CindyBuild-[0-9a-f-]+\.xcresult$/);
    expect(second.resultBundlePath).not.toBe(first.resultBundlePath);
  });

  it("retains bounded build diagnostics when xcodebuild fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      const resultBundleIndex = args.indexOf("-resultBundlePath");
      if (resultBundleIndex >= 0) {
        await mkdir(args[resultBundleIndex + 1]!, { recursive: true });
      }
      return {
        stdout: "compile output\nBUILD_FAILURE_MARKER",
        stderr: "error: compile failed",
        exitCode: 65,
        outputTruncated: true,
      };
    });

    const error = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    })
      .build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(IOSSimulatorProjectBuildError);
    expect(error).toMatchObject({
      name: "IOSSimulatorProjectBuildError",
      code: "APP_BUILD_FAILED",
      buildLogTail: expect.stringMatching(
        /Earlier command output.*BUILD_FAILURE_MARKER.*compile failed/s,
      ),
      resultBundlePath: expect.stringMatching(
        /CindyBuild-[0-9a-f-]+\.xcresult$/,
      ),
      outputTruncated: true,
    });
  });

  it("cancels an in-flight Xcode build before running later build steps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const controller = new AbortController();
    let resultBundlePath = "";
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        options?: Parameters<IOSSimulatorCommandRunner["run"]>[2],
      ) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        const resultBundleIndex = args.indexOf("-resultBundlePath");
        if (resultBundleIndex >= 0) {
          resultBundlePath = args[resultBundleIndex + 1]!;
          await mkdir(resultBundlePath, { recursive: true });
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        throw new Error("build continued after cancellation");
      },
    );
    const buildPromise = new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(resultBundlePath).not.toBe(""));

    controller.abort();

    await expect(buildPromise).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      run.mock.calls.every(
        ([, , options]) => options?.signal === controller.signal,
      ),
    ).toBe(true);
    await expect(realpath(resultBundlePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the xcresult when cancellation interrupts final build settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    await mkdir(workspace);
    const controller = new AbortController();
    let resultBundlePath = "";
    let finalSettingsStarted = false;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("build")) {
          const resultBundleIndex = args.indexOf("-resultBundlePath");
          resultBundlePath = args[resultBundleIndex + 1]!;
          await mkdir(resultBundlePath, { recursive: true });
          return { stdout: "build succeeded", stderr: "", exitCode: 0 };
        }
        if (args.includes("-showBuildSettings")) {
          finalSettingsStarted = true;
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        throw new Error("unexpected xcodebuild invocation");
      },
    );
    const buildPromise = new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(finalSettingsStarted).toBe(true));

    controller.abort();

    await expect(buildPromise).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    await expect(realpath(resultBundlePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels an in-flight xcresult read through the command runner", async () => {
    const controller = new AbortController();
    const run = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        options?: Parameters<IOSSimulatorCommandRunner["run"]>[2],
      ) => {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return { stdout: "", stderr: "", exitCode: null };
      },
    );
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });
    const readPromise = builder.readXcresult(
      "/tmp/CindyBuild-cancelled.xcresult",
      1024,
      controller.signal,
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    controller.abort();

    await expect(readPromise).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      [
        "xcresulttool",
        "get",
        "--path",
        "/tmp/CindyBuild-cancelled.xcresult",
        "--format",
        "json",
      ],
      expect.objectContaining({
        signal: controller.signal,
        maxBufferBytes: 1024,
      }),
    );
  });

  it("retries an xcresult read with the explicit legacy object command when Xcode requires it", async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("--legacy")) {
        return {
          stdout: '{"issues":[]}',
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
        stderr:
          "Error: This command is deprecated and will be removed in a future release, --legacy flag is required to use it.",
        exitCode: 64,
      };
    });
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });
    const resultBundlePath = "/tmp/CindyBuild-xcode-26.xcresult";

    await expect(builder.readXcresult(resultBundlePath, 1024)).resolves.toBe(
      '{"issues":[]}\n',
    );
    expect(run).toHaveBeenNthCalledWith(
      1,
      "xcrun",
      ["xcresulttool", "get", "--path", resultBundlePath, "--format", "json"],
      expect.objectContaining({ maxBufferBytes: 1024 }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "xcrun",
      [
        "xcresulttool",
        "get",
        "object",
        "--legacy",
        "--path",
        resultBundlePath,
        "--format",
        "json",
      ],
      expect.objectContaining({ maxBufferBytes: 1024 }),
    );
  });

  it("does not retry an unrelated xcresult read failure", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "Error: the result bundle is unreadable",
      exitCode: 1,
    }));
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });

    await expect(
      builder.readXcresult("/tmp/CindyBuild-unreadable.xcresult"),
    ).rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("pre-flights the target architecture before building when arm64 is excluded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    await mkdir(workspace);
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  ARCHS: "arm64 x86_64",
                  EXCLUDED_ARCHS: "arm64",
                  TARGET_BUILD_DIR: path.join(root, "derived", "Build"),
                  WRAPPER_NAME: "Example.app",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
        expectedArch: "arm64",
      }),
    ).rejects.toMatchObject({
      code: "APP_ARCH_MISMATCH",
      message: expect.stringMatching(
        /app target would produce architectures \[x86_64\].*needs arm64.*ARCHS and EXCLUDED_ARCHS/s,
      ),
    });
    // The build command must never run when the preflight rejects.
    expect(run.mock.calls.some(([, args]) => args.includes("build"))).toBe(
      false,
    );
  });

  it("proceeds to build when the target architecture is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    const clonedSourcePackagesDirPath = path.join(root, "spm");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  ARCHS: "arm64 x86_64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                  WRAPPER_NAME: "Example.app",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const inspectionTimeoutMs = 5 * 60_000;
    const buildTimeoutMs = 30 * 60_000;
    const result = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
      inspectionTimeoutMs,
      buildTimeoutMs,
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      expectedArch: "arm64",
      clonedSourcePackagesDirPath,
    });
    expect(result).toMatchObject({ scheme: "Example" });
    const xcodeCalls = run.mock.calls.map(([, args]) => args);
    expect(xcodeCalls).toHaveLength(4);
    expect(xcodeCalls.every((args) => args.includes(RESOLVED_FILE_PIN))).toBe(
      true,
    );
    expect(
      xcodeCalls.every((args) => {
        const index = args.indexOf("-clonedSourcePackagesDirPath");
        return index >= 0 && args[index + 1] === clonedSourcePackagesDirPath;
      }),
    ).toBe(true);
    expect(xcodeCalls[0]).toEqual(expect.arrayContaining(["-list", "-json"]));
    expect(xcodeCalls[1]).toEqual(
      expect.arrayContaining(["-showBuildSettings", "-json"]),
    );
    expect(xcodeCalls[2]).toContain("build");
    expect(xcodeCalls[3]).toEqual(
      expect.arrayContaining(["-showBuildSettings", "-json"]),
    );
    for (const [, args, options] of run.mock.calls) {
      expect(options?.timeoutMs).toBe(
        args.includes("build") ? buildTimeoutMs : inspectionTimeoutMs,
      );
    }
  });

  it("disables the resolved-file pin for the remaining build after Xcode 26.5 rejects -list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    let listAttempts = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          listAttempts += 1;
          if (args.includes(RESOLVED_FILE_PIN)) {
            return {
              stdout: "",
              stderr:
                "xcodebuild: error: a resolved file is required when automatic dependency resolution is disabled and should be placed at /tmp/Example.xcworkspace/xcshareddata/swiftpm/Package.resolved",
              exitCode: 74,
            };
          }
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  ARCHS: "arm64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                  WRAPPER_NAME: "Example.app",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    await new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      expectedArch: "arm64",
    });

    expect(listAttempts).toBe(2);
    expect(run.mock.calls[0]![1]).toContain(RESOLVED_FILE_PIN);
    expect(run.mock.calls[1]![1]).not.toContain(RESOLVED_FILE_PIN);
    expect(
      run.mock.calls
        .slice(1)
        .every(([, args]) => !args.includes(RESOLVED_FILE_PIN)),
    ).toBe(true);
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      expect.arrayContaining(["-list", "-json", RESOLVED_FILE_PIN]),
      expect.arrayContaining(["-list", "-json"]),
      expect.arrayContaining(["-showBuildSettings", "-json"]),
      expect.arrayContaining(["build"]),
      expect.arrayContaining(["-showBuildSettings", "-json"]),
    ]);
  });

  it("retries a missing Package.resolved build with a fresh xcresult path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  ARCHS: "arm64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                  WRAPPER_NAME: "Example.app",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        const resultBundleIndex = args.indexOf("-resultBundlePath");
        if (args.includes("build") && resultBundleIndex >= 0) {
          await mkdir(args[resultBundleIndex + 1]!, { recursive: true });
        }
        if (args.includes("build") && args.includes(RESOLVED_FILE_PIN)) {
          return {
            stdout: "",
            stderr:
              "xcodebuild: error: a resolved file is required when automatic dependency resolution is disabled and should be placed at /tmp/Example.xcworkspace/xcshareddata/swiftpm/Package.resolved",
            exitCode: 65,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
    });
    const buildCalls = run.mock.calls.filter(([, args]) =>
      args.includes("build"),
    );
    expect(buildCalls).toHaveLength(2);
    expect(buildCalls[0]![1]).toContain(RESOLVED_FILE_PIN);
    expect(buildCalls[1]![1]).not.toContain(RESOLVED_FILE_PIN);
    const firstResultBundleIndex =
      buildCalls[0]![1].indexOf("-resultBundlePath");
    const secondResultBundleIndex =
      buildCalls[1]![1].indexOf("-resultBundlePath");
    expect(firstResultBundleIndex).toBeGreaterThanOrEqual(0);
    expect(secondResultBundleIndex).toBeGreaterThanOrEqual(0);
    expect(buildCalls[1]![1][secondResultBundleIndex + 1]).not.toBe(
      buildCalls[0]![1][firstResultBundleIndex + 1],
    );
    expect(
      run.mock.calls
        .slice(run.mock.calls.indexOf(buildCalls[1]!))
        .every(([, args]) => !args.includes(RESOLVED_FILE_PIN)),
    ).toBe(true);
  });

  it("does not retry when a compile failure only mentions Package.resolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("build")) {
          return {
            stdout: "Compile Swift source files",
            stderr:
              "error: cannot find 'Resolved' in scope\nnote: see Package.resolved for locked versions",
            exitCode: 65,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      }),
    ).rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    expect(
      run.mock.calls.filter(([, args]) => args.includes("build")),
    ).toHaveLength(1);
  });

  it("does not retry when Package.resolved and a missing-file error are on different lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("build")) {
          return {
            stdout: "note: resolved versions are listed in Package.resolved",
            stderr:
              "error: 'Header.h' file not found\nNo such file or directory: Foo.swift",
            exitCode: 65,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      }),
    ).rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    expect(
      run.mock.calls.filter(([, args]) => args.includes("build")),
    ).toHaveLength(1);
  });

  it("does not retry when unable to load a different resolved file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("build")) {
          return {
            stdout: "",
            stderr:
              "error: unable to load the resolved file of Foo.xcframework",
            exitCode: 65,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
      }),
    ).rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    expect(
      run.mock.calls.filter(([, args]) => args.includes("build")),
    ).toHaveLength(1);
  });

  it("selects the primary application when a scheme builds auxiliary app products", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          // App Clip and Watch targets also produce `.app` wrappers. Both the
          // architecture preflight and final artifact lookup must select the
          // primary iOS application by PRODUCT_TYPE, not wrapper extension.
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  PRODUCT_TYPE: "com.apple.product-type.app-extension",
                  WRAPPER_NAME: "ExampleExtension.appex",
                  ARCHS: "x86_64",
                },
              },
              {
                buildSettings: {
                  PRODUCT_TYPE:
                    "com.apple.product-type.application.on-demand-install-capable",
                  WRAPPER_NAME: "ExampleClip.app",
                  ARCHS: "x86_64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                },
              },
              {
                buildSettings: {
                  PRODUCT_TYPE: "com.apple.product-type.application.watchapp2",
                  WRAPPER_NAME: "ExampleWatch.app",
                  ARCHS: "x86_64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                },
              },
              {
                buildSettings: {
                  PRODUCT_TYPE: "com.apple.product-type.application",
                  WRAPPER_NAME: "Example.app",
                  ARCHS: "arm64 x86_64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const result = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      expectedArch: "arm64",
    });
    expect(result).toMatchObject({ scheme: "Example" });
  });

  it("fails open when architecture preflight cannot identify one unique .app target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    let settingsCalls = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          settingsCalls += 1;
          return {
            stdout: JSON.stringify(
              settingsCalls === 1
                ? [
                    {
                      buildSettings: {
                        WRAPPER_NAME: "Example.app",
                        ARCHS: "x86_64",
                      },
                    },
                    {
                      buildSettings: {
                        WRAPPER_NAME: "ExampleHelper.app",
                        ARCHS: "arm64",
                      },
                    },
                  ]
                : [
                    {
                      buildSettings: {
                        WRAPPER_NAME: "Example.app",
                        TARGET_BUILD_DIR: path.dirname(appPath),
                      },
                    },
                  ],
            ),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
        expectedArch: "arm64",
      }),
    ).resolves.toMatchObject({ scheme: "Example" });
    expect(run.mock.calls.some(([, args]) => args.includes("build"))).toBe(
      true,
    );
  });

  it("does not guess when a scheme contains multiple primary application targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const products = path.join(root, "derived", "Build");
    await mkdir(workspace);
    await mkdir(path.join(products, "Example.app"), { recursive: true });
    await mkdir(path.join(products, "ExampleAdmin.app"), { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  PRODUCT_TYPE: "com.apple.product-type.application",
                  WRAPPER_NAME: "Example.app",
                  TARGET_BUILD_DIR: products,
                  ARCHS: "x86_64",
                },
              },
              {
                buildSettings: {
                  PRODUCT_TYPE: "com.apple.product-type.application",
                  WRAPPER_NAME: "ExampleAdmin.app",
                  TARGET_BUILD_DIR: products,
                  ARCHS: "arm64",
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
        simulatorUdid: SIMULATOR_UDID,
        expectedArch: "arm64",
      }),
    ).rejects.toMatchObject({
      code: "APP_ARTIFACT_INVALID",
      message: "The Xcode build did not produce one unambiguous app artifact.",
    });
    // Ambiguous target selection must fail open during the architecture
    // preflight, then fail closed only after the actual build cannot identify
    // one installable product.
    expect(run.mock.calls.some(([, args]) => args.includes("build"))).toBe(
      true,
    );
    expect(
      run.mock.calls.filter(([, args]) => args.includes("-showBuildSettings")),
    ).toHaveLength(2);
  });

  it("ignores arch exclusions from targets not embedded in the app", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("-showBuildSettings")) {
          // 测试 bundle (.xctest) 排除 arm64 不影响主 app 的预检。
          return {
            stdout: JSON.stringify([
              {
                buildSettings: {
                  WRAPPER_NAME: "ExampleTests.xctest",
                  ARCHS: "arm64 x86_64",
                  EXCLUDED_ARCHS: "arm64",
                },
              },
              {
                buildSettings: {
                  WRAPPER_NAME: "Example.app",
                  ARCHS: "arm64 x86_64",
                  TARGET_BUILD_DIR: path.dirname(appPath),
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const result = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      simulatorUdid: SIMULATOR_UDID,
      expectedArch: "arm64",
    });
    expect(result).toMatchObject({ scheme: "Example" });
  });
});
