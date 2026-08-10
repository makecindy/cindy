import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IOSSimulatorCommandRunner } from "../types.js";
import {
  abortWdaSourcePreparationForExit,
  createWdaBuildCacheKey,
  prepareWdaSource,
} from "./source-provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-wda-source-test-"));
  roots.push(root);
  const archivePath = path.join(root, "wda.tar.gz");
  const archive = Buffer.from("fixed archive bytes");
  await writeFile(archivePath, archive);
  const manifest = {
    tag: "v-test",
    revision: "a".repeat(40),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
  const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
    async (_command, args) => {
      const destination = args[args.indexOf("-C") + 1];
      if (!destination) throw new Error("missing extraction destination");
      await mkdir(path.join(destination, "WebDriverAgent.xcodeproj"), {
        recursive: true,
      });
      await writeFile(
        path.join(destination, "WebDriverAgent.xcodeproj", "project.pbxproj"),
        "project",
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  );
  return {
    root,
    archivePath,
    cacheRoot: path.join(root, "cache"),
    manifest,
    runner: { run },
    run,
  };
}

describe("prepareWdaSource", () => {
  it("verifies, extracts, marks, and reuses an immutable source cache", async () => {
    const test = await harness();
    const first = await prepareWdaSource({
      archivePath: test.archivePath,
      cacheRoot: test.cacheRoot,
      manifest: test.manifest,
      commandRunner: test.runner,
    });
    expect(first).toMatchObject({
      revision: test.manifest.revision,
      fromCache: false,
    });
    expect(test.run).toHaveBeenCalledWith(
      "/usr/bin/tar",
      [
        "-xzf",
        test.archivePath,
        "-C",
        expect.stringContaining(".extract-"),
        "--strip-components=1",
      ],
      {
        timeoutMs: 60_000,
        maxBufferBytes: 2 * 1024 * 1024,
        signal: expect.any(AbortSignal),
      },
    );
    const marker = JSON.parse(
      await readFile(
        path.join(first.checkoutPath, ".cindy-wda-source.json"),
        "utf8",
      ),
    );
    expect(marker).toMatchObject(test.manifest);

    const second = await prepareWdaSource({
      archivePath: test.archivePath,
      cacheRoot: test.cacheRoot,
      manifest: test.manifest,
      commandRunner: test.runner,
    });
    expect(second.fromCache).toBe(true);
    expect(test.run).toHaveBeenCalledTimes(1);
  });

  it("shares and synchronously aborts in-flight extraction for updater exit", async () => {
    const test = await harness();
    let extractionSignal: AbortSignal | undefined;
    test.run.mockImplementation(async (_command, args, options) => {
      extractionSignal = options?.signal;
      return new Promise((resolve) => {
        const finish = () =>
          resolve({ stdout: "", stderr: "", exitCode: null });
        extractionSignal?.addEventListener("abort", finish, { once: true });
        if (extractionSignal?.aborted) finish();
      });
    });

    const first = prepareWdaSource({
      archivePath: test.archivePath,
      cacheRoot: test.cacheRoot,
      manifest: test.manifest,
      commandRunner: test.runner,
    });
    const second = prepareWdaSource({
      archivePath: test.archivePath,
      cacheRoot: test.cacheRoot,
      manifest: test.manifest,
      commandRunner: test.runner,
    });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledTimes(1));

    abortWdaSourcePreparationForExit();

    expect(extractionSignal?.aborted).toBe(true);
    await expect(first).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });

  it("rejects checksum drift before invoking tar", async () => {
    const test = await harness();
    await expect(
      prepareWdaSource({
        archivePath: test.archivePath,
        cacheRoot: test.cacheRoot,
        manifest: { ...test.manifest, archiveSha256: "b".repeat(64) },
        commandRunner: test.runner,
      }),
    ).rejects.toThrow("integrity verification");
    expect(test.run).not.toHaveBeenCalled();
  });

  it("derives cache identity from source, Xcode, runtime, and architecture", () => {
    const base = {
      sourceRevision: "a".repeat(40),
      xcodeBuild: "17E11",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      architecture: "arm64" as const,
    };
    expect(createWdaBuildCacheKey(base)).toHaveLength(64);
    expect(createWdaBuildCacheKey(base)).not.toBe(
      createWdaBuildCacheKey({ ...base, architecture: "x86_64" }),
    );
  });
});
