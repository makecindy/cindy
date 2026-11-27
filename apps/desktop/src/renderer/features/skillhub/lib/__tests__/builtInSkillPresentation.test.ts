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
    const builtInThemeCreator = { name: 'cindy-theme-creator', builtIn: true, scope: 'global' };
    const userThemeCreator = { name: 'cindy-theme-creator', scope: 'global' };

    expect(prioritizeCindyBuiltInSkills([
      userLearn,
      localA,
      builtInPluginCreator,
      builtInThemeCreator,
      userThemeCreator,
      userPluginCreator,
      builtInLearn,
      localB,
      builtInCreator,
    ])).toEqual([
      builtInCreator,
      builtInLearn,
      builtInPluginCreator,
      builtInThemeCreator,
      userLearn,
      localA,
      userThemeCreator,
      userPluginCreator,
      localB,
    ]);
    expect(builtInSkillDescriptionKey(builtInPluginCreator)).toBe('skillhub.builtIn.pluginCreator.description');
    expect(builtInSkillDescriptionKey(userPluginCreator)).toBeUndefined();
    expect(builtInSkillDescriptionKey(builtInThemeCreator)).toBe('skillhub.builtIn.themeCreator.description');
    expect(builtInSkillDescriptionKey(userThemeCreator)).toBeUndefined();
  });
});
