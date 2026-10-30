import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentDeps } from "../base-agent.js";

type ManagedSkills = Awaited<
  ReturnType<NonNullable<AgentDeps["getManagedSkills"]>>
>;

/** Claude ignores skillOverrides for plugins. Mount only this session's allowed skills. */
export async function prepareManagedSkillPlugins(
  skills: ManagedSkills,
  onUnavailable?: (name: string) => void,
): Promise<{
  roots: string[];
  dispose: () => Promise<void>;
}> {
  if (!skills.length) return { roots: [], dispose: async () => {} };
  const staging = await fs.mkdtemp(
    path.join(os.tmpdir(), "cindy-claude-skills-"),
  );
  const dispose = () => fs.rm(staging, { recursive: true, force: true });
  const roots = new Map<string, string>();
  try {
    for (const skill of skills) {
      if (!skill.path)
        throw new Error(`Managed skill has no path: ${skill.name}`);
      const [pluginName, skillName, extra] = skill.claudeCommandName.split(":");
      if (
        extra !== undefined ||
        !pluginName ||
        !skillName ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pluginName) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName)
      ) {
        throw new Error(
          `Invalid managed Claude command: ${skill.claudeCommandName}`,
        );
      }
      // An uninstall can finish after discovery but before projection. Only a
      // missing source is skippable; other I/O failures still fail closed.
      let source: string;
      try {
        source = await fs.realpath(path.dirname(skill.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        onUnavailable?.(skill.claudeCommandName);
        continue;
      }
      let root = roots.get(pluginName);
      if (!root) {
        root = path.join(staging, pluginName);
        await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
        await fs.mkdir(path.join(root, "skills"));
        await fs.writeFile(
          path.join(root, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: pluginName, version: "1.0.0" }),
        );
        roots.set(pluginName, root);
      }
      // Freeze the approved source rather than following a mutable discovery link.
      await fs.symlink(
        source,
        path.join(root, "skills", skillName),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    return { roots: [...roots.values()], dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
