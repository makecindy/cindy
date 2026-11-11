import type { BotRuntimeSkillPolicy } from '../base-agent.js';
import type { PiProjectResourceAssemblySnapshot } from './project-resource-assembly.js';

export interface PiBotSkillSelection {
  disableImplicitSkills: boolean;
  explicitSkillPaths: string[];
  projectAssembly: PiProjectResourceAssemblySnapshot;
}

/**
 * 伙伴自己沉淀的技能路径。
 *
 * 它们不走 allowlist —— 那份名单管的是「用户允许这个伙伴保留哪些 harness 发现到的
 * Skill」,而这些是伙伴自己写进 Cindy 自有存储的文件,恒挂载。放在最前面:先是
 * 「我自己的本事」,再是用户给的,最后才是项目里的。
 */
function ownSkillPaths(policy: BotRuntimeSkillPolicy | undefined): string[] {
  return (policy?.ownSkills ?? [])
    .map((item) => item.path?.trim())
    .filter((skillPath): skillPath is string => !!skillPath);
}

export function applyPiBotSkillPolicy(
  policy: BotRuntimeSkillPolicy | undefined,
  assembly: PiProjectResourceAssemblySnapshot,
): PiBotSkillSelection {
  const own = ownSkillPaths(policy);
  if (!policy || policy.mode === 'inherit') {
    return {
      disableImplicitSkills: false,
      explicitSkillPaths: [...new Set([...own, ...assembly.launchSkillPaths])],
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
    explicitSkillPaths: [
      ...new Set([...own, ...userSkillPaths, ...projectAssembly.launchSkillPaths]),
    ],
    projectAssembly,
  };
}
