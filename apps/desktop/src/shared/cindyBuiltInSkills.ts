export const CINDY_SKILL_CREATOR_NAME = 'cindy-skill-creator';
export const CINDY_LEARN_NAME = 'learn';

export const CINDY_LEARN_SOURCE_DESCRIPTION =
  "Distill a reusable Cindy Skill from the current task, a described workflow, or a SkillHub skill through Cindy's review flow when the user directly invokes /learn or /skill:learn in Pi.";

const CINDY_BUILT_IN_NAMES = new Set([CINDY_SKILL_CREATOR_NAME, CINDY_LEARN_NAME]);

/** Identify Cindy-owned metadata without treating another vendor's Skill Creator as official. */
export function isCindyBuiltInSkillMetadata(skill: {
  builtIn?: boolean;
  name: string;
  description?: string;
  scope?: string;
}): boolean {
  return skill.builtIn === true && CINDY_BUILT_IN_NAMES.has(skill.name);
}
