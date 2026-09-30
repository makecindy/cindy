import {
  CINDY_LEARN_NAME,
  CINDY_SKILL_CREATOR_NAME,
  isCindyBuiltInSkillMetadata,
} from '../../../../shared/cindyBuiltInSkills';

export const SKILL_CREATOR_DESCRIPTION_KEY = 'skillhub.builtIn.skillCreator.description' as const;
export const LEARN_DESCRIPTION_KEY = 'skillhub.builtIn.learn.description' as const;

const BUILT_IN_SKILL_ORDER = new Map([
  [CINDY_SKILL_CREATOR_NAME, 0],
  [CINDY_LEARN_NAME, 1],
]);

/**
 * Built-in Skills keep their canonical metadata in English for agents. Cindy
 * substitutes localized copy only when it renders a known built-in entry.
 */
export function builtInSkillDescriptionKey(
  skill: {
    builtIn?: boolean;
    name: string;
    description?: string;
    scope?: string;
  },
): typeof SKILL_CREATOR_DESCRIPTION_KEY | typeof LEARN_DESCRIPTION_KEY | undefined {
  if (!isCindyBuiltInSkillMetadata(skill)) return undefined;
  if (skill.name === CINDY_SKILL_CREATOR_NAME) return SKILL_CREATOR_DESCRIPTION_KEY;
  if (skill.name === CINDY_LEARN_NAME) return LEARN_DESCRIPTION_KEY;
  return undefined;
}

/** Put Cindy's official Skills first while preserving the existing order of user Skills. */
export function prioritizeCindyBuiltInSkills<Skill extends {
  builtIn?: boolean;
  name: string;
  description?: string;
  scope?: string;
}>(skills: ReadonlyArray<Skill>): Skill[] {
  return skills
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) => {
      const leftPriority = isCindyBuiltInSkillMetadata(left.skill)
        ? BUILT_IN_SKILL_ORDER.get(left.skill.name) ?? BUILT_IN_SKILL_ORDER.size
        : Number.POSITIVE_INFINITY;
      const rightPriority = isCindyBuiltInSkillMetadata(right.skill)
        ? BUILT_IN_SKILL_ORDER.get(right.skill.name) ?? BUILT_IN_SKILL_ORDER.size
        : Number.POSITIVE_INFINITY;
      if (leftPriority !== rightPriority) return leftPriority < rightPriority ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ skill }) => skill);
}
