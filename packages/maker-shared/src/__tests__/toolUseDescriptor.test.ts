import { describe, expect, it } from 'vitest';
import {
  describeToolUse,
  humanizeToolToken,
  parseToolName,
  piEditReplacements,
  truncateToolText,
} from '../toolUseDescriptor';

describe('parseToolName', () => {
  it('parses Claude Code mcp__server__tool names', () => {
    expect(parseToolName('mcp__feishu__read_by_url')).toEqual({
      kind: 'mcp',
      server: 'feishu',
      tool: 'read_by_url',
    });
  });

  it('keeps single-underscore server names intact (double-underscore split)', () => {
    expect(parseToolName('mcp__orca_worker_bridge__send_to_lead')).toEqual({
      kind: 'mcp',
      server: 'orca_worker_bridge',
      tool: 'send_to_lead',
    });
  });

  it('rejoins extra double-underscore segments into the tool part', () => {
    expect(parseToolName('mcp__server__part_a__part_b')).toEqual({
      kind: 'mcp',
      server: 'server',
      tool: 'part_a__part_b',
    });
  });

  it('parses codex mcp:server:tool names', () => {
    expect(parseToolName('mcp:feishu:read_by_url')).toEqual({
      kind: 'mcp',
      server: 'feishu',
      tool: 'read_by_url',
    });
  });

  it('keeps colons inside the tool part for codex names', () => {
    expect(parseToolName('mcp:s:a:b')).toEqual({ kind: 'mcp', server: 's', tool: 'a:b' });
  });

  it('parses dynamic tool names with and without namespace', () => {
    expect(parseToolName('dynamic:ns:tool')).toEqual({ kind: 'dynamic', namespace: 'ns', tool: 'tool' });
    expect(parseToolName('dynamic:tool')).toEqual({ kind: 'dynamic', tool: 'tool' });
  });

  it('parses collab tool names', () => {
    expect(parseToolName('collab:wait')).toEqual({ kind: 'collab', tool: 'wait' });
  });

  it('falls back to plain for builtin and malformed names', () => {
    expect(parseToolName('Bash')).toEqual({ kind: 'plain', name: 'Bash' });
    expect(parseToolName('')).toEqual({ kind: 'plain', name: '' });
    expect(parseToolName('mcp__')).toEqual({ kind: 'plain', name: 'mcp__' });
    expect(parseToolName('mcp__server')).toEqual({ kind: 'plain', name: 'mcp__server' });
    expect(parseToolName('mcp:server')).toEqual({ kind: 'plain', name: 'mcp:server' });
    expect(parseToolName('dynamic:')).toEqual({ kind: 'plain', name: 'dynamic:' });
    expect(parseToolName('collab:')).toEqual({ kind: 'plain', name: 'collab:' });
  });
});

describe('describeToolUse — command tools', () => {
  it('extracts the Bash description when present', () => {
    expect(describeToolUse('Bash', { command: 'git status', description: '查看工作区状态' })).toEqual({
      kind: 'command',
      toolName: 'Bash',
      description: '查看工作区状态',
      command: 'git status',
    });
  });

  it('omits description when missing, non-string, or blank', () => {
    expect(describeToolUse('Bash', { command: 'ls' })).toEqual({
      kind: 'command',
      toolName: 'Bash',
      command: 'ls',
      intent: { action: 'list' },
    });
    expect(describeToolUse('Bash', { command: 'ls', description: 42 })).not.toHaveProperty('description');
    expect(describeToolUse('Bash', { command: 'ls', description: null })).not.toHaveProperty('description');
    expect(describeToolUse('Bash', { command: 'ls', description: '   ' })).not.toHaveProperty('description');
  });

  it('prefers displayCommand over command for codex exec, never has description', () => {
    expect(
      describeToolUse('exec', { command: 'pwsh -c "git status"', displayCommand: 'git status', cwd: '/repo' }),
    ).toEqual({
      kind: 'command',
      toolName: 'exec',
      command: 'git status',
      cwd: '/repo',
      intent: { action: 'gitStatus' },
    });
    expect(describeToolUse('exec', { command: 'ls -la' })).toEqual({
      kind: 'command',
      toolName: 'exec',
      command: 'ls -la',
      intent: { action: 'list' },
    });
    expect(describeToolUse('exec', { command: "/bin/zsh -lc 'git status'" })).toEqual({
      kind: 'command',
      toolName: 'exec',
      command: 'git status',
      intent: { action: 'gitStatus' },
    });
  });

  it('degrades to an empty command when input is unusable', () => {
    expect(describeToolUse('Bash', null)).toEqual({ kind: 'command', toolName: 'Bash', command: '' });
    expect(describeToolUse('exec', 'oops')).toEqual({ kind: 'command', toolName: 'exec', command: '' });
    expect(describeToolUse('Bash', [1, 2])).toEqual({ kind: 'command', toolName: 'Bash', command: '' });
  });

  it('derives intent from codex commandActions, preferring them over local parsing', () => {
    expect(
      describeToolUse('exec', {
        command: 'grep -n foo src/',
        commandActions: [{ type: 'search', command: 'grep -n foo src/', query: 'foo', path: 'src/' }],
      }),
    ).toMatchObject({ intent: { action: 'search', target: 'foo', path: 'src/' } });
    // commandActions 全是 unknown → 回退本地规则解析。
    expect(
      describeToolUse('exec', {
        command: 'pnpm test',
        commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      }),
    ).toMatchObject({ intent: { action: 'test' } });
  });

  it('applies the safety gate to the unwrapped display command before trusting commandActions', () => {
    const descriptor = describeToolUse('exec', {
      command: "/bin/zsh -lc 'cat README.md | tee important.conf'",
      displayCommand: 'cat README.md | tee important.conf',
      commandActions: [
        { type: 'read', command: 'cat README.md', name: 'README.md', path: '/repo/README.md' },
      ],
    });
    expect(descriptor).toMatchObject({
      kind: 'command',
      command: 'cat README.md | tee important.conf',
    });
    expect(descriptor).not.toHaveProperty('intent');
  });

  it('skips intent computation when the model already wrote a description', () => {
    expect(
      describeToolUse('Bash', { command: 'ls src', description: '看看源码目录' }),
    ).not.toHaveProperty('intent');
  });

  it('omits intent for commands the local parser cannot classify', () => {
    expect(describeToolUse('Bash', { command: 'docker ps' })).not.toHaveProperty('intent');
    expect(describeToolUse('exec', { command: 'rm -rf build' })).not.toHaveProperty('intent');
  });
});

describe('describeToolUse — file tools', () => {
  it('maps Read/Edit/MultiEdit/Write to file actions with basename', () => {
    expect(describeToolUse('Read', { file_path: '/repo/src/app.ts' })).toEqual({
      kind: 'file',
      toolName: 'Read',
      action: 'read',
      filePath: '/repo/src/app.ts',
      fileName: 'app.ts',
    });
    expect(describeToolUse('Edit', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'edit' });
    expect(describeToolUse('MultiEdit', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'edit' });
    expect(describeToolUse('Write', { file_path: '/repo/a.ts' })).toMatchObject({ action: 'create' });
  });

  it('handles Windows separators in fileName', () => {
    expect(describeToolUse('Read', { file_path: 'C:\\repo\\src\\app.ts' })).toMatchObject({
      fileName: 'app.ts',
    });
  });

  it('falls back from file_path to path, then degrades to generic', () => {
    expect(describeToolUse('Read', { path: '/repo/b.ts' })).toMatchObject({ filePath: '/repo/b.ts' });
    expect(describeToolUse('Read', {})).toEqual({ kind: 'generic', toolName: 'Read' });
  });
});

describe('describeToolUse — pi builtin tools (lowercase, path field)', () => {
  it('maps pi bash to command with local intent (schema has no description field)', () => {
    expect(describeToolUse('bash', { command: 'git status' })).toEqual({
      kind: 'command',
      toolName: 'bash',
      command: 'git status',
      intent: { action: 'gitStatus' },
    });
    expect(describeToolUse('bash', { command: 'docker ps' })).toEqual({
      kind: 'command',
      toolName: 'bash',
      command: 'docker ps',
    });
  });

  it('maps pi read/edit/write/ls to file actions via the path field', () => {
    expect(describeToolUse('read', { path: '/repo/src/app.ts' })).toEqual({
      kind: 'file',
      toolName: 'read',
      action: 'read',
      filePath: '/repo/src/app.ts',
      fileName: 'app.ts',
    });
    expect(describeToolUse('edit', {
      path: '/repo/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    })).toMatchObject({ kind: 'file', action: 'edit', fileName: 'a.ts' });
    expect(describeToolUse('write', { path: '/repo/new.ts', content: 'x' })).toMatchObject({
      kind: 'file',
      action: 'create',
      fileName: 'new.ts',
    });
    expect(describeToolUse('ls', { path: '/repo/src' })).toMatchObject({
      kind: 'file',
      action: 'read',
      fileName: 'src',
    });
  });

  it('degrades pi ls without path (defaults to cwd) to generic', () => {
    expect(describeToolUse('ls', {})).toEqual({ kind: 'generic', toolName: 'ls' });
  });

  it('maps pi read/edit/write/ls to file actions regardless of edit input shape', () => {
    // legacy 顶层形态也必须仍然是 file/edit 描述符(路径来自 path)。
    expect(describeToolUse('edit', {
      path: '/repo/a.ts',
      oldText: 'x',
      newText: 'y',
    })).toMatchObject({ kind: 'file', action: 'edit', fileName: 'a.ts' });
  });

  it('maps pi grep to grep-mode and pi find (glob pattern) to glob-mode search', () => {
    expect(describeToolUse('grep', { pattern: 'TODO', path: 'src/', glob: '*.ts' })).toEqual({
      kind: 'search',
      toolName: 'grep',
      mode: 'grep',
      pattern: 'TODO',
      path: 'src/',
      glob: '*.ts',
    });
    expect(describeToolUse('find', { pattern: '**/*.spec.ts' })).toEqual({
      kind: 'search',
      toolName: 'find',
      mode: 'glob',
      pattern: '**/*.spec.ts',
    });
    expect(describeToolUse('grep', {})).toEqual({ kind: 'generic', toolName: 'grep' });
  });
});

describe('describeToolUse — Codex file_change', () => {
  it('normalizes add/update/delete and rename changes', () => {
    expect(describeToolUse('file_change', {
      changes: [
        { path: '/repo/src/new.ts', kind: { type: 'add' }, diff: '+++ b/src/new.ts\n+hello' },
        { path: '/repo/src/app.ts', kind: { type: 'update' }, diff: '-old\n+new' },
        { path: '/repo/src/old.ts', kind: { type: 'delete' }, diff: '-gone' },
        {
          path: '/repo/src/before.ts',
          kind: { type: 'update', move_path: '/repo/src/after.ts' },
          diff: '',
        },
      ],
    })).toEqual({
      kind: 'fileChange',
      toolName: 'file_change',
      changes: [
        {
          action: 'add',
          path: '/repo/src/new.ts',
          fileName: 'new.ts',
          diff: '+++ b/src/new.ts\n+hello',
        },
        {
          action: 'update',
          path: '/repo/src/app.ts',
          fileName: 'app.ts',
          diff: '-old\n+new',
        },
        {
          action: 'delete',
          path: '/repo/src/old.ts',
          fileName: 'old.ts',
          diff: '-gone',
        },
        {
          action: 'move',
          path: '/repo/src/before.ts',
          fileName: 'before.ts',
          movePath: '/repo/src/after.ts',
          moveFileName: 'after.ts',
          diff: '',
        },
      ],
    });
  });

  it('accepts camelCase/top-level move fields and preserves unknown actions', () => {
    expect(describeToolUse('file_change', {
      changes: [
        { path: 'C:\\repo\\a.ts', kind: { type: 'update', movePath: 'C:\\repo\\b.ts' }, diff: '' },
        { path: '/repo/custom.bin', kind: { type: 'chmod' }, diff: '' },
      ],
    })).toMatchObject({
      kind: 'fileChange',
      changes: [
        { action: 'move', fileName: 'a.ts', moveFileName: 'b.ts' },
        { action: 'unknown', fileName: 'custom.bin' },
      ],
    });
  });

  it('degrades the whole call to generic when changes are empty or malformed', () => {
    expect(describeToolUse('file_change', { changes: [] })).toEqual({
      kind: 'generic',
      toolName: 'file_change',
    });
    expect(describeToolUse('file_change', {
      changes: [{ path: '/repo/a.ts', kind: { type: 'update' } }],
    })).toEqual({ kind: 'generic', toolName: 'file_change' });
  });
});

describe('describeToolUse — search / web / todo / task tools', () => {
  it('maps Grep and Glob to search descriptors', () => {
    expect(describeToolUse('Grep', { pattern: 'foo', path: 'src', glob: '*.ts' })).toEqual({
      kind: 'search',
      toolName: 'Grep',
      mode: 'grep',
      pattern: 'foo',
      path: 'src',
      glob: '*.ts',
    });
    expect(describeToolUse('Glob', { pattern: '**/*.md' })).toEqual({
      kind: 'search',
      toolName: 'Glob',
      mode: 'glob',
      pattern: '**/*.md',
    });
    expect(describeToolUse('Grep', {})).toEqual({ kind: 'generic', toolName: 'Grep' });
  });

  it('maps WebFetch / WebSearch / web_search to web descriptors', () => {
    expect(describeToolUse('WebFetch', { url: 'https://x.dev' })).toEqual({
      kind: 'web',
      toolName: 'WebFetch',
      mode: 'fetch',
      target: 'https://x.dev',
    });
    expect(describeToolUse('WebSearch', { query: 'electron ipc' })).toMatchObject({
      mode: 'search',
      target: 'electron ipc',
    });
    expect(describeToolUse('web_search', { query: 'codex' })).toMatchObject({ mode: 'search' });
    expect(describeToolUse('WebFetch', {})).toEqual({
      kind: 'generic',
      toolName: 'WebFetch',
    });
  });

  it('maps TodoWrite / update_plan to todo', () => {
    expect(describeToolUse('TodoWrite', { todos: [] })).toEqual({ kind: 'todo', toolName: 'TodoWrite' });
    expect(describeToolUse('update_plan', null)).toEqual({ kind: 'todo', toolName: 'update_plan' });
  });

  it('extracts Task description and subagent type', () => {
    expect(
      describeToolUse('Task', { description: '搜索代码', subagent_type: 'Explore', prompt: '...' }),
    ).toEqual({ kind: 'task', toolName: 'Task', description: '搜索代码', subagentType: 'Explore' });
    expect(describeToolUse('Task', {})).toEqual({ kind: 'task', toolName: 'Task' });
  });
});

describe('describeToolUse — mcp / dynamic / collab', () => {
  it('builds mcp descriptors with humanized tool label and detail', () => {
    expect(describeToolUse('mcp__feishu__read_by_url', { url: 'https://f.cn/doc' })).toEqual({
      kind: 'mcp',
      toolName: 'mcp__feishu__read_by_url',
      server: 'feishu',
      tool: 'read_by_url',
      serverLabel: 'feishu',
      toolLabel: 'read by url',
      detail: 'https://f.cn/doc',
    });
  });

  it('picks detail by key priority (description first)', () => {
    expect(
      describeToolUse('mcp:jira:query_issues', { query: 'bug', description: '查询未关闭缺陷' }),
    ).toMatchObject({ detail: '查询未关闭缺陷' });
  });

  it('truncates long detail to 80 chars and omits detail for non-record input', () => {
    const long = 'x'.repeat(200);
    const withLong = describeToolUse('mcp__s__t', { description: long });
    expect(withLong).toMatchObject({ detail: `${'x'.repeat(77)}...` });
    expect(describeToolUse('mcp__s__t', null)).not.toHaveProperty('detail');
  });

  it('builds dynamic and collab descriptors', () => {
    expect(describeToolUse('dynamic:ns:do_thing', { query: 'q' })).toEqual({
      kind: 'dynamic',
      toolName: 'dynamic:ns:do_thing',
      namespace: 'ns',
      tool: 'do_thing',
      toolLabel: 'do thing',
      detail: 'q',
    });
    expect(describeToolUse('collab:wait', null)).toEqual({
      kind: 'collab',
      toolName: 'collab:wait',
      tool: 'wait',
      toolLabel: 'wait',
    });
  });
});

describe('describeToolUse — generic fallback', () => {
  it('maps unknown tools to generic with detail extraction', () => {
    expect(describeToolUse('SomethingNew', { description: '做点什么' })).toEqual({
      kind: 'generic',
      toolName: 'SomethingNew',
      detail: '做点什么',
    });
  });

  it('never throws on hostile input shapes', () => {
    for (const input of [null, undefined, 'str', 42, [], { nested: { deep: true } }]) {
      expect(() => describeToolUse('SomethingNew', input)).not.toThrow();
      expect(describeToolUse('SomethingNew', input)).toMatchObject({ kind: 'generic' });
    }
  });
});

describe('helpers', () => {
  it('humanizes underscore tokens', () => {
    expect(humanizeToolToken('read_by_url')).toBe('read by url');
    expect(humanizeToolToken('part_a__part_b')).toBe('part a part b');
  });

  it('truncates display text with ellipsis', () => {
    expect(truncateToolText('short', 10)).toBe('short');
    expect(truncateToolText('a'.repeat(12), 10)).toBe(`${'a'.repeat(7)}...`);
  });
});

describe('piEditReplacements', () => {
  it('reads the declared edits[] shape in order', () => {
    expect(piEditReplacements({
      path: '/repo/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }],
    })).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: 'd' },
    ]);
  });

  it('reads the legacy top-level { oldText, newText } single replacement', () => {
    expect(piEditReplacements({ path: '/repo/a.ts', oldText: 'x', newText: 'y' })).toEqual([
      { oldText: 'x', newText: 'y' },
    ]);
  });

  it('appends the top-level pair after edits[], mirroring pi normalizeEditInput', () => {
    expect(piEditReplacements({
      path: '/repo/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
      oldText: 'x',
      newText: 'y',
    })).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: 'x', newText: 'y' },
    ]);
  });

  it('keeps pure insert/delete segments and fills the missing side with an empty string', () => {
    expect(piEditReplacements({ edits: [{ newText: 'added' }, { oldText: 'removed' }] })).toEqual([
      { oldText: '', newText: 'added' },
      { oldText: 'removed', newText: '' },
    ]);
  });

  it('ignores unusable input instead of throwing', () => {
    expect(piEditReplacements(null)).toEqual([]);
    expect(piEditReplacements('oops')).toEqual([]);
    expect(piEditReplacements({ path: '/repo/a.ts' })).toEqual([]);
    expect(piEditReplacements({ edits: 'nope' })).toEqual([]);
    expect(piEditReplacements({ edits: [null, 42, {}] })).toEqual([]);
    // 顶层只给一半不成段(pi 自己也要求两侧都是字符串才归一化)。
    expect(piEditReplacements({ oldText: 'x' })).toEqual([]);
    expect(piEditReplacements({ newText: 'y' })).toEqual([]);
  });
});
