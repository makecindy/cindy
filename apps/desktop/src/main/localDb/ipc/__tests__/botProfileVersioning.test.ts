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

/**
 * 性别与 userContextSource 同款,住在档案 JSON 里而不是自己一列。它必须能穿过
 * 每一次能力更新活下来 —— 否则用户在设置里动一下工具开关,阵容里那个「她」就
 * 悄悄变回按名字称呼(2026-08-21 实机发现渲染层传了性别、主进程根本没接)。
 */
describe('角色性别随档案存活', () => {
  it('更新能力时保留已有性别', () => {
    const next = mergeBotProfileCapabilities({
      previous: { gender: 'female', skills: ['contract'] },
      capabilities: { model: 'x', harness: 'claude' },
      hasSkills: false,
    });
    expect(next.gender).toBe('female');
  });

  it('只改技能同样保留', () => {
    const next = mergeBotProfileCapabilities({
      previous: { gender: 'male' },
      skills: ['a'],
      hasSkills: true,
    });
    expect(next.gender).toBe('male');
  });
});
