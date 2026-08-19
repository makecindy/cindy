/**
 * 伙伴真技能存储的单测。全部跑在 os.tmpdir() 的独立目录上,不碰真 userData
 * (credentials-and-local-storage.md「测试生成物」)。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOT_SKILL_MAX_BODY_BYTES,
  BOT_SKILL_MAX_COUNT,
  BotSkillStoreError,
  botSkillRootDir,
  botSkillsDir,
  deleteBotSkill,
  listBotSkills,
  normalizeBotSkillSlug,
  parseBotSkillFile,
  readBotSkill,
  renderBotSkillFile,
  saveBotSkill,
} from '../botSkillStore';

let userDataDir = '';

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-skills-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

const SAMPLE = {
  name: 'weekly-report',
  description: 'How I put together the weekly report',
  body: '1. Pull the merged PRs\n2. Group by author\n3. Write it in plain language',
};

describe('normalizeBotSkillSlug', () => {
  it('turns a human name into a directory-safe slug', () => {
    expect(normalizeBotSkillSlug('Weekly Report Shape')).toBe('weekly-report-shape');
    expect(normalizeBotSkillSlug('  PR review__flow  ')).toBe('pr-review-flow');
  });

  it('refuses a name that leaves nothing usable instead of inventing one', () => {
    // 造一个用户在设置页认不出来的随机名比拒绝更糟 —— 调用方要么换名要么给显式 slug。
    expect(normalizeBotSkillSlug('周报怎么写')).toBeNull();
    expect(normalizeBotSkillSlug('---')).toBeNull();
    expect(normalizeBotSkillSlug('')).toBeNull();
  });
});

describe('SKILL.md frontmatter', () => {
  it('round-trips name / description / updatedAt / body', () => {
    const source = renderBotSkillFile({
      name: 'a "quoted" name',
      description: 'line one\nline two',
      updatedAt: '2026-08-19T00:00:00.000Z',
      body: 'do the thing',
    });
    const parsed = parseBotSkillFile(source);
    expect(parsed.name).toBe('a "quoted" name');
    // 换行被压成空格:frontmatter 的 description 是单行 hook。
    expect(parsed.description).toBe('line one line two');
    expect(parsed.updatedAt).toBe('2026-08-19T00:00:00.000Z');
    expect(parsed.body).toBe('do the thing');
  });

  it('still yields a body for a hand-written file without frontmatter', () => {
    const parsed = parseBotSkillFile('just some steps\n');
    expect(parsed.name).toBe('');
    expect(parsed.body).toBe('just some steps');
  });
});

describe('saveBotSkill — 形成', () => {
  it('writes a real SKILL.md under the per-bot skills dir', async () => {
    const { record, created } = await saveBotSkill(userDataDir, 'bot-1', SAMPLE);

    expect(created).toBe(true);
    expect(record.slug).toBe('weekly-report');
    expect(record.dirPath).toBe(path.join(botSkillsDir(userDataDir, 'bot-1'), 'weekly-report'));
    const onDisk = await fs.readFile(record.filePath, 'utf8');
    expect(onDisk).toContain('name: "weekly-report"');
    expect(onDisk).toContain('Pull the merged PRs');
  });

  it('lays the root out as a Claude Code local plugin so CC can mount it', async () => {
    await saveBotSkill(userDataDir, 'bot-1', SAMPLE);

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(botSkillRootDir(userDataDir, 'bot-1'), '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as { name: string };
    expect(manifest.name).toBe('cindy-bot-bot-1');
  });

  it('updates in place on the same slug and refreshes updatedAt', async () => {
    const first = await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, now: 1_700_000_000_000 });
    const second = await saveBotSkill(userDataDir, 'bot-1', {
      ...SAMPLE,
      body: 'now with a step 4',
      now: 1_800_000_000_000,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.updatedAt).not.toBe(first.record.updatedAt);
    expect((await listBotSkills(userDataDir, 'bot-1')).length).toBe(1);
    expect((await readBotSkill(userDataDir, 'bot-1', 'weekly-report'))?.body).toBe(
      'now with a step 4',
    );
  });

  it('rejects an empty field, an oversize body and an unusable name', async () => {
    await expect(saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, body: '  ' })).rejects.toThrow(
      BotSkillStoreError,
    );
    await expect(
      saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, body: 'x'.repeat(BOT_SKILL_MAX_BODY_BYTES + 1) }),
    ).rejects.toMatchObject({ errorCode: 'SKILL_BODY_TOO_LARGE' });
    await expect(
      saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: '周报怎么写' }),
    ).rejects.toMatchObject({ errorCode: 'SKILL_NAME_UNUSABLE' });
  });

  it('caps how many skills one Bot can accumulate', async () => {
    for (let index = 0; index < BOT_SKILL_MAX_COUNT; index += 1) {
      await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: `skill-${index}` });
    }
    await expect(
      saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: 'one-too-many' }),
    ).rejects.toMatchObject({ errorCode: 'SKILL_LIMIT_REACHED' });
  });

  it('never lets a slug escape the per-bot skills dir', async () => {
    // 写入侧:slug 先过规范化,`../` 里的分隔符压根活不下来。
    const { record } = await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, slug: '../../evil' });
    expect(record.slug).toBe('evil');
    expect(record.dirPath).toBe(path.join(botSkillsDir(userDataDir, 'bot-1'), 'evil'));
    // 读 / 删侧收的是已存在的 slug(不再规范化),由 resolveSkillDir 挡住穿越。
    await expect(readBotSkill(userDataDir, 'bot-1', '../../../etc')).rejects.toBeInstanceOf(
      BotSkillStoreError,
    );
    await expect(deleteBotSkill(userDataDir, 'bot-1', '..')).rejects.toBeInstanceOf(
      BotSkillStoreError,
    );
    await expect(
      deleteBotSkill(userDataDir, 'bot-1', path.join('nested', 'deep')),
    ).rejects.toBeInstanceOf(BotSkillStoreError);
  });
});

describe('listBotSkills / deleteBotSkill — 取与删', () => {
  it('returns an empty list before the Bot ever learned anything', async () => {
    expect(await listBotSkills(userDataDir, 'bot-1')).toEqual([]);
  });

  it('lists metadata without reading bodies, sorted by name', async () => {
    await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: 'zeta-flow' });
    await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: 'alpha-flow' });

    const skills = await listBotSkills(userDataDir, 'bot-1');
    expect(skills.map((item) => item.name)).toEqual(['alpha-flow', 'zeta-flow']);
    expect(skills[0]).not.toHaveProperty('body');
    expect(skills[0].description).toBe(SAMPLE.description);
  });

  it('deletes one skill and reports a repeated delete as a no-op', async () => {
    await saveBotSkill(userDataDir, 'bot-1', SAMPLE);

    expect(await deleteBotSkill(userDataDir, 'bot-1', 'weekly-report')).toBe(true);
    expect(await deleteBotSkill(userDataDir, 'bot-1', 'weekly-report')).toBe(false);
    expect(await listBotSkills(userDataDir, 'bot-1')).toEqual([]);
  });
});

describe('隔离 — 一个伙伴的技能不进另一个伙伴的目录', () => {
  it('keeps each Bot inside its own directory', async () => {
    await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: 'mine' });
    await saveBotSkill(userDataDir, 'bot-2', { ...SAMPLE, name: 'theirs' });

    expect((await listBotSkills(userDataDir, 'bot-1')).map((item) => item.name)).toEqual(['mine']);
    expect((await listBotSkills(userDataDir, 'bot-2')).map((item) => item.name)).toEqual(['theirs']);
    expect(botSkillRootDir(userDataDir, 'bot-1')).not.toBe(botSkillRootDir(userDataDir, 'bot-2'));
  });

  it('sanitises a botId that would otherwise walk out of bot-skills/', async () => {
    const root = botSkillRootDir(userDataDir, '../escape');
    expect(path.relative(path.join(userDataDir, 'bot-skills'), root)).toBe('-escape');
  });
});
