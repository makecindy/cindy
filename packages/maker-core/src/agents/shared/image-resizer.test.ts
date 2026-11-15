// 测试价值：unit；生产入口 ImageResizer.process。依据 PR 2 保留附件格式合同。
// 原覆盖只有文件权限；最小输入 PNG/JPEG 附件。验证缓存文件真实 MIME 与后缀；本机执行 0.257s。
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  // PR #10664: queued attachments used to retain full source buffers before
  // acquiring an encoding slot. Unit: real process(), three >500KB PNGs and
  // one duplicate; a read barrier exposes eager reads without timing assertions.
  it("reads sources only inside the concurrency limit and coalesces duplicate paths", async () => {
    const root = await tempDir();
    const sources = [0, 1, 2].map(i => path.join(root, `source-${i}.png`));
    await Promise.all(sources.map((file, i) => sharp({
      create: { width: 512, height: 384, channels: 3, background: { r: i * 60, g: 80, b: 120 } },
    }).png({ compressionLevel: 0 }).toFile(file)));
    for (const file of sources) expect((await fs.stat(file)).size).toBeGreaterThan(500_000);
    const resizer = new ImageResizer({ cacheDir: path.join(root, "cache"), concurrency: 1 });
    await resizer.process(""); // Finish cache initialization before observing IO.
    const originalRead = fs.readFile;
    const originalStat = fs.stat;
    let release!: () => void;
    let statDone!: () => void;
    const readBarrier = new Promise<void>(resolve => { release = resolve; });
    const allStats = new Promise<void>(resolve => { statDone = resolve; });
    const reads: string[] = [];
    let stats = 0;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      if (sources.includes(String(args[0])) && ++stats === 4) statDone();
      return result;
    });
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (sources.includes(String(args[0]))) {
        reads.push(String(args[0]));
        await readBarrier;
      }
      return originalRead(...args);
    });
    const jobs = [sources[0], ...sources].map(file => resizer.process(file));
    let results: string[] = [];
    try {
      await allStats;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reads).toHaveLength(1);
    } finally {
      release();
      try { results = await Promise.all(jobs); }
      finally { readSpy.mockRestore(); statSpy.mockRestore(); }
    }
    expect(reads).toHaveLength(3);
    expect(new Set(reads)).toEqual(new Set(sources));
    expect(results[0]).toBe(results[1]);
    for (const result of results) {
      expect(path.dirname(result)).toBe(resizer.cacheDir);
      expect((await sharp(result).metadata()).format).toBe("png");
    }
  });

  it("keeps PNG/JPEG output formats while applying the existing size rule", async () => {
    const root = await tempDir();
    const cacheDir = path.join(root, "cache");
    const png = path.join(root, "source.png");
    const jpeg = path.join(root, "source.jpg");
    const raw = Buffer.alloc(900 * 700 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 255;
    await sharp(raw, { raw: { width: 900, height: 700, channels: 3 } }).png().toFile(png);
    await sharp(raw, { raw: { width: 900, height: 700, channels: 3 } }).jpeg({ quality: 100 }).toFile(jpeg);
    const resizer = new ImageResizer({ cacheDir, skipUnderBytes: 0 });
    const pngResult = await resizer.process(png);
    const jpegResult = await resizer.process(jpeg);
    expect(path.extname(pngResult)).toBe(".png");
    expect(path.extname(jpegResult)).toBe(".jpg");
    expect((await sharp(pngResult).metadata()).format).toBe("png");
    expect((await sharp(jpegResult).metadata()).format).toBe("jpeg");
  });

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
    const root = await tempDir();
    const target = path.join(root, "attacker-readable");
    const cacheDir = path.join(root, "cache-link");
    await fs.mkdir(target, { mode: 0o755 });
    const targetMode = (await fs.stat(target)).mode & 0o777;
    await fs.symlink(
      target,
      cacheDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const resizer = new ImageResizer({ cacheDir });
    await expect(resizer.process("/does/not/matter.png")).resolves.toBe(
      "/does/not/matter.png",
    );
    expect((await fs.stat(target)).mode & 0o777).toBe(targetMode);
  });
});
