import { mkdirSync, mkdtempSync, promises as fs, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertReviewMessageContentPaths,
  buildReviewReadGrants,
  resolveReviewReadPath,
} from "./review-read-scope.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-review-scope-"));
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

/** 探针创建真实符号链接来检测 OS 能力，不靠平台名猜测（开发者模式 Windows 可以 symlink）。 */
function canCreateSymlink(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), "cindy-review-scope-symlink-probe-"));
  try {
    writeFileSync(path.join(probe, "target"), "probe");
    symlinkSync(
      path.join(probe, "target"),
      path.join(probe, "link"),
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const canLink = canCreateSymlink();

describe("review read scope", () => {
  it.runIf(Boolean(process.env.CINDY_REVIEW_REAL_WORKSPACE))(
    "resolves a pnpm-linked source file in an explicitly requested real workspace",
    async () => {
      const workspace = process.env.CINDY_REVIEW_REAL_WORKSPACE!;
      const source = path.join(
        workspace,
        "apps",
        "mobile",
        "modules",
        "xdt-ios-app-distribution",
        "src",
        "index.ts",
      );
      expect((await fs.stat(source)).nlink).toBe(2);

      const grants = await buildReviewReadGrants(workspace, []);
      expect(await resolveReviewReadPath(source, workspace, grants)).toBe(
        await fs.realpath(source),
      );
    },
  );

  it("allows workspace files and exact external attachment grants", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "contract.txt");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "code.ts"), "export {};");
    await fs.writeFile(external, "terms");

    const grants = await buildReviewReadGrants(workspace, [external]);
    const realWorkspaceFile = await fs.realpath(
      path.join(workspace, "code.ts"),
    );
    const realExternal = await fs.realpath(external);
    expect(await resolveReviewReadPath("code.ts", workspace, grants)).toBe(
      realWorkspaceFile,
    );
    expect(await resolveReviewReadPath(external, workspace, grants)).toBe(
      realExternal,
    );
  });

  it("rejects sensitive files before a harness can preprocess them", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const dotenv = path.join(workspace, ".env.local");
    const gitConfig = path.join(workspace, ".git", "config");
    await fs.mkdir(workspace);
    await fs.mkdir(path.dirname(gitConfig));
    await fs.writeFile(dotenv, "TOKEN=secret");
    await fs.writeFile(gitConfig, "url=https://token@example.invalid/repo");

    const grants = await buildReviewReadGrants(workspace, []);
    await expect(
      assertReviewMessageContentPaths(
        [{ type: "image", path: dotenv, mimeType: "image/png" }],
        workspace,
        grants,
      ),
    ).rejects.toThrow(/refused/i);
    await expect(buildReviewReadGrants(workspace, [dotenv])).rejects.toThrow(
      /sensitive/i,
    );
    expect(
      await resolveReviewReadPath(gitConfig, workspace, grants),
    ).toBeNull();
  });

  it.skipIf(!canLink)("resolves symlinks before checking both scope and credential policy", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    const outsideLink = path.join(workspace, "outside-link.txt");
    const keyDir = path.join(root, ".ssh");
    const key = path.join(keyDir, "id_ed25519");
    const keyLink = path.join(workspace, "key.png");
    await fs.mkdir(workspace);
    await fs.mkdir(keyDir);
    await fs.writeFile(outside, "outside");
    await fs.writeFile(key, "private-key");
    await fs.symlink(outside, outsideLink);
    await fs.symlink(key, keyLink);

    const grants = await buildReviewReadGrants(workspace, []);
    expect(
      await resolveReviewReadPath(outsideLink, workspace, grants),
    ).toBeNull();
    expect(await resolveReviewReadPath(keyLink, workspace, grants)).toBeNull();
  });

  it("resolves directory junctions before checking scope and credential policy", async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(workspace);
    await fs.mkdir(outsideDir);
    // 在 worktree 外部目录放一个凭证文件和一个普通文件
    const outsideSecret = path.join(outsideDir, "token.env");
    const outsideDoc = path.join(outsideDir, "notes.txt");
    await fs.writeFile(outsideSecret, "SECRET=value");
    await fs.writeFile(outsideDoc, "public");
    // 目录链接：Windows junction 无需管理员权限
    const linkDir = path.join(workspace, "linked-dir");
    await fs.symlink(
      outsideDir,
      linkDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const grants = await buildReviewReadGrants(workspace, []);
    expect(
      await resolveReviewReadPath(
        path.join(linkDir, "token.env"),
        workspace,
        grants,
      ),
    ).toBeNull();
    expect(
      await resolveReviewReadPath(
        path.join(linkDir, "notes.txt"),
        workspace,
        grants,
      ),
    ).toBeNull();
  });

  it("rejects pre-existing hard links in workspace and explicit file grants", async () => {
    if (process.platform === "win32") return;
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside-secret.txt");
    const linked = path.join(workspace, "linked.txt");
    await fs.mkdir(workspace);
    await fs.writeFile(outside, "sensitive bytes");
    await fs.link(outside, linked);

    const grants = await buildReviewReadGrants(workspace, []);
    expect(await resolveReviewReadPath(linked, workspace, grants)).toBeNull();
    await expect(buildReviewReadGrants(workspace, [outside])).rejects.toThrow(
      /multiply linked/i,
    );
    await expect(
      assertReviewMessageContentPaths(
        [{ type: "image", path: linked, mimeType: "image/png" }],
        workspace,
        grants,
      ),
    ).rejects.toThrow(/refused/i);
  });

  it("allows a two-link pnpm local package source only when its denied mirror is confined", async () => {
    if (process.platform === "win32") return;
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const sourcePackage = path.join(
      workspace,
      "apps",
      "mobile",
      "modules",
      "local-module",
    );
    const source = path.join(sourcePackage, "src", "index.ts");
    const mirror = path.join(
      workspace,
      "node_modules",
      "local-module",
      "src",
      "index.ts",
    );
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await fs.writeFile(source, "export const value = 1;");
    await fs.link(source, mirror);

    const grants = await buildReviewReadGrants(workspace, [
      sourcePackage,
      source,
    ]);
    expect(await resolveReviewReadPath(source, workspace, grants)).toBe(
      await fs.realpath(source),
    );

    const outside = path.join(root, "outside.ts");
    await fs.link(source, outside);
    expect(await resolveReviewReadPath(source, workspace, grants)).toBeNull();
  });

  it("uses a confined package manifest to resolve scoped pnpm mirrors", async () => {
    if (process.platform === "win32") return;
    const root = await makeTempDir();
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(workspace, "packages", "maker-core");
    const manifest = path.join(packageRoot, "package.json");
    const source = path.join(packageRoot, "src", "index.ts");
    const mirror = path.join(
      workspace,
      "node_modules",
      "@cindy",
      "maker-core",
      "src",
      "index.ts",
    );
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await fs.writeFile(manifest, '{"name":"@cindy/maker-core"}');
    await fs.writeFile(source, "export const value = 1;");
    await fs.link(source, mirror);

    const grants = await buildReviewReadGrants(workspace, [
      packageRoot,
      source,
    ]);
    expect(await resolveReviewReadPath(source, workspace, grants)).toBe(
      await fs.realpath(source),
    );

    const outsideManifest = path.join(root, "outside-package.json");
    await fs.writeFile(outsideManifest, '{"name":"@cindy/maker-core"}');
    await fs.unlink(manifest);
    await fs.symlink(outsideManifest, manifest);
    expect(await resolveReviewReadPath(source, workspace, grants)).toBeNull();
  });
});
