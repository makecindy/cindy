import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { botSkillRootDir, deleteBotSkill, readBotSkill, saveBotSkill } from '../botSkillStore';
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
    ['cindy', 'prepare-office-deliverables', '办公成果制作'],
    ['dash', 'make-executive-decisions', '高管决策'],
    ['lizi', 'deliver-engineering-changes', '开发交付'],
  ] as const)(
    'installs the %s preset as a real Bot-owned Skill',
    async (templateId, slug, name) => {
      const result = await seedBotTemplateSkills(userDataDir, `bot-${templateId}`, templateId);

      expect(result.completedNow).toBe(true);
      expect(result.skills).toHaveLength(3);
      expect(result.skills[0]?.created).toBe(true);
      expect(await readBotSkill(userDataDir, `bot-${templateId}`, slug)).toMatchObject({
        name,
        description: expect.any(String),
        body: expect.stringContaining(`# ${name}`),
      });
      expect(result.skills.some(({ record }) => record.body.includes('文档工具'))).toBe(true);
    },
  );

  it('does not restore bundled text over a Skill the user has changed', async () => {
    await saveBotSkill(userDataDir, 'bot-lizi', {
      name: '开发交付',
      description: '用户自己的技术流程。',
      body: '先读我的团队约定。',
      slug: 'deliver-engineering-changes',
    });

    const result = await seedBotTemplateSkills(userDataDir, 'bot-lizi', 'lizi');
    expect(result.skills[0]?.created).toBe(false);
    expect((await readBotSkill(userDataDir, 'bot-lizi', 'deliver-engineering-changes'))?.body).toBe(
      '先读我的团队约定。',
    );
  });

  it('does not reinstall a bundled Skill the user deletes after setup completed', async () => {
    await seedBotTemplateSkills(userDataDir, 'bot-dash', 'dash');
    await deleteBotSkill(userDataDir, 'bot-dash', 'make-executive-decisions');

    expect(await seedBotTemplateSkills(userDataDir, 'bot-dash', 'dash')).toEqual({
      completedNow: false,
      skills: [],
    });
    expect(await readBotSkill(userDataDir, 'bot-dash', 'make-executive-decisions')).toBeNull();
  });

  it('adds newly bundled Skills without restoring a legacy Skill the user deleted', async () => {
    const root = botSkillRootDir(userDataDir, 'bot-cindy');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.template-skills-cindy.seeded'), 'cindy\n');

    const result = await seedBotTemplateSkills(userDataDir, 'bot-cindy', 'cindy');

    expect(result.skills).toHaveLength(3);
    expect(await readBotSkill(userDataDir, 'bot-cindy', 'everyday-work-coordination')).toBeNull();
    expect(
      await readBotSkill(userDataDir, 'bot-cindy', 'prepare-office-deliverables'),
    ).not.toBeNull();
  });
});
