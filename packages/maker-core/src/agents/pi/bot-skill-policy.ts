import type { BotRuntimeSkillPolicy } from '../base-agent.js';
import type { PiProjectResourceAssemblySnapshot } from './project-resource-assembly.js';

export interface PiBotSkillSelection {
  disableImplicitSkills: boolean;
  explicitSkillPaths: string[];
  projectAssembly: PiProjectResourceAssemblySnapshot;
}

export function applyPiBotSkillPolicy(
  policy: BotRuntimeSkillPolicy | undefined,
  assembly: PiProjectResourceAssemblySnapshot,
): PiBotSkillSelection {
  if (!policy || policy.mode === 'inherit') {
    return {
      disableImplicitSkills: false,
      explicitSkillPaths: [...assembly.launchSkillPaths],
      projectAssembly: assembly,
    };
  }

  const allowed = new Set(policy.configured.map((item) => item.trim()));
  const allowedCatalog = policy.catalog.filter((item) => {
    if (item.enabled === false || item.runtimeStatus === 'failed') return false;
    const runtimeName = item.runtimeCommandName?.trim();
    return allowed.has(item.name.trim()) || (!!runtimeName && allowed.has(runtimeName));
  });
  const projectIndices = assembly.skillPaths.flatMap((sourcePath, index) =>
    allowedCatalog.some((item) => item.path === sourcePath) ? [index] : [],
  );
  const projectAssembly: PiProjectResourceAssemblySnapshot = Object.freeze({
    ...assembly,
    skillPaths: Object.freeze(projectIndices.map((index) => assembly.skillPaths[index]!)),
    launchSkillPaths: Object.freeze(projectIndices.map((index) => assembly.launchSkillPaths[index]!)),
    launchSkillDigests: Object.freeze(projectIndices.map((index) => assembly.launchSkillDigests[index]!)),
    launchSkillSourceFingerprints: Object.freeze(
      projectIndices.map((index) => assembly.launchSkillSourceFingerprints[index]!),
    ),
  });
  const projectSources = new Set(assembly.skillPaths);
  const userSkillPaths = allowedCatalog.flatMap((item) =>
    item.path && item.scope !== 'repo' && !projectSources.has(item.path) ? [item.path] : [],
  );

  return {
    disableImplicitSkills: true,
    explicitSkillPaths: [...new Set([...userSkillPaths, ...projectAssembly.launchSkillPaths])],
    projectAssembly,
  };
}
