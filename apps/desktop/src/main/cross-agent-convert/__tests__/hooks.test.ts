import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { convertHooks } from '../converters/hooks.js';
import { detect } from '../detector.js';
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

// #8858: unit 回归经 detect/convertHooks 验证真实配置写入和再次检测；
// 旧用例只覆盖 JSON 整项转换，没有 TOML、增量与无脚本目录的往返状态。
async function writeConfig(relativePath: string, contents: string): Promise<void> {
  const file = path.join(wd, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

const commandGroup = (...commands: string[]) => [{
  hooks: commands.map((command) => ({ type: 'command', command })),
}];

async function pendingHooks(agentKind: 'codex' | 'claude-code' = 'codex') {
  return (await detect({ workingDir: wd, agentKind })).items.find((item) => item.kind === 'hooks');
}

describe('hooks migration — incremental detection (#8858)', () => {
  it.each(['json', 'toml'] as const)('recognizes equivalent %s hooks without script directories and leaves them unchanged', async (format) => {
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { Stop: commandGroup('true') } }));
    const file = format === 'json' ? '.codex/hooks.json' : '.codex/config.toml';
    const contents = format === 'json'
      ? JSON.stringify({ description: 'keep', hooks: { Stop: commandGroup('true') } })
      : '# keep comments\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "true"\n';
    await writeConfig(file, contents);

    expect(await pendingHooks()).toBeUndefined();
    expect((await convertHooks(toCodexItem())).status).toBe('skipped');
    expect(await fs.readFile(path.join(wd, file), 'utf8')).toBe(contents);
    await expect(fs.stat(path.join(wd, '.codex', 'hooks'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (format === 'toml') {
      await expect(fs.stat(path.join(wd, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['codex', 'claude-code'] as const)('settings-only conversion to %s stops prompting on the next detection', async (agentKind) => {
    const hooks = { Stop: commandGroup('true') };
    await writeConfig(agentKind === 'codex' ? '.claude/settings.json' : '.codex/hooks.json', JSON.stringify({ hooks }));
    const item = await pendingHooks(agentKind);
    expect(item).toBeDefined();
    expect((await convertHooks(item!)).status).toBe('success');
    expect(await pendingHooks(agentKind)).toBeUndefined();
  });

  it.each(['codex', 'claude-code'] as const)('to %s discovers a missing script even when both directories and configs exist', async (agentKind) => {
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: {} }));
    await writeConfig('.codex/hooks.json', JSON.stringify({ hooks: {} }));
    await fs.mkdir(path.join(wd, '.claude', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(wd, '.codex', 'hooks'), { recursive: true });
    const source = agentKind === 'codex' ? '.claude' : '.codex';
    const target = agentKind === 'codex' ? '.codex' : '.claude';
    await writeConfig(`${source}/hooks/new.sh`, 'echo new');
    await writeConfig(`${source}/hooks/existing.sh`, 'source version');
    await writeConfig(`${target}/hooks/existing.sh`, 'user version');

    const item = await pendingHooks(agentKind);
    expect(item).toBeDefined();
    expect((await convertHooks(item!)).status).toBe('success');
    expect(await fs.readFile(path.join(wd, target, 'hooks', 'new.sh'), 'utf8')).toBe('echo new');
    expect(await fs.readFile(path.join(wd, target, 'hooks', 'existing.sh'), 'utf8')).toBe('user version');
    expect(await pendingHooks(agentKind)).toBeUndefined();
  });

  it.each(['codex', 'claude-code'] as const)('to %s adds missing events while keeping existing event arrays unchanged', async (agentKind) => {
    const source = { Stop: commandGroup('echo old', 'echo new'), SessionStart: commandGroup('echo start') };
    const target = { Stop: commandGroup('echo old', 'echo custom') };
    await writeConfig('.claude/settings.json', JSON.stringify({ permissions: 'keep', hooks: agentKind === 'codex' ? source : target }));
    await writeConfig('.codex/hooks.json', JSON.stringify({ description: 'keep', hooks: agentKind === 'codex' ? target : source }));

    const item = await pendingHooks(agentKind);
    expect(item).toBeDefined();
    expect((await convertHooks(item!)).status).toBe('success');
    const file = agentKind === 'codex' ? '.codex/hooks.json' : '.claude/settings.json';
    const result = JSON.parse(await fs.readFile(path.join(wd, file), 'utf8'));
    expect(result.hooks.Stop).toEqual(target.Stop);
    expect(result.hooks.SessionStart).toEqual(source.SessionStart);
    expect(agentKind === 'codex' ? result.description : result.permissions).toBe('keep');
    expect(await pendingHooks(agentKind)).toBeUndefined();
  });

  it('keeps an existing TOML event unchanged and does not create JSON for different source handlers', async () => {
    const toml = '# keep\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "true"\n';
    await writeConfig('.codex/config.toml', toml);
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { Stop: commandGroup('true', 'echo new') } }));
    expect(await pendingHooks()).toBeUndefined();
    expect((await convertHooks(toCodexItem())).status).toBe('skipped');
    await expect(fs.stat(path.join(wd, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(wd, '.codex', 'config.toml'), 'utf8')).toBe(toml);
  });

  it('adds only a missing event when the other event is already present in TOML', async () => {
    const toml = '# keep\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "true"\n';
    const sessionStart = commandGroup('echo start');
    await writeConfig('.codex/config.toml', toml);
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { Stop: commandGroup('echo different'), SessionStart: sessionStart } }));
    const item = await pendingHooks();
    expect(item).toBeDefined();
    expect((await convertHooks(item!)).status).toBe('success');
    const result = JSON.parse(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8'));
    expect(result.hooks).toEqual({ SessionStart: sessionStart });
    expect(await fs.readFile(path.join(wd, '.codex', 'config.toml'), 'utf8')).toBe(toml);
    expect(await pendingHooks()).toBeUndefined();
  });

  // PR #8862 的审阅复现：省略 matcher 和空 matcher 都表示无条件，不能重复安装同一命令。
  // 保留原转换器的同名事件跳过契约后，含不同 matcher / 新 handler 的同名事件也不盲目合并。
  it.each(['codex', 'claude-code'] as const)('to %s skips an existing event with omitted versus empty matcher', async (agentKind) => {
    const source = { Stop: commandGroup('true') };
    const target = { Stop: [{ matcher: '', hooks: commandGroup('true')[0].hooks }] };
    const targetFile = agentKind === 'codex' ? '.codex/hooks.json' : '.claude/settings.json';
    const contents = JSON.stringify({ hooks: target });
    await writeConfig(agentKind === 'codex' ? '.claude/settings.json' : '.codex/hooks.json', JSON.stringify({ hooks: source }));
    await writeConfig(targetFile, contents);

    expect(await pendingHooks(agentKind)).toBeUndefined();
    expect((await convertHooks(agentKind === 'codex' ? toCodexItem() : toClaudeItem())).status).toBe('skipped');
    expect(await fs.readFile(path.join(wd, targetFile), 'utf8')).toBe(contents);
  });

  it('preserves a target event whose matcher differs from the source', async () => {
    const group = { matcher: 'Bash', hooks: commandGroup('true')[0].hooks };
    const original = { ...group, matcher: 'Read' };
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [group] } }));
    const contents = JSON.stringify({ hooks: { PreToolUse: [original] } });
    await writeConfig('.codex/hooks.json', contents);
    expect(await pendingHooks()).toBeUndefined();
    expect((await convertHooks(toCodexItem())).status).toBe('skipped');
    expect(await fs.readFile(path.join(wd, '.codex', 'hooks.json'), 'utf8')).toBe(contents);
  });

  it('can import native TOML hooks into Claude without copying JSON metadata as events', async () => {
    await writeConfig('.codex/config.toml', '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "true"\n');
    await writeConfig('.codex/hooks.json', JSON.stringify({ description: 'metadata only' }));
    const item = await pendingHooks('claude-code');
    expect(item).toBeDefined();
    expect((await convertHooks(item!)).status).toBe('success');
    const result = JSON.parse(await fs.readFile(path.join(wd, '.claude', 'settings.json'), 'utf8'));
    expect(result.hooks).toEqual({ Stop: commandGroup('true') });
    expect(await pendingHooks('claude-code')).toBeUndefined();
  });

  it('deduplicates a shared script command from JSON and TOML before reverse path rewriting', async () => {
    // command 是配置中的逻辑路径，不是宿主文件系统路径。
    await writeConfig('.codex/config.toml', '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ".codex/hooks/done.sh"\n');
    await writeConfig('.codex/hooks.json', JSON.stringify({ hooks: { Stop: commandGroup('.codex/hooks/done.sh') } }));
    expect((await convertHooks(toClaudeItem())).status).toBe('success');
    const result = JSON.parse(await fs.readFile(path.join(wd, '.claude', 'settings.json'), 'utf8'));
    expect(result.hooks.Stop).toEqual(commandGroup('.claude/hooks/done.sh'));
    expect(await pendingHooks('claude-code')).toBeUndefined();
  });

  it.each(['', '# hooks only in a comment', '[hooks]', 'model = "example"', '[hooks]\nStop = "invalid"', '[[hooks.Stop]]\nbroken = ['])('does not treat empty, missing or invalid TOML hooks as coverage: %j', async (toml) => {
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { Stop: commandGroup('true') } }));
    await writeConfig('.codex/config.toml', toml);
    expect(await pendingHooks()).toBeDefined();
  });

  it('refuses conversion against malformed TOML without modifying the target', async () => {
    await writeConfig('.claude/settings.json', JSON.stringify({ hooks: { Stop: commandGroup('true') } }));
    const toml = '[[hooks.Stop]]\nbroken = [';
    await writeConfig('.codex/config.toml', toml);
    await writeConfig('.claude/hooks/new.sh', 'echo new');
    expect((await convertHooks(toCodexItem())).status).toBe('failed');
    expect(await fs.readFile(path.join(wd, '.codex', 'config.toml'), 'utf8')).toBe(toml);
    await expect(fs.stat(path.join(wd, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(wd, '.codex', 'hooks', 'new.sh'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['codex', 'claude-code'] as const)('empty source settings and directories do not prompt %s', async (agentKind) => {
    const source = agentKind === 'codex' ? '.claude' : '.codex';
    await fs.mkdir(path.join(wd, source, 'hooks'), { recursive: true });
    await writeConfig(`${source}/${agentKind === 'codex' ? 'settings.json' : 'hooks.json'}`, JSON.stringify({ hooks: {} }));
    expect(await pendingHooks(agentKind)).toBeUndefined();
  });
});

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
