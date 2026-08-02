import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mimeTypeForFilename,
  persistWecomDownload,
  readWecomOutboundFile,
  resolveAllowedWecomOutboundFile,
  safeWecomFilename,
} from "../media.js";

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

  it("persists a downloaded file below the channel directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-"));
    tempDirs.push(dir);
    const stored = await persistWecomDownload({
      mediaDir: dir,
      buffer: Buffer.from("hello"),
      filename: "../notes.txt",
    });
    expect(path.dirname(stored.absPath)).toBe(dir);
    expect(await fs.readFile(stored.absPath, "utf8")).toBe("hello");
    expect(stored.originalName).toBe("notes.txt");
    expect(stored.mimeType).toBe("text/plain");
  });

  it("removes a staged download when ownership changes during the write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-wecom-"));
    tempDirs.push(dir);
    let checks = 0;

    await expect(
      persistWecomDownload({
        mediaDir: dir,
        buffer: Buffer.from("stale"),
        filename: "stale.txt",
        shouldKeep: () => (checks += 1) === 1,
      }),
    ).rejects.toThrow("WECOM_MEDIA_STALE");

    expect(await fs.readdir(dir)).toEqual([]);
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
