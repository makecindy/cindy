import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mimeTypeForFilename,
  readWecomOutboundFile,
  resolveAllowedWecomOutboundFile,
  safeWecomFilename,
  stageWecomDownload,
} from "../media.js";
import type { IMHostFileStaging } from "../../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("WeCom media helpers", () => {
  it("removes path traversal and reserved filename characters", () => {
    expect(safeWecomFilename("../../bad:name?.png")).toBe("bad_name_.png");
    expect(safeWecomFilename(`report${" ".repeat(20_000)}..`)).toBe(
      "report",
    );
  });

  it("prefixes Windows device names while preserving similar filenames", () => {
    expect(safeWecomFilename("CON")).toBe("_CON");
    expect(safeWecomFilename("nul.txt")).toBe("_nul.txt");
    expect(safeWecomFilename("COM1.log")).toBe("_COM1.log");
    expect(safeWecomFilename("LPT9.csv")).toBe("_LPT9.csv");
    expect(safeWecomFilename("console.txt")).toBe("console.txt");
    expect(safeWecomFilename("COM10.log")).toBe("COM10.log");
  });

  it("stages a downloaded file through host.files with a sanitized name", async () => {
    const staging = await makeStaging();
    const stored = await stageWecomDownload({
      files: staging.files,
      buffer: Buffer.from("hello"),
      filename: "../notes.txt",
    });
    expect(staging.files.stage).toHaveBeenCalledTimes(1);
    expect(staging.files.stage).toHaveBeenCalledWith({
      integration: "wecom",
      buffer: Buffer.from("hello"),
      fileName: "notes.txt",
    });
    expect(path.dirname(stored.absPath)).toBe(staging.dir);
    expect(await fs.readFile(stored.absPath, "utf8")).toBe("hello");
    expect(stored.originalName).toBe("notes.txt");
    expect(stored.mimeType).toBe("text/plain");

    await stored.discard();
    expect(await fs.readdir(staging.dir)).toEqual([]);
  });

  it("applies the fallback extension when the platform gives no filename", async () => {
    const staging = await makeStaging();
    const stored = await stageWecomDownload({
      files: staging.files,
      buffer: Buffer.from([1, 2, 3]),
      fallbackExtension: ".jpg",
    });
    expect(stored.originalName).toBe("attachment.jpg");
    expect(stored.mimeType).toBe("image/jpeg");
  });

  it("rejects empty downloads without staging", async () => {
    const staging = await makeStaging();
    await expect(
      stageWecomDownload({
        files: staging.files,
        buffer: Buffer.alloc(0),
        filename: "empty.txt",
      }),
    ).rejects.toThrow("WECOM_MEDIA_EMPTY");
    expect(staging.files.stage).not.toHaveBeenCalled();
  });

  it("does not stage when ownership is already stale", async () => {
    const staging = await makeStaging();
    await expect(
      stageWecomDownload({
        files: staging.files,
        buffer: Buffer.from("stale"),
        filename: "stale.txt",
        shouldKeep: () => false,
      }),
    ).rejects.toThrow("WECOM_MEDIA_STALE");
    expect(staging.files.stage).not.toHaveBeenCalled();
  });

  it("discards a staged download when ownership changes during staging", async () => {
    const staging = await makeStaging();
    let checks = 0;

    await expect(
      stageWecomDownload({
        files: staging.files,
        buffer: Buffer.from("stale"),
        filename: "stale.txt",
        shouldKeep: () => (checks += 1) === 1,
      }),
    ).rejects.toThrow("WECOM_MEDIA_STALE");

    expect(staging.files.stage).toHaveBeenCalledTimes(1);
    expect(staging.discards).toHaveLength(1);
    expect(staging.discards[0]).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(staging.dir)).toEqual([]);
  });

  it("selects outbound media types from safe metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-"));
    tempDirs.push(dir);
    const file = path.join(dir, "picture.png");
    await fs.writeFile(file, Buffer.from([1, 2, 3]));
    const outbound = await readWecomOutboundFile(file);
    expect(outbound.mediaType).toBe("image");
    expect(outbound.filename).toBe("picture.png");
    expect(mimeTypeForFilename("README")).toBe("application/octet-stream");
  });

  it("confines outbound files to an allowed root and returns the canonical path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-root-"));
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-wecom-outside-"),
    );
    tempDirs.push(root, outside);
    const allowedFile = path.join(root, "report.txt");
    const outsideFile = path.join(outside, "secret.txt");
    await Promise.all([
      fs.writeFile(allowedFile, "report"),
      fs.writeFile(outsideFile, "secret"),
    ]);

    await expect(
      resolveAllowedWecomOutboundFile(allowedFile, [root]),
    ).resolves.toBe(await fs.realpath(allowedFile));
    await expect(
      resolveAllowedWecomOutboundFile(outsideFile, [root]),
    ).resolves.toBeNull();
    await expect(
      resolveAllowedWecomOutboundFile(allowedFile, []),
    ).resolves.toBeNull();
  });

  it("rejects a lexical in-root path whose realpath escapes the root", async () => {
    const root = path.resolve("workspace");
    const candidate = path.join(root, "linked", "secret.txt");
    const escaped = path.resolve("outside", "secret.txt");
    const realpath = async (target: string): Promise<string> =>
      target === root ? root : escaped;

    await expect(
      resolveAllowedWecomOutboundFile(candidate, [root], realpath),
    ).resolves.toBeNull();
  });
});

/** Fake host staging that writes into a temp dir so discard can be observed on disk. */
async function makeStaging() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-staging-"));
  tempDirs.push(dir);
  const discards: Array<ReturnType<typeof vi.fn>> = [];
  const stage = vi.fn<IMHostFileStaging["stage"]>(async ({ buffer, fileName }) => {
    const absPath = path.join(dir, fileName);
    await fs.writeFile(absPath, buffer);
    const discard = vi.fn(async () => {
      await fs.rm(absPath, { force: true });
    });
    discards.push(discard);
    return { absPath, discard };
  });
  const files: IMHostFileStaging & { stage: typeof stage } = { stage };
  return { dir, files, discards };
}
