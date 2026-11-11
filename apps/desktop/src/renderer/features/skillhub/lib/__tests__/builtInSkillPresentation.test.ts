import { describe, expect, it } from 'vitest';

import { CINDY_LEARN_SOURCE_DESCRIPTION } from '../../../../../shared/cindyBuiltInSkills';
import { builtInSkillDescriptionKey, prioritizeCindyBuiltInSkills } from '../builtInSkillPresentation';

describe('prioritizeCindyBuiltInSkills', () => {
  it('puts Cindy official Skills first in their product order and keeps user order stable', () => {
    const userLearn = { name: 'learn', description: 'My workflow', scope: 'global' };
    const localA = { name: 'local-a', description: 'A', scope: 'global' };
    const builtInLearn = {
      name: 'learn',
      description: CINDY_LEARN_SOURCE_DESCRIPTION,
      builtIn: true,
      scope: 'global',
    };
    const localB = { name: 'local-b', description: 'B', scope: 'global' };
    const builtInCreator = {
      name: 'cindy-skill-creator',
      builtIn: true,
      scope: 'global',
    };
    const builtInPluginCreator = { name: 'cindy-plugin-creator', builtIn: true, scope: 'global' };
    const userPluginCreator = { name: 'cindy-plugin-creator', scope: 'global' };

    expect(prioritizeCindyBuiltInSkills([
      userLearn,
      localA,
      builtInPluginCreator,
      userPluginCreator,
      builtInLearn,
      localB,
      builtInCreator,
    ])).toEqual([
      builtInCreator,
      builtInLearn,
      builtInPluginCreator,
      userLearn,
      localA,
      userPluginCreator,
      localB,
    ]);
    expect(builtInSkillDescriptionKey(builtInPluginCreator)).toBe('skillhub.builtIn.pluginCreator.description');
    expect(builtInSkillDescriptionKey(userPluginCreator)).toBeUndefined();
  });
});
