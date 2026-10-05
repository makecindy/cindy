import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSkillPath } from "./skill-activation.js";
import {
  resolveAllowedManagedSkills,
  snapshotManagedSkillGrants,
} from "./managed-skill-policy.js";
import { prepareManagedSkillPlugins } from "../claude-code/managed-skill-plugins.js";

describe("managed skill Bot grants", () => {
  it("checks and mounts the same source if an alias moves between approval and loading", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cindy-managed-grants-"),
    );
    try {
      const approved = path.join(root, "approved");
      const replaced = path.join(root, "replaced");
      const alias = path.join(root, "discovery");
      for (const dir of [approved, replaced]) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "SKILL.md"), "# Fixture");
      }
      fs.symlinkSync(
        approved,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const grants = snapshotManagedSkillGrants({
        mode: "allowlist",
        configured: ["cindy:learn"],
        catalog: [
          {
            name: "learn",
            runtimeCommandName: "cindy:learn",
            path: path.join(alias, "SKILL.md"),
            enabled: true,
          },
        ],
      });
      expect(grants?.has(canonicalSkillPath(approved))).toBe(true);
      const discovered = [
        {
          kind: "agent-skill" as const,
          name: "learn",
          source: "skill" as const,
          claudeCommandName: "cindy:learn",
          path: path.join(alias, "SKILL.md"),
        },
      ];
      const selected = resolveAllowedManagedSkills(discovered, grants, []);
      // Pi receives these exact physical paths as --skill arguments.
      expect(selected[0]?.path).toBe(
        fs.realpathSync(path.join(approved, "SKILL.md")),
      );
      fs.unlinkSync(alias);
      fs.symlinkSync(
        replaced,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(grants?.has(canonicalSkillPath(alias))).toBe(false);
      expect(grants?.has(canonicalSkillPath(approved))).toBe(true);
      expect(resolveAllowedManagedSkills(discovered, grants, [])).toEqual([]);
      const mounted = await prepareManagedSkillPlugins(selected);
      try {
        expect(
          fs.realpathSync.native(path.join(mounted.roots[0]!, "skills", "learn")),
        ).toBe(fs.realpathSync.native(approved));
      } finally {
        await mounted.dispose();
      }
      expect(resolveAllowedManagedSkills(selected, grants, [approved])).toEqual(
        [],
      );
      fs.rmSync(approved, { recursive: true });
      expect(resolveAllowedManagedSkills(selected, grants, [])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
