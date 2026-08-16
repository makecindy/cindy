import { describe, expect, it } from 'vitest';

import {
  botProfileContentChanged,
  mergeBotProfileCapabilities,
} from '../botProfileVersioning';

describe('Bot Profile versioning', () => {
  it('creates a new version when only the SOUL identity changes', () => {
    expect(
      botProfileContentChanged({
        previousCapabilities: { skills: ['recipe'] },
        nextCapabilities: { skills: ['recipe'] },
        previousIdentitySource: 'A helpful cook',
        nextIdentitySource: 'A playful pastry chef',
      }),
    ).toBe(true);
  });

  it('does not create a version for metadata-only updates', () => {
    expect(
      botProfileContentChanged({
        previousCapabilities: { skills: ['recipe'] },
        nextCapabilities: { skills: ['recipe'] },
        previousIdentitySource: 'A helpful cook',
        nextIdentitySource: 'A helpful cook',
      }),
    ).toBe(false);
  });

  it('keeps capability updates and Skills from the same save', () => {
    expect(
      mergeBotProfileCapabilities({
        previous: { model: 'old-model', memory: true, skills: ['old-skill'] },
        capabilities: { model: 'new-model', memory: false },
        skills: [' new-skill ', 42, '', 'second-skill'],
        hasSkills: true,
      }),
    ).toEqual({
      model: 'new-model',
      memory: false,
      skills: ['new-skill', 'second-skill'],
    });
  });
});
