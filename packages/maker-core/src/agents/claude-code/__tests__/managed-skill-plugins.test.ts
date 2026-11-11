import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedSkillPlugins } from "../managed-skill-plugins.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((remove) => remove()));
});

describe("private Claude skill projections", () => {
  it("mounts only selected skills, preserves plugin namespaces and removes only temporary links", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-managed-plugin-test-"),
    );
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "approved", "learn");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: learn\ndescription: Fixture\n---\nBody",
    );
    const projection = await prepareManagedSkillPlugins(
      ["cindy", "cindy-plugin-example"].map((plugin) => ({
        kind: "agent-skill",
        name: "learn",
        source: "skill",
        path: path.join(source, "SKILL.md"),
        claudeCommandName: `${plugin}:learn`,
      })),
    );
    cleanup.push(projection.dispose);
    expect(projection.roots).toHaveLength(2);
    for (const plugin of projection.roots) {
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(plugin, ".claude-plugin", "plugin.json"),
            "utf8",
          ),
        ).name,
      ).toBe(path.basename(plugin));
      expect(await fs.readdir(path.join(plugin, "skills"))).toEqual(["learn"]);
      expect(await fs.realpath(path.join(plugin, "skills", "learn"))).toBe(
        await fs.realpath(source),
      );
    }
    await projection.dispose();
    await expect(fs.stat(projection.roots[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toContain(
      "Body",
    );
  });

  it("skips a source removed after discovery while keeping other selected skills", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-managed-plugin-race-"),
    );
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const kept = path.join(root, "kept");
    const removed = path.join(root, "removed");
    await fs.mkdir(kept);
    await fs.mkdir(removed);
    const discovered = [kept, removed].map((source) => ({
      kind: "agent-skill" as const,
      name: path.basename(source),
      source: "skill" as const,
      path: path.join(source, "SKILL.md"),
      claudeCommandName: `cindy:${path.basename(source)}`,
    }));
    await fs.rm(removed, { recursive: true });
    const warnings: string[] = [];
    const projection = await prepareManagedSkillPlugins(discovered, (name) =>
      warnings.push(name),
    );
    cleanup.push(projection.dispose);
    expect(warnings).toEqual(["cindy:removed"]);
    expect(projection.roots).toHaveLength(1);
    expect(await fs.readdir(path.join(projection.roots[0]!, "skills"))).toEqual(
      ["kept"],
    );
  });

  it("does not mount a plugin when no skills are enabled", async () => {
    const projection = await prepareManagedSkillPlugins([]);
    expect(projection.roots).toEqual([]);
    await projection.dispose();
  });
});
