import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

export interface IOSSimulatorAppArtifact {
  artifactId: string;
  worktreeRoot: string;
  appPath: string;
  bundleId: string;
  createdAt: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requireBundleId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "APP_ARTIFACT_INVALID",
      "The app bundle identifier is invalid.",
    );
  }
  return normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new IOSSimulatorInstanceError(
    "MUTATION_CANCELLED",
    "The simulator app operation was cancelled because its lifecycle changed.",
    true,
  );
}

/** Exact-UDID simctl app lifecycle with worktree-contained build artifacts. */
export class IOSSimulatorAppLifecycle {
  readonly #runner: IOSSimulatorCommandRunner;

  constructor(options: { commandRunner?: IOSSimulatorCommandRunner } = {}) {
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
  }

  async inspectArtifact(
    worktreeRoot: string,
    appPath: string,
    trustedBuildRoot?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorAppArtifact> {
    throwIfAborted(signal);
    const root = await realpath(worktreeRoot);
    const resolvedApp = await realpath(appPath);
    const resolvedBuildRoot = trustedBuildRoot
      ? await realpath(trustedBuildRoot)
      : null;
    if (
      (!isInside(root, resolvedApp) &&
        (!resolvedBuildRoot || !isInside(resolvedBuildRoot, resolvedApp))) ||
      path.extname(resolvedApp).toLowerCase() !== ".app"
    ) {
      throw new IOSSimulatorInstanceError(
        "APP_ARTIFACT_INVALID",
        "The app artifact must be a .app directory inside the current worktree.",
      );
    }
    const info = await stat(resolvedApp);
    if (!info.isDirectory()) {
      throw new IOSSimulatorInstanceError(
        "APP_ARTIFACT_INVALID",
        "The app artifact is not a directory.",
      );
    }
    const plist = path.join(resolvedApp, "Info.plist");
    const result = await this.#runner.run(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
      { timeoutMs: 15_000, maxBufferBytes: 64 * 1024, signal },
    );
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_ARTIFACT_INVALID",
        "The app artifact does not contain a readable bundle identifier.",
      );
    }
    return {
      artifactId: randomUUID(),
      worktreeRoot: root,
      appPath: resolvedApp,
      bundleId: requireBundleId(result.stdout),
      createdAt: new Date().toISOString(),
    };
  }

  async installExact(
    simulatorUdid: string,
    artifact: IOSSimulatorAppArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const result = await this.#runner.run(
      "xcrun",
      ["simctl", "install", simulatorUdid, artifact.appPath],
      {
        timeoutMs: 120_000,
        signal,
      },
    );
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_INSTALL_FAILED",
        "The app could not be installed.",
        true,
      );
    }
  }

  async launchExact(
    simulatorUdid: string,
    artifact: Pick<IOSSimulatorAppArtifact, "bundleId">,
    args: string[] = [],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (
      args.length > 64 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 4_096)
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "App launch arguments exceed the limit.",
      );
    }
    const result = await this.#runner.run(
      "xcrun",
      [
        "simctl",
        "launch",
        simulatorUdid,
        requireBundleId(artifact.bundleId),
        ...args,
      ],
      { timeoutMs: 30_000, signal },
    );
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_LAUNCH_FAILED",
        "The app could not be launched.",
        true,
      );
    }
  }

  async terminateExact(
    simulatorUdid: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const result = await this.#runner.run(
      "xcrun",
      ["simctl", "terminate", simulatorUdid, requireBundleId(bundleId)],
      { timeoutMs: 30_000, signal },
    );
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_TERMINATE_FAILED",
        "The app could not be terminated.",
        true,
      );
    }
  }

  async openUrlExact(
    simulatorUdid: string,
    rawUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (rawUrl.length > 8_192 || /[\r\n\0]/.test(rawUrl)) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "The URL is invalid.",
      );
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "The URL is invalid.",
      );
    }
    if (
      !url.protocol ||
      url.protocol === "file:" ||
      url.protocol === "javascript:"
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "The URL scheme is not allowed.",
      );
    }
    const result = await this.#runner.run(
      "xcrun",
      ["simctl", "openurl", simulatorUdid, url.toString()],
      { timeoutMs: 30_000, signal },
    );
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "OPEN_URL_FAILED",
        "The URL could not be opened.",
        true,
      );
    }
  }
}
