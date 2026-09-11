/**
 * 会话绑定层的单测:归属拒绝口径 + 「一个伙伴写的技能只落在自己名下」。
 *
 * 归属解析(`resolveBotId`)与 userData 根都由 deps 注入,所以这里不碰 localDb、
 * 不碰 Electron 真 userData —— 数据库那半由 botDurableNoteService 的同款判据覆盖。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectBotOwnSkillMounts,
  deleteBotSkillForBot,
  listBotSkillsForBot,
  listBotSkillsForSession,
  readBotSkillForBot,
  saveBotSkillForSession,
} from '../botSkillService';

let userDataDir = '';

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-skill-svc-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

const depsFor = (botId: string) => ({
  userDataDir,
  resolveBotId: async () => ({ ok: true as const, botId }),
});

const SAVE = {
  callerSessionId: 'session-1',
  name: 'weekly-report',
  description: 'How I put the weekly report together',
  body: '1. Pull merged PRs\n2. Group by author',
};

describe('saveBotSkillForSession', () => {
  it('confirms the canonical chat refresh after a delegated task learns a Skill', async () => {
    const requestRefresh = vi.fn(async () => true);
    const result = await saveBotSkillForSession(SAVE, { ...depsFor('bot-1'), requestRefresh,
      resolveBotId: async () => ({ ok: true, botId: 'bot-1', canonicalSessionId: 'main-chat' }),
    });
    expect(result).toMatchObject({ ok: true, effective: 'next-turn' });
    expect(requestRefresh).toHaveBeenCalledExactlyOnceWith('main-chat', 'resource');
    expect(await readBotSkillForBot('bot-1', 'weekly-report', { userDataDir })).not.toBeNull();
  });

  it('waits for refresh completion and reports a failed refresh without losing the saved Skill', async () => {
    let complete!: (refreshed: boolean) => void;
    const refresh = new Promise<boolean>(resolve => { complete = resolve; });
    const requestRefresh = vi.fn(() => refresh);
    let settled = false;
    const saving = saveBotSkillForSession(SAVE, { ...depsFor('bot-1'), requestRefresh })
      .then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(requestRefresh).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    complete(false);
    expect(await saving).toMatchObject({ ok: true, effective: 'next-session' });
    expect(await readBotSkillForBot('bot-1', 'weekly-report', { userDataDir })).not.toBeNull();
  });

  it('does not request a runtime refresh when saving fails', async () => {
    const requestRefresh = vi.fn(async () => true);
    expect(await saveBotSkillForSession({ ...SAVE, name: '无有效名字' }, { ...depsFor('bot-1'), requestRefresh }))
      .toMatchObject({ ok: false });
    expect(requestRefresh).not.toHaveBeenCalled();
  });
  it('tells the model the skill only takes effect next session', async () => {
    const result = await saveBotSkillForSession(SAVE, depsFor('bot-1'));

    expect(result).toMatchObject({
      ok: true,
      created: true,
      // harness 的技能面在 spawn 时冻结 —— 不说清楚模型会转头去调一个还没挂上的技能。
      effective: 'next-session',
      skill: { slug: 'weekly-report', name: 'weekly-report' },
    });
  });

  it('reports the second save on the same name as an update', async () => {
    await saveBotSkillForSession(SAVE, depsFor('bot-1'));
    const second = await saveBotSkillForSession(
      { ...SAVE, body: 'now with a step 3' },
      depsFor('bot-1'),
    );

    expect(second).toMatchObject({ ok: true, created: false });
    expect((await readBotSkillForBot('bot-1', 'weekly-report', { userDataDir }))?.body).toBe(
      'now with a step 3',
    );
  });

  it('keeps one Bot out of another Bot\'s shelf', async () => {
    await saveBotSkillForSession({ ...SAVE, name: 'mine' }, depsFor('bot-1'));
    await saveBotSkillForSession({ ...SAVE, name: 'theirs' }, depsFor('bot-2'));

    const first = await listBotSkillsForSession({ callerSessionId: 'x' }, depsFor('bot-1'));
    const second = await listBotSkillsForSession({ callerSessionId: 'x' }, depsFor('bot-2'));
    expect(first.ok && first.skills.map((item) => item.name)).toEqual(['mine']);
    expect(second.ok && second.skills.map((item) => item.name)).toEqual(['theirs']);
  });

  it('passes the ownership refusal straight through without touching the disk', async () => {
    const refused = await saveBotSkillForSession(SAVE, {
      userDataDir,
      resolveBotId: async () => ({
        ok: false as const,
        errorCode: 'BOT_SESSION_INACTIVE',
        message: '已归档的 Bot 任务不能沉淀技能',
      }),
    });

    expect(refused).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
    await expect(fs.readdir(path.join(userDataDir, 'bot-skills'))).rejects.toThrow();
  });

  it('fails closed when the active owner changes while session ownership is resolving', async () => {
    let scope = 'owner-a:1';
    const result = await saveBotSkillForSession(SAVE, {
      userDataDir,
      ownerScopeKey: () => scope,
      ownerBoundaryPending: () => false,
      resolveBotId: async () => {
        scope = 'owner-b:2';
        return { ok: true as const, botId: 'bot-1' };
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
    await expect(fs.access(path.join(userDataDir, 'bots', 'bot-1'))).rejects.toBeTruthy();
  });

  it('does not return a Skill receipt to a different owner after awaiting runtime refresh', async () => {
    let scope = 'owner-a:1';
    const result = await saveBotSkillForSession(SAVE, {
      ...depsFor('bot-1'), ownerScopeKey: () => scope, ownerBoundaryPending: () => false,
      requestRefresh: async () => { scope = 'owner-b:2'; return true; },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
  });

  it('turns a store rejection into an errorCode instead of throwing at the MCP boundary', async () => {
    const result = await saveBotSkillForSession({ ...SAVE, name: '周报怎么写' }, depsFor('bot-1'));
    expect(result).toMatchObject({ ok: false, errorCode: 'SKILL_NAME_UNUSABLE' });
  });
});

describe('设置页与会话挂载读的是同一份磁盘事实', () => {
  it('mounts exactly the same managed baseline for Cindy and a fresh named Bot, outside learned shelves', async () => {
    const cindy = await collectBotOwnSkillMounts('bot-cindy', { userDataDir });
    const fresh = await collectBotOwnSkillMounts('bot-fresh', { userDataDir });
    expect(cindy.baseline).toEqual(fresh.baseline);
    expect(cindy.baseline.skill.name).toBe('teammate-guide');
    expect(cindy.baseline.pluginRoot).not.toContain('bot-cindy');
    const source = await fs.readFile(fresh.baseline.skill.filePath, 'utf8');
    for (const tool of ['start_session_task', 'send_to_agent', 'create_teammate', 'get_app_default_model', 'set_app_default_model', 'save_teammate_skill', 'ghost_call'])
      expect(source).toContain(tool);
    expect(cindy.skills).toEqual([]);
    expect(fresh.skills).toEqual([]);
    await saveBotSkillForSession(SAVE, depsFor('bot-fresh'));
    expect((await collectBotOwnSkillMounts('bot-cindy', { userDataDir })).skills).toEqual([]);
    expect((await collectBotOwnSkillMounts('bot-fresh', { userDataDir })).baseline).toEqual(cindy.baseline);
  });
  it('exposes every saved skill as a mountable directory plus a CC plugin root', async () => {
    await saveBotSkillForSession(SAVE, depsFor('bot-1'));

    const mounts = await collectBotOwnSkillMounts('bot-1', { userDataDir });
    expect(mounts.skills).toHaveLength(1);
    expect(mounts.skills[0].path).toBe(
      path.join(userDataDir, 'bots', 'bot-1', 'skills', 'weekly-report'),
    );
    // 技能住在伙伴自己的家里,与 SOUL.md、config.json 同一个目录。
    expect(mounts.pluginRoot).toBe(path.join(userDataDir, 'bots', 'bot-1'));
    // plugin 根必须真的带清单,否则 Claude Code 不会把它当 local plugin 挂上。
    await expect(
      fs.stat(path.join(mounts.pluginRoot, '.claude-plugin', 'plugin.json')),
    ).resolves.toBeTruthy();
  });

  it('drops the skill from both the settings list and the mount set after a delete', async () => {
    await saveBotSkillForSession(SAVE, depsFor('bot-1'));

    expect(await deleteBotSkillForBot('bot-1', 'weekly-report', { userDataDir })).toBe(true);
    expect(await listBotSkillsForBot('bot-1', { userDataDir })).toEqual([]);
    expect((await collectBotOwnSkillMounts('bot-1', { userDataDir })).skills).toEqual([]);
  });

  it('returns nothing to mount for a Bot that never learned anything', async () => {
    const mounts = await collectBotOwnSkillMounts('bot-fresh', { userDataDir });
    expect(mounts.skills).toEqual([]);
  });
});
