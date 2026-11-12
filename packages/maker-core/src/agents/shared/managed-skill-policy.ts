import fs from "node:fs";
import type {
  AgentDeps,
  BotRuntimeSkillPolicy,
  BotRuntimeSkillEntry,
} from "../base-agent.js";
import { canonicalSkillPath, isSkillDisabled } from "./skill-activation.js";

/** Check and mount the same physical file, even if a discovery alias moves later. */
export function resolveAllowedManagedSkills(
  skills: Awaited<ReturnType<NonNullable<AgentDeps["getManagedSkills"]>>>,
  grants: ReadonlySet<string> | undefined,
  disabledPaths: readonly string[],
) {
  return skills.flatMap((skill) => {
    if (!skill.path) return [];
    let source: string;
    try {
      source = fs.realpathSync(skill.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (
      (grants !== undefined && !grants.has(canonicalSkillPath(source))) ||
      isSkillDisabled(source, disabledPaths)
    )
      return [];
    return [{ ...skill, path: source }];
  });
}

/** Freeze only resolved, usable Bot grants; names alone never grant a managed source. */
export function snapshotManagedSkillGrants(
  policy: BotRuntimeSkillPolicy | undefined,
): ReadonlySet<string> | undefined {
  if (!policy) return undefined;
  // The host maps legacy inherit to no external grants. Bot-owned Skills have
  // their own mounting path and are deliberately outside this policy.
  if (policy.mode !== "allowlist") return new Set();
  const catalog = new Map<string, BotRuntimeSkillEntry>();
  for (const item of policy.catalog) {
    catalog.set(item.name.trim(), item);
    if (item.runtimeCommandName?.trim())
      catalog.set(item.runtimeCommandName.trim(), item);
  }
  const allowed = new Set<string>();
  for (const name of policy.configured) {
    const item = catalog.get(name.trim());
    if (
      item?.path &&
      item.enabled !== false &&
      item.runtimeStatus !== "failed"
    ) {
      allowed.add(canonicalSkillPath(item.path));
    }
  }
  return allowed;
}
