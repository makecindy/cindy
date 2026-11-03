import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { convertHooks } from '../converters/hooks.js';
import type { MigrationItem } from '../types.js';

let wd: string;

beforeEach(async () => {
  wd = await fs.mkdtemp(path.join(os.tmpdir(), 'xagent-hooks-'));
});
afterEach(async () => {
  await fs.rm(wd, { recursive: true, force: true });
});

function toCodexItem(): MigrationItem {
  return {
    id: 'hooks:0',
    kind: 'hooks',
    direction: 'to-codex',
    label: 'hooks',
    source: path.join(wd, '.claude', 'hooks'),
    target: path.join(wd, '.codex', 'hooks.json'),
  };
}
function toClaudeItem(): MigrationItem {
  return {
    id: 'hooks:0',
    kind: 'hooks',
    direction: 'to-claude',
    label: 'hooks',
    source: path.join(wd, '.codex', 'hooks.json'),
    target: path.join(wd, '.claude', 'settings.json'),
  };
}

describe('convertHooks — to-codex', () => {
  it('copies scripts + writes hooks.json with rewritten paths; event name kept as-is (PreToolUse)', async () => {
    const claudeHooks = path.join(wd, '.claude', 'hooks');
    const claudeSettings = path.join(wd, '.claude', 'settings.json');
    await fs.mkdir(claudeHooks, { recursive: true });
    await fs.writeFile(path.join(claudeHooks, 'pre.sh'), '#!/bin/sh\necho hi');
    await fs.writeFile(claudeSettings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '.claude/hooks/pre.sh' }] }] },
    }));

    const r = await convertHooks(toCodexItem());
    expect(r.status).toBe('success');

    expect(await fs.readFile(path.join(wd, '.codex', 'hooks', 'pre.sh'), 'utf8')).toContain('echo hi');
    const json = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    // Codex 用 camelCase 与 Claude 完全一致
    // Codex 规范：事件放在顶层 "hooks" 对象内
    expect(json.PreToolUse).toBeUndefined();
    expect(json.hooks.PreToolUse).toBeDefined();
    expect(JSON.stringify(json.hooks.PreToolUse)).toContain('.codex/hooks/pre.sh');
    expect(JSON.stringify(json.hooks.PreToolUse)).not.toContain('.claude/hooks/');
  });

  it('skips events that already exist in target hooks.json (no overwrite)', async () => {
    const claudeHooks = path.join(wd, '.claude', 'hooks');
    const claudeSettings = path.join(wd, '.claude', 'settings.json');
    await fs.mkdir(claudeHooks, { recursive: true });
    await fs.writeFile(path.join(claudeHooks, 'p.sh'), 'x');
    await fs.writeFile(claudeSettings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '.claude/hooks/p.sh' }] }] },
    }));
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: 'USER_ORIGINAL' },
    }));

    const r = await convertHooks(toCodexItem());
    expect(r.status).toBe('success'); // still success because script was copied
    const json = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    expect(json.hooks.PreToolUse).toBe('USER_ORIGINAL');
  });

  it('upgrades a legacy flat hooks.json into the wrapped { hooks: {...} } shape', async () => {
    await fs.mkdir(path.join(wd, '.claude'), { recursive: true });
    await fs.writeFile(path.join(wd, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    }));
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({ PreToolUse: 'FLAT' }));

    const r = await convertHooks({ ...toCodexItem(), source: path.join(wd, '.claude', 'hooks') });
    expect(r.status).toBe('success');
    const json = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    expect(json.PreToolUse).toBeUndefined();
    expect(json.hooks.PreToolUse).toBe('FLAT');
    expect(json.hooks.Stop).toBeDefined();
  });

  it('flattens a mis-nested settings.hooks.hooks when reading Claude hooks', async () => {
    await fs.mkdir(path.join(wd, '.claude'), { recursive: true });
    await fs.writeFile(path.join(wd, '.claude', 'settings.json'), JSON.stringify({
      hooks: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo s' }] }] } },
    }));
    const r = await convertHooks(toCodexItem());
    expect(r.status).toBe('success');
    const json = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    expect(json.hooks.SessionStart).toBeDefined();
    expect(json.hooks.hooks).toBeUndefined();
  });
  it('upgrades a legacy flat hooks.json even when no event or script is added', async () => {
    await fs.mkdir(path.join(wd, '.claude'), { recursive: true });
    await fs.writeFile(path.join(wd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ a: 1 }] } }));
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({ Stop: [{ a: 1 }] }));

    const r = await convertHooks(toCodexItem());
    expect(r.status).toBe('success');
    const json = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    expect(json).toEqual({ hooks: { Stop: [{ a: 1 }] } });
  });
});

describe('convertHooks — to-claude', () => {
  it('writes settings.json hooks section + copies scripts; event name passes through', async () => {
    const codexHooks = path.join(wd, '.codex', 'hooks');
    const codexJson = path.join(wd, '.codex', 'hooks.json');
    await fs.mkdir(codexHooks, { recursive: true });
    await fs.writeFile(path.join(codexHooks, 'p.sh'), 'echo p');
    await fs.writeFile(codexJson, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '.codex/hooks/p.sh' }] }] },
    }));

    const r = await convertHooks(toClaudeItem());
    expect(r.status).toBe('success');
    expect(await fs.readFile(path.join(wd, '.claude', 'hooks', 'p.sh'), 'utf8')).toBe('echo p');
    const settings = JSON.parse(await fs.readFile(path.join(wd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('.claude/hooks/p.sh');
    // 不得把 Codex 的外层 "hooks" 包装当作事件名写进 settings.hooks
    expect(settings.hooks.hooks).toBeUndefined();
  });

  it('still accepts a legacy flat hooks.json', async () => {
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({
      Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
    }));
    const r = await convertHooks(toClaudeItem());
    expect(r.status).toBe('success');
    const settings = JSON.parse(await fs.readFile(path.join(wd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('repairs a pre-existing settings.hooks.hooks nesting', async () => {
    const claudeSettings = path.join(wd, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(claudeSettings), { recursive: true });
    await fs.writeFile(claudeSettings, JSON.stringify({
      hooks: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo s' }] }] } },
    }));
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] },
    }));
    const r = await convertHooks(toClaudeItem());
    expect(r.status).toBe('success');
    const settings = JSON.parse(await fs.readFile(claudeSettings, 'utf8'));
    expect(settings.hooks.hooks).toBeUndefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('merges into existing settings.json without removing other top-level keys', async () => {
    const claudeSettings = path.join(wd, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(claudeSettings), { recursive: true });
    await fs.writeFile(claudeSettings, JSON.stringify({ permissions: 'user-keeps' }));
    await fs.mkdir(path.join(wd, '.codex'), { recursive: true });
    await fs.writeFile(path.join(wd, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '.codex/hooks/done.sh' }] }] },
    }));

    const r = await convertHooks(toClaudeItem());
    expect(r.status).toBe('success');
    const settings = JSON.parse(await fs.readFile(claudeSettings, 'utf8'));
    expect(settings.permissions).toBe('user-keeps');
    expect(settings.hooks.Stop).toBeDefined();
  });

});
