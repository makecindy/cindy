import { promises as fs } from "node:fs";
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

describe("review read scope", () => {
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

  it("resolves symlinks before checking both scope and credential policy", async () => {
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
});
