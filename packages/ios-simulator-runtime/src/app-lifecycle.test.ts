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

import { IOSSimulatorAppLifecycle } from "./app-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("IOSSimulatorAppLifecycle", () => {
  it("inspects, installs, and launches only an in-worktree app on an exact UDID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-app-"));
    roots.push(root);
    const appPath = path.join(root, "build", "Example.app");
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    const run = vi.fn(async (command: string, args: readonly string[]) => ({
      stdout: command === "/usr/bin/plutil" ? "com.example.app\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const signal = new AbortController().signal;
    const artifact = await lifecycle.inspectArtifact(root, appPath, undefined, signal);
    await lifecycle.installExact("EXACT-UDID", artifact, signal);
    await lifecycle.launchExact("EXACT-UDID", artifact, ["--uitesting"], signal);
    await lifecycle.terminateExact("EXACT-UDID", artifact.bundleId, signal);
    await lifecycle.openUrlExact("EXACT-UDID", "demo://home", signal);

    const resolvedAppPath = await realpath(appPath);
    expect(artifact).toMatchObject({
      bundleId: "com.example.app",
      appPath: resolvedAppPath,
      authorizedRoot: await realpath(root),
    });
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "EXACT-UDID", resolvedAppPath],
      expect.objectContaining({ signal }),
    );
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "EXACT-UDID", "com.example.app", "--uitesting"],
      expect.objectContaining({ signal }),
    );
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "terminate", "EXACT-UDID", "com.example.app"],
      expect.objectContaining({ signal }),
    );
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "openurl", "EXACT-UDID", "demo://home"],
      expect.objectContaining({ signal }),
    );
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/plutil",
      expect.any(Array),
      expect.objectContaining({ signal }),
    );
  });

  it("reports cancellation when a simctl app operation is aborted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-cancel-"));
    roots.push(root);
    const appPath = path.join(root, "Demo.app");
    await mkdir(appPath);
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    const controller = new AbortController();
    let abortInstall = false;
    const run = vi.fn(async (command: string) => {
      if (command === "/usr/bin/plutil") {
        return { stdout: "com.example.demo\n", stderr: "", exitCode: 0 };
      }
      if (abortInstall) controller.abort();
      return { stdout: "", stderr: "", exitCode: null };
    });
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const artifact = await lifecycle.inspectArtifact(root, appPath);
    abortInstall = true;

    await expect(
      lifecycle.installExact("EXACT-UDID", artifact, controller.signal),
    ).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["install", "EXACT-UDID"]),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("revalidates and installs an app inside the Host-authorized build root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-worktree-"));
    const buildRoot = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-derived-data-"));
    roots.push(root, buildRoot);
    const appPath = path.join(buildRoot, "Build", "Demo.app");
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    const run = vi.fn(async (command: string) => ({
      stdout: command === "/usr/bin/plutil" ? "com.example.demo\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const artifact = await lifecycle.inspectArtifact(root, appPath, buildRoot);

    await lifecycle.installExact("EXACT-UDID", artifact);

    expect(artifact.authorizedRoot).toBe(await realpath(buildRoot));
    expect(run.mock.calls.filter(([command]) => command === "/usr/bin/plutil")).toHaveLength(2);
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "EXACT-UDID", await realpath(appPath)],
      expect.any(Object),
    );
  });

  it("rejects an app whose bundle identity changed after inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-identity-"));
    roots.push(root);
    const appPath = path.join(root, "Demo.app");
    await mkdir(appPath);
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    let bundleId = "com.example.original";
    const run = vi.fn(async (command: string) => ({
      stdout: command === "/usr/bin/plutil" ? `${bundleId}\n` : "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const artifact = await lifecycle.inspectArtifact(root, appPath);
    bundleId = "com.example.replaced";

    await expect(lifecycle.installExact("EXACT-UDID", artifact)).rejects.toMatchObject({
      code: "APP_ARTIFACT_INVALID",
    });
    expect(run).not.toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["simctl", "install"]),
      expect.anything(),
    );
  });

  it("rejects an app path redirected outside its authorized roots after inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-redirect-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-redirect-outside-"));
    roots.push(root, outside);
    const appPath = path.join(root, "Demo.app");
    const outsideAppPath = path.join(outside, "Demo.app");
    await mkdir(appPath);
    await mkdir(outsideAppPath);
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    await writeFile(path.join(outsideAppPath, "Info.plist"), "plist");
    const run = vi.fn(async (command: string) => ({
      stdout: command === "/usr/bin/plutil" ? "com.example.demo\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const artifact = await lifecycle.inspectArtifact(root, appPath);
    await rm(appPath, { recursive: true });
    await symlink(outsideAppPath, appPath, process.platform === "win32" ? "junction" : "dir");

    await expect(lifecycle.installExact("EXACT-UDID", artifact)).rejects.toMatchObject({
      code: "APP_ARTIFACT_INVALID",
    });
    expect(run).not.toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["simctl", "install"]),
      expect.anything(),
    );
  });

  it("rejects app artifacts outside the worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-outside-"));
    roots.push(root, outside);
    const appPath = path.join(outside, "Example.app");
    await mkdir(appPath);
    const lifecycle = new IOSSimulatorAppLifecycle();
    await expect(
      lifecycle.inspectArtifact(root, appPath),
    ).rejects.toMatchObject({
      code: "APP_ARTIFACT_INVALID",
    });
  });

  it("rejects unsafe URL schemes before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    await expect(
      lifecycle.openUrlExact("EXACT-UDID", "file:///etc/passwd"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
