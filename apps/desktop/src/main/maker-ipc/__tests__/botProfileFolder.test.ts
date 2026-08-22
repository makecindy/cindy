/**
 * 伙伴的家 —— 摊开在磁盘上的档案。
 *
 * 这一组盯住三件事:**别覆盖用户改过的文件**、**别把半截文件留在盘上**、
 * **搬家不能弄丢技能**。前两条是数据安全,第三条是「一个伙伴一个家」这次改动
 * 唯一有丢东西风险的地方。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOT_PROFILE_TEXT_MAX_BYTES,
  BotProfileFolderError,
  botProfileDir,
  migrateBotProfileFolder,
  readBotProfileFolder,
  removeBotProfileFolder,
  writeBotProfileFolder,
} from '../botProfileFolder';

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-profile-folder-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SEED = {
  identitySource: '你是纸老虎，一个爱做菜的厨子。',
  userContextSource: 'Chris 住在上海。',
  config: { model: 'claude-sonnet-4-6', harness: 'claude' },
};

describe('伙伴的家', () => {
  it('读一个还不存在的家:全是空值,不抛', async () => {
    const content = await readBotProfileFolder(root, 'bot-a');
    expect(content).toEqual({
      identitySource: '',
      userContextSource: '',
      systemPromptOverride: '',
      config: {},
      todo: [],
      knowledge: [],
      preferences: [],
    });
  });

  it('写进去的东西按 Hermes 同一套路径落盘,读回来一致', async () => {
    await writeBotProfileFolder(root, 'bot-a', {
      identitySource: SEED.identitySource,
      userContextSource: SEED.userContextSource,
      systemPromptOverride: '整段覆盖',
      config: SEED.config,
      todo: [{ text: '买菜' }],
    });
    const home = botProfileDir(root, 'bot-a');
    // 路径与 Hermes 对齐 —— 用户拿编辑器打开时看到的是同一套名字。
    expect(await fs.readFile(path.join(home, 'SOUL.md'), 'utf8')).toBe(SEED.identitySource);
    expect(await fs.readFile(path.join(home, 'memories', 'USER.md'), 'utf8')).toBe(
      SEED.userContextSource,
    );

    const content = await readBotProfileFolder(root, 'bot-a');
    expect(content.identitySource).toBe(SEED.identitySource);
    expect(content.userContextSource).toBe(SEED.userContextSource);
    expect(content.systemPromptOverride).toBe('整段覆盖');
    expect(content.config).toEqual(SEED.config);
    expect(content.todo).toEqual([{ text: '买菜' }]);
  });

  it('只写传进来的那几项,没传的原样不动', async () => {
    await writeBotProfileFolder(root, 'bot-a', { identitySource: '一', config: { a: 1 } });
    await writeBotProfileFolder(root, 'bot-a', { identitySource: '二' });
    const content = await readBotProfileFolder(root, 'bot-a');
    expect(content.identitySource).toBe('二');
    expect(content.config).toEqual({ a: 1 });
  });

  it('config.json 被手改坏了也不卡死伙伴,回落到空', async () => {
    await writeBotProfileFolder(root, 'bot-a', { identitySource: '在' });
    await fs.writeFile(path.join(botProfileDir(root, 'bot-a'), 'config.json'), '{ 坏掉的', 'utf8');
    const content = await readBotProfileFolder(root, 'bot-a');
    expect(content.config).toEqual({});
    // 灵魂还在 —— 一个坏文件只影响它自己。
    expect(content.identitySource).toBe('在');
  });

  it('知识与偏好只认 .md,按名字排序', async () => {
    const home = botProfileDir(root, 'bot-a');
    await fs.mkdir(path.join(home, 'knowledge'), { recursive: true });
    await fs.writeFile(path.join(home, 'knowledge', 'b.md'), '', 'utf8');
    await fs.writeFile(path.join(home, 'knowledge', 'a.md'), '', 'utf8');
    await fs.writeFile(path.join(home, 'knowledge', 'notes.txt'), '', 'utf8');
    expect((await readBotProfileFolder(root, 'bot-a')).knowledge).toEqual(['a.md', 'b.md']);
  });

  it('写完不留临时文件 —— 断电只会是旧的或新的,不会是半截', async () => {
    await writeBotProfileFolder(root, 'bot-a', { identitySource: SEED.identitySource });
    const entries = await fs.readdir(botProfileDir(root, 'bot-a'));
    expect(entries.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('超过上限的正文写不进去:伙伴可以自己写,但不能把磁盘写满', async () => {
    await expect(
      writeBotProfileFolder(root, 'bot-a', {
        identitySource: 'x'.repeat(BOT_PROFILE_TEXT_MAX_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(BotProfileFolderError);
  });

  it('botId 不能带路径穿越', async () => {
    await expect(readBotProfileFolder(root, '../../etc')).resolves.toBeTruthy();
    // 净化之后仍落在 bots/ 下面,没跑出去。
    expect(botProfileDir(root, '../../etc').startsWith(path.join(root, 'bots'))).toBe(true);
  });

  it('删除伙伴时整个家一起走,不存在也不抛', async () => {
    await writeBotProfileFolder(root, 'bot-a', { identitySource: '在' });
    await removeBotProfileFolder(root, 'bot-a');
    expect((await readBotProfileFolder(root, 'bot-a')).identitySource).toBe('');
    await expect(removeBotProfileFolder(root, 'bot-a')).resolves.toBeUndefined();
  });
});

describe('搬家', () => {
  it('第一次迁移用数据库里的当前值播种', async () => {
    const result = await migrateBotProfileFolder(root, 'bot-a', SEED);
    expect(result.seeded).toBe(true);
    const content = await readBotProfileFolder(root, 'bot-a');
    expect(content.identitySource).toBe(SEED.identitySource);
    expect(content.userContextSource).toBe(SEED.userContextSource);
    expect(content.config).toEqual(SEED.config);
  });

  it('已经有家了就整个跳过,绝不覆盖用户改过的灵魂', async () => {
    await writeBotProfileFolder(root, 'bot-a', { identitySource: '用户自己改过的' });
    const result = await migrateBotProfileFolder(root, 'bot-a', SEED);
    expect(result.seeded).toBe(false);
    expect((await readBotProfileFolder(root, 'bot-a')).identitySource).toBe('用户自己改过的');
  });

  it('技能从旧目录整体搬进新家,内容与 slug 都不变', async () => {
    const legacy = path.join(root, 'bot-skills', 'bot-a');
    await fs.mkdir(path.join(legacy, 'skills', 'weekly-report'), { recursive: true });
    await fs.writeFile(
      path.join(legacy, 'skills', 'weekly-report', 'SKILL.md'),
      '# 周报怎么写',
      'utf8',
    );
    await fs.mkdir(path.join(legacy, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(legacy, '.claude-plugin', 'plugin.json'),
      '{"name":"bot-a"}',
      'utf8',
    );

    const result = await migrateBotProfileFolder(root, 'bot-a', SEED);
    expect(result.skillsMoved).toBe(true);

    const home = botProfileDir(root, 'bot-a');
    expect(
      await fs.readFile(path.join(home, 'skills', 'weekly-report', 'SKILL.md'), 'utf8'),
    ).toBe('# 周报怎么写');
    // plugin 清单跟着走,否则 Claude Code 挂不起这个本地 plugin。
    expect(await fs.readFile(path.join(home, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
      '{"name":"bot-a"}',
    );
    // 旧目录清干净,不留半份。
    await expect(fs.access(legacy)).rejects.toBeTruthy();
  });

  it('重复迁移不动已经搬好的技能', async () => {
    const legacy = path.join(root, 'bot-skills', 'bot-a');
    await fs.mkdir(path.join(legacy, 'skills', 's1'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'skills', 's1', 'SKILL.md'), 'v1', 'utf8');
    await migrateBotProfileFolder(root, 'bot-a', SEED);

    // 搬完之后用户又改了技能正文;再迁一次不能把它冲掉。
    const home = botProfileDir(root, 'bot-a');
    await fs.writeFile(path.join(home, 'skills', 's1', 'SKILL.md'), 'v2', 'utf8');
    const again = await migrateBotProfileFolder(root, 'bot-a', SEED);
    expect(again.seeded).toBe(false);
    expect(again.skillsMoved).toBe(false);
    expect(await fs.readFile(path.join(home, 'skills', 's1', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('没有旧技能目录时安静跳过 —— 新伙伴的常态', async () => {
    const result = await migrateBotProfileFolder(root, 'bot-a', SEED);
    expect(result).toEqual({ seeded: true, skillsMoved: false });
  });
});
