import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "../command-runner.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import { WdaError } from "./errors.js";
import { WDA_SOURCE_PIN } from "./source-pin.js";

const TAR = "/usr/bin/tar";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MARKER_FILE = ".cindy-wda-source.json";

export interface WdaSourceManifest {
  tag: string;
  revision: string;
  archiveSha256: string;
}

export interface PrepareWdaSourceOptions {
  archivePath: string;
  cacheRoot: string;
  manifest?: WdaSourceManifest;
  commandRunner?: IOSSimulatorCommandRunner;
}

export interface PreparedWdaSource {
  checkoutPath: string;
  projectPath: string;
  revision: string;
  fromCache: boolean;
}

export interface WdaBuildCacheIdentity {
  sourceRevision: string;
  xcodeBuild: string;
  runtimeIdentifier: string;
  architecture: "arm64" | "x86_64";
}

interface InFlightWdaSourcePreparation {
  promise: Promise<PreparedWdaSource>;
  controller: AbortController;
}

const inFlight = new Map<string, InFlightWdaSourcePreparation>();

/** Synchronously signal shared extraction subprocesses before updater force-exit. */
export function abortWdaSourcePreparationForExit(): void {
  for (const operation of inFlight.values()) operation.controller.abort();
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `${label} must be an absolute path`,
    );
  }
  return path.normalize(value);
}

function requireManifest(manifest: WdaSourceManifest): WdaSourceManifest {
  if (
    !/^[0-9a-f]{40}$/.test(manifest.revision) ||
    !/^[0-9a-f]{64}$/.test(manifest.archiveSha256) ||
    !manifest.tag.trim()
  ) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      "WDA source manifest is invalid",
    );
  }
  return manifest;
}

async function isPrepared(
  checkoutPath: string,
  manifest: WdaSourceManifest,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(path.join(checkoutPath, MARKER_FILE), "utf8"),
    ) as { revision?: unknown; archiveSha256?: unknown };
    await stat(
      path.join(checkoutPath, "WebDriverAgent.xcodeproj", "project.pbxproj"),
    );
    return (
      marker.revision === manifest.revision &&
      marker.archiveSha256 === manifest.archiveSha256
    );
  } catch {
    return false;
  }
}

async function verifyArchive(
  archivePath: string,
  expectedSha256: string,
): Promise<void> {
  let bytes: Buffer;
  try {
    const metadata = await stat(archivePath);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_ARCHIVE_BYTES
    ) {
      throw new Error("archive size is outside the allowed range");
    }
    bytes = await readFile(archivePath);
  } catch (error) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `Packaged WDA source archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      "Packaged WDA source archive failed integrity verification",
    );
  }
}

/** Deterministic build cache key; no absolute path or Session secret enters it. */
export function createWdaBuildCacheKey(
  identity: WdaBuildCacheIdentity,
): string {
  const payload = [
    identity.sourceRevision,
    identity.xcodeBuild.trim(),
    identity.runtimeIdentifier.trim(),
    identity.architecture,
  ].join("\0");
  return createHash("sha256").update(payload).digest("hex");
}

/** Verify and atomically extract Cindy's packaged WDA source into a local cache. */
export function prepareWdaSource(
  options: PrepareWdaSourceOptions,
): Promise<PreparedWdaSource> {
  const archivePath = requireAbsolute(options.archivePath, "archivePath");
  const cacheRoot = requireAbsolute(options.cacheRoot, "cacheRoot");
  const manifest = requireManifest(options.manifest ?? WDA_SOURCE_PIN);
  const key = `${archivePath}\0${cacheRoot}\0${manifest.revision}`;
  const existing = inFlight.get(key);
  if (existing) return existing.promise;
  const controller = new AbortController();

  const operation = (async () => {
    const runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    const checkoutPath = path.join(cacheRoot, manifest.revision);
    const projectPath = path.join(checkoutPath, "WebDriverAgent.xcodeproj");
    if (await isPrepared(checkoutPath, manifest)) {
      return {
        checkoutPath,
        projectPath,
        revision: manifest.revision,
        fromCache: true,
      };
    }

    await verifyArchive(archivePath, manifest.archiveSha256);
    await mkdir(cacheRoot, { recursive: true });
    const temporaryPath = await mkdtemp(path.join(cacheRoot, ".extract-"));
    try {
      const extracted = await runner.run(
        TAR,
        ["-xzf", archivePath, "-C", temporaryPath, "--strip-components=1"],
        {
          timeoutMs: 60_000,
          maxBufferBytes: 2 * 1024 * 1024,
          signal: controller.signal,
        },
      );
      if (extracted.exitCode !== 0) {
        throw new WdaError(
          "INVALID_CONFIGURATION",
          "Packaged WDA source archive could not be extracted",
        );
      }
      await stat(
        path.join(temporaryPath, "WebDriverAgent.xcodeproj", "project.pbxproj"),
      );
      await writeFile(
        path.join(temporaryPath, MARKER_FILE),
        `${JSON.stringify({
          tag: manifest.tag,
          revision: manifest.revision,
          archiveSha256: manifest.archiveSha256,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rm(checkoutPath, { recursive: true, force: true });
      await rename(temporaryPath, checkoutPath);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      if (error instanceof WdaError) throw error;
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "Extracted WDA source is incomplete",
      );
    }
    return {
      checkoutPath,
      projectPath,
      revision: manifest.revision,
      fromCache: false,
    };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, { promise: operation, controller });
  return operation;
}
