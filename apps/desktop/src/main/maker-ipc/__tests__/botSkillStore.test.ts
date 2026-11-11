/**
 * 伙伴真技能存储的单测。全部跑在 os.tmpdir() 的独立目录上,不碰真 userData
 * (credentials-and-local-storage.md「测试生成物」)。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBotSkillFiles,
  listBotSkillFiles,
  BOT_SKILL_MAX_BODY_BYTES,
  BotSkillStoreError,
  botSkillRootDir,
  botSkillsDir,
  deleteBotSkill,
  listBotSkills,
  importBotSkillFiles,
  normalizeBotSkillSlug,
  parseBotSkillFile,
  patchCustomBotSkillSource,
  readBotSkill,
  readBotSkillSource,
  listBotSkillSources,
  renderBotSkillFile,
  saveBotSkill,
  saveBotSkillSource,
  seedBotSkillIfMissing,
  setBotSkillEnabled,
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
      slug: 'quoted-name',
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
    expect(source).toContain('name: "quoted-name"');
    expect(source).toContain('metadata:');
    expect(source).not.toContain('\nupdatedAt:');
  });

  it('migrates Cindy\'s legacy top-level metadata without changing the body', async () => {
    const skillDir = path.join(botSkillsDir(userDataDir, 'bot-1'), 'weekly-report');
    await fs.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(
      filePath,
      [
        '---',
        'name: "周报"',
        'description: "整理本周进展时使用。"',
        'updatedAt: "2026-08-19T00:00:00.000Z"',
        '---',
        '',
        '# 用户改过的正文',
        '',
      ].join('\n'),
    );

    const record = await readBotSkill(userDataDir, 'bot-1', 'weekly-report');

    expect(record).toMatchObject({ name: '周报', body: '# 用户改过的正文' });
    const migrated = await fs.readFile(filePath, 'utf8');
    expect(migrated).toContain('name: "weekly-report"');
    expect(migrated).toContain('displayName: "周报"');
    expect(migrated).not.toContain('\nupdatedAt:');
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
      saveBotSkill(userDataDir, 'bot-1', {
        ...SAMPLE,
        body: 'x'.repeat(BOT_SKILL_MAX_BODY_BYTES + 1),
      }),
    ).rejects.toMatchObject({ errorCode: 'SKILL_BODY_TOO_LARGE' });
    await expect(
      saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, name: '周报怎么写' }),
    ).rejects.toMatchObject({ errorCode: 'SKILL_NAME_UNUSABLE' });
  });

  it('preserves more than 142 skills and allows continued learning', async () => {
    // Capture this test's directory so a timed-out continuation cannot use a later fixture.
    const testUserDataDir = userDataDir;
    // Seed existing files directly: saving each one repeatedly scans the growing directory.
    for (let index = 0; index < 142 - 1; index += 1) {
      const slug = `skill-${index}`;
      const skillDir = path.join(botSkillsDir(testUserDataDir, 'bot-1'), slug);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), renderBotSkillFile({
        ...SAMPLE,
        slug,
        name: slug,
        updatedAt: '2026-08-19T00:00:00.000Z',
      }));
    }
    const lastSkill = { ...SAMPLE, name: `skill-${142 - 1}` };
    expect((await saveBotSkill(testUserDataDir, 'bot-1', lastSkill)).created).toBe(true);
    await expect(
      saveBotSkill(testUserDataDir, 'bot-1', { ...SAMPLE, name: 'one-too-many' }),
    ).resolves.toMatchObject({ created: true });
    expect((await saveBotSkill(testUserDataDir, 'bot-1', lastSkill)).created).toBe(false);
    expect(await listBotSkills(testUserDataDir, 'bot-1')).toHaveLength(143);
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

describe('seedBotSkillIfMissing — 内置模板安装', () => {
  const seed = {
    name: '决策与审批',
    description: '处理重要工作审批时使用。',
    body: '先给结论，再写理由、风险和下一步。',
    slug: 'executive-decision-review',
    now: 1_700_000_000_000,
  };

  it('writes a real skill once and preserves later user edits', async () => {
    const first = await seedBotSkillIfMissing(userDataDir, 'bot-dash', seed);
    expect(first.created).toBe(true);

    await saveBotSkill(userDataDir, 'bot-dash', {
      ...seed,
      body: '这是用户改过的审批方法。',
      now: 1_800_000_000_000,
    });
    const second = await seedBotSkillIfMissing(userDataDir, 'bot-dash', {
      ...seed,
      body: '新版内置内容也不应覆盖用户。',
    });

    expect(second.created).toBe(false);
    expect(second.record.body).toBe('这是用户改过的审批方法。');
  });

  it('is atomic when two creation paths seed the same skill together', async () => {
    const results = await Promise.all([
      seedBotSkillIfMissing(userDataDir, 'bot-dash', seed),
      seedBotSkillIfMissing(userDataDir, 'bot-dash', seed),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await readBotSkill(userDataDir, 'bot-dash', seed.slug)).toMatchObject({
      name: seed.name,
      body: seed.body,
    });
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
    expect((await listBotSkills(userDataDir, 'bot-2')).map((item) => item.name)).toEqual([
      'theirs',
    ]);
    expect(botSkillRootDir(userDataDir, 'bot-1')).not.toBe(botSkillRootDir(userDataDir, 'bot-2'));
  });

  it('sanitises a botId that would otherwise walk out of the bot home', async () => {
    const root = botSkillRootDir(userDataDir, '../escape');
    expect(path.relative(path.join(userDataDir, 'bots'), root)).toBe('-escape');
  });
});

it('imports real skill resources and preserves a user edit when the import is retried', async () => {
  const files = [
    { name: 'SKILL.md', bytes: Buffer.from('---\nname: imported\ndescription: A source skill\n---\nRun scripts/report.sh'), executable: false },
    { name: 'scripts/report.sh', bytes: Buffer.from('#!/bin/sh\ncat ../templates/report.txt'), executable: true },
    { name: 'templates/report.txt', bytes: Buffer.from('Source template'), executable: false },
  ];
  await importBotSkillFiles(userDataDir, 'bot-1', 'imported', files, () => {});
  await importBotSkillFiles(userDataDir, 'bot-1', 'imported', files, () => {});
  expect((await listBotSkills(userDataDir, 'bot-1')).map(row => row.slug)).toEqual(['imported']);
  const folder = path.join(botSkillsDir(userDataDir, 'bot-1'), 'imported');
  expect(await fs.readFile(path.join(folder, 'scripts/report.sh'))).toEqual(files[1]!.bytes);
  if (process.platform !== 'win32') expect((await fs.stat(path.join(folder, 'scripts/report.sh'))).mode & 0o100).toBe(0o100);
  await fs.writeFile(path.join(folder, 'templates/report.txt'), 'User changed it');
  await expect(importBotSkillFiles(userDataDir, 'bot-1', 'imported', files, () => {})).rejects.toThrow('Imported skill was edited');
  expect(await fs.readFile(path.join(folder, 'templates/report.txt'), 'utf8')).toBe('User changed it');
});

it('retains a disabled imported skill without mounting or re-enabling it when edited', async () => {
  await importBotSkillFiles(userDataDir, 'bot-1', 'disabled', [{ name: 'SKILL.md', bytes: Buffer.from('# Original'), executable: false }], () => {}, false);
  expect(await listBotSkills(userDataDir, 'bot-1', false)).toEqual([]);
  expect(await listBotSkills(userDataDir, 'bot-1')).toMatchObject([{ slug: 'disabled', enabled: false }]);
  const updated = await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, slug: 'disabled' });
  expect(updated.record.enabled).toBe(false);
  expect(await listBotSkills(userDataDir, 'bot-1', false)).toEqual([]);
  expect(await deleteBotSkill(userDataDir, 'bot-1', 'disabled')).toBe(true);
  expect(await listBotSkills(userDataDir, 'bot-1')).toEqual([]);
});

it.each([false, true])('preserves the other skill when an import collides across enabled stores (%s)', async enabled => {
  const files = [{ name: 'SKILL.md', bytes: Buffer.from('# Existing'), executable: false }];
  await importBotSkillFiles(userDataDir, 'bot-1', 'report', files, () => {}, enabled);
  await expect(importBotSkillFiles(userDataDir, 'bot-1', 'report', [{ ...files[0]!, bytes: Buffer.from('# Different') }], () => {}, !enabled)).rejects.toThrow('conflicts with an existing skill');
  expect(await listBotSkills(userDataDir, 'bot-1')).toHaveLength(1);
  expect((await readBotSkill(userDataDir, 'bot-1', 'report'))?.body).toBe('# Existing');
});

it('deletes only the read/edit target if older data contains duplicate enabled and disabled slugs', async () => {
  await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, slug: 'report' });
  const disabled = path.join(botSkillRootDir(userDataDir, 'bot-1'), 'disabled-skills', 'report');
  await fs.mkdir(disabled, { recursive: true });
  await fs.writeFile(path.join(disabled, 'SKILL.md'), '# Retain disabled copy');
  expect(await deleteBotSkill(userDataDir, 'bot-1', 'report')).toBe(true);
  expect(await fs.readFile(path.join(disabled, 'SKILL.md'), 'utf8')).toBe('# Retain disabled copy');
  expect(await readBotSkill(userDataDir, 'bot-1', 'report')).toMatchObject({ enabled: false, body: '# Retain disabled copy' });
});

it('preserves native interpreter links across save/retry and rejects a changed alias', async ctx => {
  const runtime = path.join(userDataDir, 'runtime-python');
  await fs.writeFile(runtime, 'fixture-runtime');
  const probe = path.join(userDataDir, 'link-probe');
  try { await fs.symlink(runtime, probe, 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
  await fs.unlink(probe);
  const interpreterName = `.venv/${process.platform === 'win32' ? 'Scripts' : 'bin'}/python`;
  const files = [
    { name: 'SKILL.md', bytes: Buffer.from('# Imported'), executable: false },
    { name: interpreterName, bytes: Buffer.from('fixture-runtime'), executable: true, interpreterLink: runtime },
  ];
  await importBotSkillFiles(userDataDir, 'bot', 'native', files, () => {});
  const alias = path.join(botSkillsDir(userDataDir, 'bot'), 'native', interpreterName);
  expect(await fs.readlink(alias)).toBe(runtime);
  await importBotSkillFiles(userDataDir, 'bot', 'native', files, () => {});
  await fs.unlink(alias); await fs.symlink(path.join(userDataDir, 'other-python'), alias, 'file');
  await expect(importBotSkillFiles(userDataDir, 'bot', 'native', files, () => {})).rejects.toThrow('Imported interpreter was edited');
  expect(await fs.readFile(runtime, 'utf8')).toBe('fixture-runtime');
  await expect(importBotSkillFiles(userDataDir, 'bot', 'unsafe', [{ ...files[0]!, interpreterLink: runtime }], () => {})).rejects.toThrow('Invalid imported interpreter');
});


it('preserves a foreground edit when background learning uses an older snapshot', async () => {
  const initial = await saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, now: Date.parse('2026-09-01T00:00:00.000Z') });
  const results = await Promise.allSettled([
    saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, body: 'Human corrected workflow', now: Date.parse('2026-09-02T00:00:00.000Z') }),
    saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, body: 'Outdated background proposal', expectedUpdatedAt: initial.record.updatedAt }),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect((await readBotSkill(userDataDir, 'bot-1', 'weekly-report'))?.body).toBe('Human corrected workflow');
  await expect(saveBotSkill(userDataDir, 'bot-1', { ...SAMPLE, expectedUpdatedAt: null })).rejects.toThrow('Skill changed during review');
});

describe('verbatim SKILL.md (cloud companions)', () => {
  it('round-trips native frontmatter the settings model does not know', async () => {
    const source = '---\nname: brew\ndescription: Brew tea\nallowed-tools: Bash(git:*)\ndisable-model-invocation: true\nmetadata:\n  displayName: Brew\n---\n\nsteps\n';
    await saveBotSkillSource(userDataDir, 'bot_a', 'brew', source);
    expect(await readBotSkillSource(userDataDir, 'bot_a', 'brew')).toBe(source);
    expect((await readBotSkill(userDataDir, 'bot_a', 'brew'))?.body).toBe('steps');
    expect(await readBotSkillSource(userDataDir, 'bot_a', 'missing')).toBeNull();
    await expect(saveBotSkillSource(userDataDir, 'bot_a', '../x', source)).rejects.toBeInstanceOf(BotSkillStoreError);
    await expect(saveBotSkillSource(userDataDir, 'bot_a', 'big', `---\nname: big\n---\n${'x'.repeat(BOT_SKILL_MAX_BODY_BYTES + 1)}`))
      .rejects.toBeInstanceOf(BotSkillStoreError);
  });

  it('applies the requested enabled state, moving the whole skill folder', async () => {
    const source = '---\nname: brew\ndescription: Brew\n---\n\nsteps\n';
    await saveBotSkillSource(userDataDir, 'bot_c', 'brew', source);
    await fs.writeFile(path.join(botSkillsDir(userDataDir, 'bot_c'), 'brew', 'helper.sh'), 'echo hi');
    await saveBotSkillSource(userDataDir, 'bot_c', 'brew', source, { enabled: false });
    expect((await readBotSkill(userDataDir, 'bot_c', 'brew'))?.enabled).toBe(false);
    expect(await listBotSkillSources(userDataDir, 'bot_c')).toEqual([{ slug: 'brew', source, enabled: false }]);
    await saveBotSkillSource(userDataDir, 'bot_c', 'brew', source, { enabled: true });
    expect((await readBotSkill(userDataDir, 'bot_c', 'brew'))?.enabled).toBeUndefined();
    expect(await fs.readFile(path.join(botSkillsDir(userDataDir, 'bot_c'), 'brew', 'helper.sh'), 'utf8')).toBe('echo hi');
  });

  // The settings switch must not rewrite a skill or bring back one deleted while it was queued.
  it('turns a skill off and on by moving it, and refuses a skill that no longer exists', async () => {
    const source = '---\nname: brew\ndescription: Brew\nlicense: MIT\n---\n\nsteps\n';
    await saveBotSkillSource(userDataDir, 'bot_d', 'brew', source);
    await setBotSkillEnabled(userDataDir, 'bot_d', 'brew', false);
    expect(await listBotSkillSources(userDataDir, 'bot_d')).toEqual([{ slug: 'brew', source, enabled: false }]);
    await setBotSkillEnabled(userDataDir, 'bot_d', 'brew', true);
    expect(await listBotSkillSources(userDataDir, 'bot_d')).toEqual([{ slug: 'brew', source, enabled: true }]);
    await deleteBotSkill(userDataDir, 'bot_d', 'brew');
    await expect(setBotSkillEnabled(userDataDir, 'bot_d', 'brew', false)).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(await listBotSkillSources(userDataDir, 'bot_d')).toEqual([]);
  });

  // Editing an imported skill from settings must keep frontmatter Cindy does not write, and a
  // rename and the version stamp must stick so a second, stale editor cannot overwrite it.
  it('patches an imported skill in place and refuses a save based on an older read', async () => {
    const own = '---\nname: brew\ndescription: Old\nallowed-tools:\n  - Bash\nmetadata:\n  author: me\n---\n\nold steps\n';
    const edit = { name: 'Brew tea', description: 'New "tea"', body: 'new steps', updatedAt: '2026-11-01T00:00:00.000Z' };
    const patched = patchCustomBotSkillSource(own, edit)!;
    expect(patched).toBe('---\nname: brew\ndescription: "New \\"tea\\""\nallowed-tools:\n  - Bash\nmetadata:\n  author: me\n  displayName: "Brew tea"\n  updatedAt: "2026-11-01T00:00:00.000Z"\n---\n\nnew steps\n');
    expect(parseBotSkillFile(patched)).toMatchObject({ name: 'Brew tea', description: 'New "tea"', updatedAt: edit.updatedAt });
    expect(patchCustomBotSkillSource(renderBotSkillFile({ slug: 'brew', name: 'Brew', description: 'd', updatedAt: 'now', body: 'b' }),
      { ...edit, description: 'x', body: 'y' })).toBeNull();
    const block = '---\nname: brew\ndescription: >\n  Long\nlicense: MIT\n---\n\nsteps\n';
    expect(() => patchCustomBotSkillSource(block, { ...edit, description: 'Other' })).toThrow(BotSkillStoreError);

    await saveBotSkillSource(userDataDir, 'bot_e', 'brew', own);
    await saveBotSkillSource(userDataDir, 'bot_e', 'brew', patched, { expectedUpdatedAt: '' });
    // A second editor opened before the first save still holds the empty stamp.
    await expect(saveBotSkillSource(userDataDir, 'bot_e', 'brew', own, { expectedUpdatedAt: '' })).rejects.toThrow('Skill changed during review');
    expect(await readBotSkillSource(userDataDir, 'bot_e', 'brew')).toBe(patched);
  });
});

describe('strict skill reads (cloud companions)', () => {
  // chmod cannot make a file unreadable on Windows.
  it.skipIf(process.platform === 'win32')('lists every skill source, empty without a folder, and fails instead of hiding an unreadable one', async () => {
    expect(await listBotSkillSources(userDataDir, 'bot_b')).toEqual([]);
    const source = '---\nname: brew\ndescription: Brew\n---\n\nsteps\n';
    await saveBotSkillSource(userDataDir, 'bot_b', 'brew', source);
    expect(await listBotSkillSources(userDataDir, 'bot_b')).toEqual([{ slug: 'brew', source, enabled: true }]);
    const dir = botSkillsDir(userDataDir, 'bot_b');
    await fs.chmod(dir, 0o000);
    try {
      await expect(listBotSkillSources(userDataDir, 'bot_b')).rejects.toMatchObject({ code: 'EACCES' });
      await expect(readBotSkillSource(userDataDir, 'bot_b', 'brew')).rejects.toMatchObject({ code: 'EACCES' });
      // The settings list keeps its lenient behaviour.
      expect(await listBotSkills(userDataDir, 'bot_b')).toEqual([]);
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });
});

describe('skill files for cloud companions', () => {
  const skillDir = () => path.join(botSkillsDir(userDataDir, 'bot_a'), 'brew');
  const write = async (relative: string, content: string, mode = 0o644) => {
    const file = path.join(skillDir(), relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await fs.chmod(file, mode);
  };
  const source = async (content: string) => {
    const file = path.join(userDataDir, `download-${createHash('sha256').update(content).digest('hex')}`);
    await fs.writeFile(file, content);
    return file;
  };
  const sha = (content: string) => createHash('sha256').update(content).digest('hex');
  const entry = (relative: string, content: string, executable = false) =>
    ({ path: relative, size: content.length, sha256: sha(content), ...(executable ? { executable: true as const } : {}) });

  beforeEach(async () => { await saveBotSkillSource(userDataDir, 'bot_a', 'brew', '---\nname: "brew"\n---\n\nsteps\n'); });

  it('lists what belongs to the skill, leaving hidden files, dependencies and keys behind', async () => {
    await write('scripts/run.sh', '#!/bin/sh\n', 0o755);
    await write('references/a.md', 'a');
    await write('.env', 'TOKEN=1');
    await write('node_modules/x/index.js', 'x');
    await write('deploy.pem', 'secret');
    await write('Skill.MD', 'another spelling of the entry file');
    await fs.symlink('/etc/hosts', path.join(skillDir(), 'link'));
    const files = await listBotSkillFiles(userDataDir, 'bot_a', 'brew', true);
    expect(files.map(file => file.path)).toEqual(['references/a.md', 'scripts/run.sh']);
    expect(files[1]).toMatchObject({ sha256: sha('#!/bin/sh\n'), executable: true });
    expect(files[0]?.executable).toBeUndefined();
  });

  it('restores files with their executable bit and removes the ones the home no longer has', async () => {
    await write('old.md', 'old');
    await write('.env', 'TOKEN=1');
    const content = '#!/bin/sh\n';
    await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry('scripts/run.sh', content, true)], async () => source(content), { removeOthers: true });
    const restored = path.join(skillDir(), 'scripts/run.sh');
    expect(await fs.readFile(restored, 'utf8')).toBe(content);
    if (process.platform !== 'win32') expect((await fs.stat(restored)).mode & 0o111).not.toBe(0);
    await expect(fs.access(path.join(skillDir(), 'old.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(skillDir(), '.env'), 'utf8')).toBe('TOKEN=1');
    expect(await readBotSkillSource(userDataDir, 'bot_a', 'brew')).toContain('steps');
  });

  it('keeps the local copy when a file is gone for good, its bytes are wrong, or the list is incomplete', async () => {
    await write('a.md', 'local a');
    await write('b.md', 'local b');
    await write('c.md', 'local c');
    expect(await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry('a.md', 'cloud a'), entry('b.md', 'cloud b')],
      async file => (file.path === 'a.md' ? null : source('tampered')), { removeOthers: false })).toEqual(['a.md', 'b.md']);
    expect(await fs.readFile(path.join(skillDir(), 'a.md'), 'utf8')).toBe('local a');
    expect(await fs.readFile(path.join(skillDir(), 'b.md'), 'utf8')).toBe('local b');
    expect(await fs.readFile(path.join(skillDir(), 'c.md'), 'utf8')).toBe('local c');
  });

  it('creates an empty file without fetching it, and keeps what the list says exists elsewhere', async () => {
    await write('big.bin', 'never reached the cloud');
    await write('stale.md', 'removed at the home');
    const fetch = vi.fn(async () => null);
    await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry('pkg/__init__.py', '')], fetch, { removeOthers: true, keep: ['big.bin'] });
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(skillDir(), 'pkg/__init__.py'), 'utf8')).toBe('');
    expect(await fs.readFile(path.join(skillDir(), 'big.bin'), 'utf8')).toBe('never reached the cloud');
    await expect(fs.access(path.join(skillDir(), 'stale.md'))).rejects.toThrow();
  });

  it('replaces an empty folder with the file, and does not stall on one that holds something', async () => {
    await fs.mkdir(path.join(skillDir(), 'data'));
    await write('kept/.env', 'TOKEN=1');
    const fetch = async (file: { sha256: string }) => source(file.sha256 === sha('d') ? 'd' : 'k');
    expect(await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry('data', 'd'), entry('kept', 'k')], fetch, { removeOthers: true })).toEqual(['kept']);
    expect(await fs.readFile(path.join(skillDir(), 'data'), 'utf8')).toBe('d');
    expect(await fs.readFile(path.join(skillDir(), 'kept/.env'), 'utf8')).toBe('TOKEN=1');
  });

  it('restores a file whose name is as long as the disk allows', async () => {
    const name = `${'n'.repeat(250)}.md`;
    expect(await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry(name, '')], async () => null, { removeOthers: false })).toEqual([]);
    expect(await fs.readFile(path.join(skillDir(), name), 'utf8')).toBe('');
  });

  it('never writes outside the skill folder', async () => {
    const outside = await fs.mkdtemp(path.join(userDataDir, 'outside-'));
    await fs.symlink(outside, path.join(skillDir(), 'linked'));
    const fetch = async () => source('x');
    for (const unsafe of ['../escape.md', '/abs.md', 'a\\b.md', '.hidden/a.md', 'SKILL.md', 'Skill.MD', 'node_modules/a.js']) {
      await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry(unsafe, 'x')], fetch, { removeOthers: false });
    }
    expect(await applyBotSkillFiles(userDataDir, 'bot_a', 'brew', [entry('linked/a.md', 'x')], fetch, { removeOthers: false })).toEqual(['linked/a.md']);
    expect(await fs.readdir(outside)).toEqual([]);
    await expect(fs.access(path.join(botSkillsDir(userDataDir, 'bot_a'), 'escape.md'))).rejects.toThrow();
    expect(await readBotSkillSource(userDataDir, 'bot_a', 'brew')).toContain('steps');
  });
});
