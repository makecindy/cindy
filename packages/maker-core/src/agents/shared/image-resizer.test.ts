import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ImageResizer } from "./image-resizer.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "maker-core-image-cache-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("ImageResizer private cache", () => {
  it("hardens an existing cache directory and files before using them", async () => {
    if (process.platform === "win32") return;
    const root = await tempDir();
    const cacheDir = path.join(root, "cache");
    const cachedImage = path.join(cacheDir, "existing.webp");
    await fs.mkdir(cacheDir, { mode: 0o755 });
    await fs.writeFile(cachedImage, "cached image", { mode: 0o644 });
    await fs.chmod(cacheDir, 0o755);
    await fs.chmod(cachedImage, 0o644);

    const resizer = new ImageResizer({ cacheDir });
    await resizer.process("");

    expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(cachedImage)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlink in place of the cache directory", async () => {
    if (process.platform === "win32") return;
    const root = await tempDir();
    const target = path.join(root, "attacker-readable");
    const cacheDir = path.join(root, "cache-link");
    await fs.mkdir(target, { mode: 0o755 });
    await fs.symlink(target, cacheDir);

    const resizer = new ImageResizer({ cacheDir });
    await expect(resizer.process("/does/not/matter.png")).resolves.toBe(
      "/does/not/matter.png",
    );
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  });
});
