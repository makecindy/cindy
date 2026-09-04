import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteBotSkill, readBotSkill, saveBotSkill } from '../botSkillStore';
import { seedBotTemplateSkills } from '../botTemplateSkillSeed';

let userDataDir = '';

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-template-skills-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('seedBotTemplateSkills', () => {
  it.each([
    ['cindy', 'everyday-work-coordination', '日常工作推进'],
    ['dash', 'executive-decision-review', '决策与审批'],
    ['lizi', 'technical-delivery', '技术问题交付'],
  ] as const)(
    'installs the %s preset as a real Bot-owned Skill',
    async (templateId, slug, name) => {
    const result = await seedBotTemplateSkills(userDataDir, `bot-${templateId}`, templateId);

    expect(result.completedNow).toBe(true);
    expect(result.skills[0]?.created).toBe(true);
      expect(await readBotSkill(userDataDir, `bot-${templateId}`, slug)).toMatchObject({
        name,
        body: expect.stringContaining('文档能力'),
      });
    },
  );

  it('does not restore bundled text over a Skill the user has changed', async () => {
    await saveBotSkill(userDataDir, 'bot-lizi', {
      name: '技术问题交付',
      description: '用户自己的技术流程。',
      body: '先读我的团队约定。',
      slug: 'technical-delivery',
    });

    const result = await seedBotTemplateSkills(userDataDir, 'bot-lizi', 'lizi');
    expect(result.skills[0]?.created).toBe(false);
    expect((await readBotSkill(userDataDir, 'bot-lizi', 'technical-delivery'))?.body).toBe(
      '先读我的团队约定。',
    );
  });

  it('does not reinstall a bundled Skill the user deletes after setup completed', async () => {
    await seedBotTemplateSkills(userDataDir, 'bot-dash', 'dash');
    await deleteBotSkill(userDataDir, 'bot-dash', 'executive-decision-review');

    expect(await seedBotTemplateSkills(userDataDir, 'bot-dash', 'dash')).toEqual({
      completedNow: false,
      skills: [],
    });
    expect(await readBotSkill(userDataDir, 'bot-dash', 'executive-decision-review')).toBeNull();
  });
});
