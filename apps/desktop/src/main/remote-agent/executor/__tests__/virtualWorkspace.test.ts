import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createComputerMcpServer, registerGetCurrentSessionIdTool, XdtHelperToolRegistry } from '@cindy/mcps';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { mapExecServerParams, mapExecServerResult, execServerActions } from '../../controller/execServerRelay';
import { RemoteExecutor } from '../executor';
import { ExecutorGate } from '../gate';
import { resolveExecutorShell, runOnce } from '../shell';
import { ExecutorWorkspace, projectPathText } from '../workspace';
import { createReverseHttpRouter } from '../../controller/router';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-virtual-workspace-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Agent 写进文件的路径还原到本机时沿用它的分隔符，源码字符串里不会冒出 `\f`、`\b` 这类转义。 */
function written(local: string, virtual: string): string { return virtual.startsWith('C:') ? local : local.replace(/\\/g, '/'); }

function setup(virtual: string) {
  const project = path.join(root, 'real project');
  fs.mkdirSync(project);
  const workspace = new ExecutorWorkspace({ workingDir: project, aliases: [{ from: virtual, to: project }] });
  workspace.setVirtualRoot(virtual);
  const gate = new ExecutorGate(workspace, 'normal');
  const executor = new RemoteExecutor({ workspace, gate, rgPath: 'unused' });
  return { project, workspace, executor, gate };
}

describe('virtual workspace', () => {
  it.each([
    { real: 'C:\\Users\\local\\real project', virtual: '/home/agent/workspace', realPath: path.win32, agentPath: path.posix },
    { real: '/Users/local/real project', virtual: 'C:\\Agent\\workspace', realPath: path.posix, agentPath: path.win32 },
  ])('round-trips serialized JSON paths from $real to $virtual without changing its format', ({ real, virtual, realPath, agentPath }) => {
    const document = (directory: string, native: typeof path.win32) => [
      '{',
      '  "working_dir": ' + JSON.stringify(directory) + ',',
      '  "file": ' + JSON.stringify(native.join(directory, 'src', 'a.ts')) + ',',
      '  "spaced_file": ' + JSON.stringify(native.join(directory, '目录 空格', 'skill', 'probe.cjs')) + ',',
      '  "encoded": ' + JSON.stringify(JSON.stringify({ cwd: directory })) + ',',
      '  "untouched": "\\u4e2d\\u6587",',
      '  "number": 1.00e0',
      '}',
      '',
    ].join('\n');
    const original = document(real, realPath);
    const projected = projectPathText(original, [{ from: real, to: virtual }]);
    expect(projected).toBe(document(virtual, agentPath));
    expect(JSON.parse(JSON.parse(projected).encoded).cwd).toBe(virtual);
    expect(projectPathText(projected, [{ from: virtual, to: real }])).toBe(original);
    const log = 'Starting script\r\n' + JSON.stringify({ cwd: real }) + '\r\n' + JSON.stringify({ cwd: real }) + '\r\n';
    const projectedLog = 'Starting script\r\n' + JSON.stringify({ cwd: virtual }) + '\r\n' + JSON.stringify({ cwd: virtual }) + '\r\n';
    expect(projectPathText(log, [{ from: real, to: virtual }])).toBe(projectedLog);
    expect(projectPathText(projectedLog, [{ from: virtual, to: real }])).toBe(log);
    const nativeScript = realPath.join(real, '目录 空格', 'skill', 'probe.cjs');
    const virtualScript = agentPath.join(virtual, '目录 空格', 'skill', 'probe.cjs');
    expect(projectPathText(nativeScript, [{ from: real, to: virtual }], 'path')).toBe(virtualScript);
    expect(projectPathText(nativeScript + '\r\n', [{ from: real, to: virtual }], 'path')).toBe(virtualScript + '\r\n');
    expect(projectPathText(JSON.stringify(nativeScript), [{ from: real, to: virtual }], 'path')).toBe(JSON.stringify(virtualScript));
    expect(projectPathText(JSON.stringify([nativeScript]), [{ from: real, to: virtual }], 'path')).toBe(JSON.stringify([virtualScript]));
    expect(projectPathText(real + realPath.sep, [{ from: real, to: virtual }])).toBe(virtual + agentPath.sep);
    expect(projectPathText(JSON.stringify({ message: 'Cannot load', path: nativeScript }), [{ from: real, to: virtual }]))
      .toBe(JSON.stringify({ message: 'Cannot load', path: virtualScript }));
  });

  it.each(['/Users/agent/workspace', '/home/agent/workspace', 'C:\\Agent\\workspace'])('round-trips paths from %s and keeps authorization on real paths', async (virtual) => {
    const { project, workspace, executor, gate } = setup(virtual);
    const api = virtual.startsWith('C:') ? path.win32 : path.posix;
    const target = api.join(virtual, 'made.txt');
    const written = await executor.callTool('Write', { file_path: target, content: 'literal ' + project });
    expect(JSON.stringify(written)).toContain(target.replace(/\\/g, '\\\\'));
    expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8')).toBe('literal ' + project);
    expect(workspace.resolve(target)).toBe(path.join(project, 'made.txt'));
    const read = await executor.callTool('Read', { file_path: target });
    // 文本文件内容也投影；写回时会还原，避免 Agent 通过中间文件读出本机路径。
    expect(read.content).toEqual([{ type: 'text', text: '1	literal ' + virtual }]);
    const edited = await executor.callTool('Edit', { file_path: target, old_string: project, new_string: 'updated' });
    expect(JSON.stringify(edited)).not.toContain(project.replace(/\\/g, '\\\\'));
    expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8')).toBe('literal updated');
    const outside = path.join(root, 'outside');
    const mapped = workspace.virtualizeDirs([outside])[0];
    expect(workspace.resolve(mapped)).toBe(outside);
    expect(gate.authorize({ kind: 'write', path: workspace.resolve(mapped) }).ok).toBe(false);
    await executor.close();
  });

  it('projects command paths with boundaries, Windows separators and Git Bash pwd', async () => {
    expect(projectPathText('cat C:\\virtual\\project\\src\\x.ts; C:\\virtual\\project2', [{ from: 'C:\\virtual\\project', to: '/real/project' }]))
      .toBe('cat /real/project/src/x.ts; C:\\virtual\\project2');
    expect(projectPathText('pwd /real/project/src /real/project2', [{ from: '/real/project', to: '/virtual/project' }]))
      .toBe('pwd /virtual/project/src /real/project2');
    expect(projectPathText(';`/real/project`? /real/project&x', [{ from: '/real/project', to: '/virtual/project' }]))
      .toBe(';`/virtual/project`? /virtual/project&x');
    const { workspace, project, executor } = setup('/Users/agent/workspace');
    expect(workspace.mapCommand('cd "/Users/agent/workspace"')).toContain(project.replace(/\\/g, '/'));
    expect(projectPathText('cat "/real/project/src/a.ts" && echo "/other/file"', [{ from: '/real/project', to: 'C:\\Agent\\workspace' }]))
      .toBe('cat "C:\\Agent\\workspace\\src\\a.ts" && echo "/other/file"');
    expect(workspace.mapTextForAgent(project)).toBe('/Users/agent/workspace');
    if (process.platform === 'win32') {
      const bashPath = '/' + project[0].toLowerCase() + project.slice(2).replace(/\\/g, '/');
      expect(workspace.mapTextForAgent(bashPath)).toBe('/Users/agent/workspace');
    }
    const result = await executor.handle('exec.run', { command: 'pwd', cwd: '/Users/agent/workspace' }) as { output: string };
    expect(Buffer.from(result.output, 'base64').toString()).toContain('/Users/agent/workspace');
    const binary = Buffer.from([0xff, 0x00, 0x80, 0x41]);
    expect(workspace.mapOutputForAgent(binary)).toEqual(binary);
    await executor.close();
  });

  it('keeps closing quotes outside mapped command paths', async () => {
    const { workspace, project, executor } = setup('/Users/agent/workspace');
    const real = project.replace(/\\/g, '/');
    // 2026-10 真实事故：单引号路径被映射成 '…mjs'\''，前置检查命令引号失配。
    expect(workspace.mapCommand("node '/Users/agent/workspace/x.mjs'")).toBe(`node '${real}/x.mjs'`);
    expect(workspace.mapCommand("node '/Users/agent/workspace/x.mjs' --flag")).toBe(`node '${real}/x.mjs' --flag`);
    expect(workspace.mapCommand('node "/Users/agent/workspace/x.mjs" https://x/pull/1'))
      .toBe(`node "${real}/x.mjs" https://x/pull/1`);
    expect(workspace.mapCommand("echo '/Users/agent/workspace'")).toBe(`echo '${real}'`);
    await executor.close();
  });

  it('maps the complete quoted Windows script path after a directory containing spaces', async () => {
    const virtual = 'C:\\Agent\\workspace';
    const { workspace, project, executor } = setup(virtual);
    const script = path.win32.join(virtual, '目录 空格', 'skill', 'probe.cjs');
    const mapped = project.replace(/\\/g, '/') + '/目录 空格/skill/probe.cjs';
    expect(workspace.mapCommand('node "' + script + '" && echo "/other/file"'))
      .toBe('node "' + mapped + '" && echo "/other/file"');
    await executor.close();
  });

  // 2026-10 实际问题：Agent 在 Windows、任务在 Mac 时，Agent 按 bash 规矩把双引号里的反斜杠写成两个，
  // 命令原样送到 Mac 执行而找不到目录。
  it('maps bash-escaped Windows virtual paths in commands and Agent text', async () => {
    const virtual = 'C:\\Agent\\workspace';
    const { workspace, project, executor } = setup(virtual);
    const real = project.replace(/\\/g, '/');
    const escaped = virtual.replace(/\\/g, '\\\\');
    expect(workspace.mapCommand('ls "' + escaped + '\\\\目录 空格\\\\a.txt"'))
      .toBe('ls "' + real + '/目录 空格/a.txt"');
    expect(workspace.mapCommand('cd ' + escaped + '\\\\src && ls')).toBe("cd '" + real + "'/src && ls");
    expect(workspace.mapCommand("cat '" + escaped + "\\\\src'")).toBe("cat '" + real + "/src'");
    // 后面不是目录名的 `\\` 仍是转义，原样留给 shell。
    expect(workspace.mapCommand('printf "%s" "' + escaped + '\\\\dir\\\\"'))
      .toBe('printf "%s" "' + real + '/dir\\\\"');
    // 回复正文同样还原；本机是 Windows 时保留 Agent 的转义写法。
    const local = process.platform === 'win32'
      ? project.replace(/\\/g, '\\\\') + '\\\\src\\\\a.txt'
      : project + '/src/a.txt';
    expect(workspace.mapTextFromAgent('见 "' + escaped + '\\\\src\\\\a.txt"')).toBe('见 "' + local + '"');
    await executor.close();
  });

  it('does not treat the leading backslashes of a network share path as an escaped separator', () => {
    const aliases = [{ from: '//server/share/project', to: 'C:\\Agent\\workspace' }];
    // 本机 → Agent：不认转义写法的方向保持原行为。
    expect(projectPathText('cat \\\\server\\share\\project\\file', aliases)).toBe('cat C:\\Agent\\workspace\\file');
    // Agent → 本机方向即使认转义，UNC 开头的 `\\server` 也不是转义。
    expect(projectPathText('cat \\\\server\\share\\project\\file', aliases, 'text', undefined, { escapedSeparators: true }))
      .toBe('cat C:\\Agent\\workspace\\file');
  });

  it.skipIf(process.platform === 'win32')('keeps Windows paths in local output intact when the task computer uses POSIX paths', () => {
    const mirror = 'C:\\Users\\XD\\AppData\\Roaming\\Cindy\\remote-agent\\workspaces\\c\\s\\fs';
    const shadow = mirror + '\\workspace\\p\\p';
    const workspace = new ExecutorWorkspace({
      workingDir: '/Users/xw/heartopia',
      aliases: [
        { from: shadow, to: '/Users/xw/heartopia' },
        { from: mirror + '\\workspace\\p', to: '/Users/xw' },
        { from: mirror + '\\workspace', to: '/Users' },
      ],
    });
    workspace.setVirtualRoot(mirror);
    // Mac 上的报错带着没能还原的 Windows 路径：`\Users`、`C:/Users` 不是本机的 /Users，不能再被投影一遍。
    const error = 'ls: C:\\Users\\XD\\AppData\\Roaming\\Cindy\\x: No such file or directory';
    expect(workspace.mapTextForAgent(error)).toBe(error);
    expect(workspace.mapTextForAgent('cat C:/Users/XD/notes.txt')).toBe('cat C:/Users/XD/notes.txt');
    // 真正的本机路径照常投影成 Agent 那边的路径。
    expect(workspace.mapTextForAgent('ls /Users/xw/heartopia/src')).toBe('ls ' + shadow + '\\src');
  });

  it.each([
    '$file', '$' + '{file}', '$(printf "%s" "$file")', String.fromCharCode(96) + 'printf "%s" "$file"' + String.fromCharCode(96), '\\$file', '\\"quoted\\"', '*.txt',
  ])('preserves Bash syntax in a quoted POSIX path suffix: %s', (expression) => {
    const { project, workspace } = setup('/Users/agent/workspace');
    const real = project.replace(/\\/g, '/');
    const suffix = '/目录 空格/' + expression;
    expect(workspace.mapCommand('cat "/Users/agent/workspace' + suffix + '"'))
      .toBe('cat "' + real + suffix + '"');
  });

  it('preserves unquoted Bash expansions and quoted cmd variables after the mapped prefix', () => {
    const { project, workspace } = setup('/Users/agent/workspace');
    const real = project.replace(/\\/g, '/');
    expect(workspace.mapCommand('cat /Users/agent/workspace/$file/*.txt'))
      .toBe("cat '" + real + "'/$file/*.txt");
    expect(workspace.mapCommand('cat "/Users/agent/workspace/目录 空格/%file%"', 'cmd'))
      .toBe('cat "' + real + '/目录 空格/%file%"');
  });

  it('maps the Windows literal path before a Bash expansion without rewriting substitution contents', () => {
    const virtual = 'C:\\Agent\\workspace';
    const { project, workspace } = setup(virtual);
    const expression = '$(printf "\\\\n%s" "$file")';
    const command = 'cat "' + path.win32.join(virtual, '目录 空格') + '/' + expression + '"';
    expect(workspace.mapCommand(command))
      .toBe('cat "' + project.replace(/\\/g, '/') + '/目录 空格/' + expression + '"');
  });

  it.each(['\\"; printf UNEXPECTED; #', '\\\\\\"; printf UNEXPECTED; #', '\\$file', '\\' + String.fromCharCode(96) + 'literal'])('preserves shell escapes after a spaced Windows path: %s', (suffix) => {
    const virtual = 'C:\\Agent\\workspace';
    const { project, workspace } = setup(virtual);
    const command = 'printf \'%s\\n\' "' + virtual + '\\dir space\\safe' + suffix + '"';
    expect(workspace.mapCommand(command))
      .toBe('printf \'%s\\n\' "' + project.replace(/\\/g, '/') + '/dir space/safe' + suffix + '"');
  });

  it.skipIf(resolveExecutorShell().dialect !== 'bash')('keeps escaped command-looking text in one Bash argument after mapping', async () => {
    const virtual = 'C:\\Agent\\workspace';
    const { project, workspace } = setup(virtual);
    const command = 'printf \'<%s>\\n\' "' + virtual + '\\dir space\\safe\\"; printf UNEXPECTED; #"';
    const result = await runOnce(command + '\n' + workspace.mapCommand(command), { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString('utf8'))
      .toBe('<' + virtual + '\\dir space\\safe"; printf UNEXPECTED; #>\n'
        + '<' + project.replace(/\\/g, '/') + '/dir space/safe"; printf UNEXPECTED; #>\n');
  });

  it.each([
    { from: '/real/project', to: 'C:\\Agent\\workspace', source: path.posix, target: path.win32 },
    { from: 'C:\\Agent\\workspace', to: '/real/project', source: path.win32, target: path.posix },
  ])('maps each path token from $from without changing surrounding text', ({ from, to, source, target }) => {
    const aliases = [{ from, to }];
    const first = source.join(from, 'README.md');
    const second = source.join(from, 'src', 'b.ts');
    const mappedFirst = target.join(to, 'README.md');
    const mappedSecond = target.join(to, 'src', 'b.ts');
    expect(projectPathText(first + ' ' + second, aliases)).toBe(mappedFirst + ' ' + mappedSecond);
    expect(projectPathText(first + ' links to /api/v1 and C:\\other\\file.txt', aliases))
      .toBe(mappedFirst + ' links to /api/v1 and C:\\other\\file.txt');
    const document = JSON.stringify({ text: first + ' links to /api/v1', path: source.join(from, '目录 空格', 'a.ts') });
    expect(projectPathText(document, aliases)).toBe(JSON.stringify({ text: mappedFirst + ' links to /api/v1', path: target.join(to, '目录 空格', 'a.ts') }));
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('maps text file bytes token by token on input and output at %s', (virtual) => {
    const { project, workspace } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const input = Buffer.from(native.join(virtual, 'a.ts') + ' ' + native.join(virtual, 'src', 'b.ts') + ' links to /api/v1');
    const real = Buffer.from(written(path.join(project, 'a.ts'), virtual) + ' ' + written(path.join(project, 'src', 'b.ts'), virtual) + ' links to /api/v1');
    expect(workspace.mapInputFromAgent(input)).toEqual(real);
    expect(workspace.mapOutputForAgent(real)).toEqual(input);
    const quoted = 'The docs say "' + native.join(virtual, 'README.md') + ' links to /api/v1"';
    expect(workspace.mapInputFromAgent(Buffer.from(quoted)))
      .toEqual(Buffer.from('The docs say "' + written(path.join(project, 'README.md'), virtual) + ' links to /api/v1"'));
  });

  it.each([
    { from: '/home/agent/workspace', to: 'C:\\real\\project', source: path.posix, target: path.win32 },
    { from: 'C:\\Agent\\workspace', to: '/real/project', source: path.win32, target: path.posix },
  ])('keeps prose in JSON scalars and untyped arrays from $from', ({ from, to, source, target }) => {
    const document = (directory: string, native: typeof path.win32) => {
      const first = native.join(directory, 'README.md');
      return [first + ' links to /api/v1', first + ' relative/input.txt', first + ' ' + native.join(directory, 'src', 'a.ts')];
    };
    const original = document(from, source);
    const expected = document(to, target);
    const aliases = [{ from, to }];
    for (let index = 0; index < original.length; index += 1) {
      expect(projectPathText(JSON.stringify(original[index]), aliases)).toBe(JSON.stringify(expected[index]));
    }
    expect(projectPathText(JSON.stringify([original, { text: original[0] }, JSON.stringify(original)]), aliases))
      .toBe(JSON.stringify([expected, { text: expected[0] }, JSON.stringify(expected)]));
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('writes and reads JSON prose without changing non-path bytes at %s', async (virtual) => {
    const { project, executor } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const prose = native.join(virtual, 'README.md') + ' links to /api/v1 and relative/input.txt';
    const localProse = written(path.join(project, 'README.md'), virtual) + ' links to /api/v1 and relative/input.txt';
    const documents = (value: string) => [
      JSON.stringify(value),
      '[\r\n  ' + JSON.stringify(value) + ', [' + JSON.stringify(value) + '], 1.00e0, "\\u4e2d"\r\n]\r\n',
      JSON.stringify(JSON.stringify([value])),
    ];
    const input = documents(prose);
    const expected = documents(localProse);
    try {
      for (let index = 0; index < input.length; index += 1) {
        const file = native.join(virtual, 'prose-' + index + '.json');
        await executor.handle('fs.write', { path: file, data: Buffer.from(input[index]).toString('base64') });
        expect(fs.readFileSync(path.join(project, 'prose-' + index + '.json'), 'utf8')).toBe(expected[index]);
        const read = await executor.handle('fs.read', { path: file }) as { data: string };
        expect(Buffer.from(read.data, 'base64').toString('utf8')).toBe(input[index]);
      }
    } finally {
      await executor.close();
    }
  });

  it('escapes regex metacharacters and backslash path separators without matching other prefixes', () => {
    const from = 'C:\\Agent\\project[1].(data)$';
    const text = path.win32.join(from, 'src', 'a.ts') + ' C:\\Agent\\project1xdata\\src\\b.ts';
    expect(projectPathText(text, [{ from, to: '/real/project' }]))
      .toBe('/real/project/src/a.ts C:\\Agent\\project1xdata\\src\\b.ts');
    expect(projectPathText('"/REAL/project/a.ts"', [{ from: '/real/project', to: '/virtual/project' }], 'path'))
      .toBe('"/REAL/project/a.ts"');
  });

  it.each([
    { from: '/home/agent/workspace', to: 'C:\\real\\project', source: path.posix, target: path.win32 },
    { from: 'C:\\Agent\\workspace', to: '/real/project', source: path.win32, target: path.posix },
  ])('projects JSON scalar paths and inherited path arrays from $from', ({ from, to, source, target }) => {
    const originalPath = source.join(from, '目录 空格', 'a.txt');
    const mappedPath = target.join(to, '目录 空格', 'a.txt');
    const aliases = [{ from, to }];
    // 纯跨平台用例注入已确认的路径；下面的真实文件回归验证存在性判据。
    const isCompletePath = (mapped: string) => mapped === mappedPath;
    expect(projectPathText(JSON.stringify(originalPath), aliases, 'text', isCompletePath)).toBe(JSON.stringify(mappedPath));
    expect(projectPathText(JSON.stringify([originalPath, [originalPath]]), aliases, 'text', isCompletePath)).toBe(JSON.stringify([mappedPath, [mappedPath]]));
    const prose = source.join(from, 'README.md') + ' links to /api/v1';
    const mappedProse = target.join(to, 'README.md') + ' links to /api/v1';
    const original = { paths: [originalPath, [originalPath]], nested: { file_paths: [originalPath] }, text: prose, messages: [prose] };
    const mapped = { paths: [mappedPath, [mappedPath]], nested: { file_paths: [mappedPath] }, text: mappedProse, messages: [mappedProse] };
    expect(projectPathText(JSON.stringify(original), aliases)).toBe(JSON.stringify(mapped));
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('round-trips confirmed JSON paths and keeps future paths in explicit fields at %s', (virtual) => {
    const { project, workspace } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const local = path.join(project, '目录 空格', 'a.txt');
    fs.mkdirSync(path.dirname(local));
    fs.writeFileSync(local, 'existing file');
    const remote = native.join(virtual, '目录 空格', 'a.txt');
    const localFuture = path.join(project, '尚未 创建', 'future.txt');
    const remoteFuture = native.join(virtual, '尚未 创建', 'future.txt');
    const values = (file: string, directory: string, future: string) => [
      file, [file, [directory]], { paths: [future, [future]], nested: { file_paths: [future] } },
    ];
    const input = values(remote, native.dirname(remote), remoteFuture);
    const expected = values(written(local, virtual), written(path.dirname(local), virtual), written(localFuture, virtual));
    expect(fs.existsSync(localFuture)).toBe(false);
    for (let index = 0; index < input.length; index += 1) {
      const remoteBytes = Buffer.from(JSON.stringify(input[index]));
      const localBytes = Buffer.from(JSON.stringify(expected[index]));
      expect(workspace.mapInputFromAgent(remoteBytes)).toEqual(localBytes);
      expect(workspace.mapOutputForAgent(localBytes)).toEqual(remoteBytes);
    }
  });

  it.each([
    { from: '/home/agent/workspace', to: 'C:\\real\\project', source: path.posix, target: path.win32 },
    { from: 'C:\\Agent\\workspace', to: '/real/project', source: path.win32, target: path.posix },
  ])('preserves quoted prose and maps every embedded path token from $from', ({ from, to, source, target }) => {
    const first = source.join(from, 'README.md');
    const second = source.join(from, 'src', 'a.ts');
    const original = 'The docs say "' + first + ' links to /api/v1 and ' + second + '"';
    const mapped = 'The docs say "' + target.join(to, 'README.md') + ' links to /api/v1 and ' + target.join(to, 'src', 'a.ts') + '"';
    expect(projectPathText(original, [{ from, to }])).toBe(mapped);
    expect(projectPathText(JSON.stringify([original]), [{ from, to }])).toBe(JSON.stringify([mapped]));
  });

  it.each(['/home/agent/workspace', 'C:\\Agent\\workspace'])('treats script fields as source unless they are existing complete paths at %s', (virtual) => {
    const { project, workspace } = setup(virtual);
    const native = virtual.startsWith('C:') ? path.win32 : path.posix;
    const existing = path.join(project, '目录 空格', 'run.js');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'console.log(1);');
    const existingVirtual = native.join(virtual, '目录 空格', 'run.js');
    const source = JSON.stringify({ script: native.join(virtual, 'run.js') + ' --url /api/v1' });
    const sourceExpected = JSON.stringify({ script: written(path.join(project, 'run.js'), virtual) + ' --url /api/v1' });
    expect(workspace.mapInputFromAgent(Buffer.from(source))).toEqual(Buffer.from(sourceExpected));
    const pathValue = JSON.stringify({ script: existingVirtual });
    const pathExpected = JSON.stringify({ script: written(existing, virtual) });
    expect(workspace.mapInputFromAgent(Buffer.from(pathValue))).toEqual(Buffer.from(pathExpected));
    expect(workspace.mapOutputForAgent(Buffer.from(pathExpected))).toEqual(Buffer.from(pathValue));
  });

  it('maps Codex request paths and commands before permission checks and projects text file bytes', async () => {
    const { workspace, project, executor } = setup('/Users/agent/workspace');
    const params = mapExecServerParams({ path: 'file:///Users/agent/workspace/a.txt', dataBase64: Buffer.from(project).toString('base64') }, workspace);
    expect(params).toEqual({ path: pathToFileURL(path.join(project, 'a.txt')).href, dataBase64: Buffer.from(project).toString('base64') });
    expect(execServerActions('fs/writeFile', params, project)).toEqual([{ kind: 'write', path: path.join(project, 'a.txt') }]);
    const result = mapExecServerResult({ result: { cwd: pathToFileURL(project).href } }, workspace);
    expect(JSON.stringify(result)).toContain('file:///Users/agent/workspace');
    const output = mapExecServerResult({ method: 'process/output', params: { chunk: Buffer.from(project).toString('base64') } }, workspace) as any;
    expect(Buffer.from(output.params.chunk, 'base64').toString()).toBe('/Users/agent/workspace');
    const fileData = { result: { dataBase64: Buffer.from(project).toString('base64') } };
    expect(Buffer.from((mapExecServerResult(fileData, workspace) as any).result.dataBase64, 'base64').toString()).toBe(project);
    await executor.close();
  });

  it('projects Cindy MCP path arguments and JSON/SSE results while leaving file content arguments intact', async () => {
    const { workspace, project, executor } = setup('/Users/agent/workspace');
    let received: any;
    for (const sse of [false, true]) {
      const router = createReverseHttpRouter({
        executor,
        mcpTarget: () => ({ url: 'http://unused', headers: {} }),
        fetch: async (_url, options) => {
          received = JSON.parse(Buffer.from(options!.body as Uint8Array).toString());
          const result = { result: { content: [{ type: 'text', text: 'File: ' + path.join(project, 'a.txt') }], file: pathToFileURL(path.join(project, 'a.txt')).href } };
          return new Response(sse ? 'data: ' + JSON.stringify(result) + '\n\n' : JSON.stringify(result), {
            headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
          });
        },
      });
      const reply = await router({ method: 'POST', path: '/mcp/cindy_helper', headers: [], body: Buffer.from(JSON.stringify({
        method: 'tools/call', params: { name: 'file_tool', arguments: { path: '/Users/agent/workspace/a.txt', content: '/Users/agent/workspace' } },
      })).toString('base64') });
      expect(received.params.arguments.path).toBe(path.join(project, 'a.txt'));
      expect(received.params.arguments.content).toBe('/Users/agent/workspace');
      expect(reply.type).toBe('http');
      if (reply.type === 'http') {
        const body = Buffer.from(reply.body!, 'base64').toString();
        expect(body).toContain('/Users/agent/workspace/a.txt');
        expect(body).toContain('file:///Users/agent/workspace/a.txt');
        expect(body).not.toContain(project.replace(/\\/g, '\\\\'));
      }
    }
    await executor.close();
  });

  it.each([
    { virtual: '/home/agent/workspace', sse: false },
    { virtual: '/home/agent/workspace', sse: true },
    { virtual: 'C:\\Agent\\workspace', sse: false },
    { virtual: 'C:\\Agent\\workspace', sse: true },
  ])('preserves structured MCP path fields and nested arrays at $virtual (SSE=$sse)', async ({ virtual, sse }) => {
    const { project, executor } = setup(virtual);
    const agentPath = virtual.startsWith('C:') ? path.win32 : path.posix;
    const realFile = path.join(project, '目录 空格', 'deep', 'report.txt');
    const virtualFile = agentPath.join(virtual, '目录 空格', 'deep', 'report.txt');
    const prose = path.join(project, 'README.md') + ' links to /api/v1 and relative/input.txt';
    const virtualProse = agentPath.join(virtual, 'README.md') + ' links to /api/v1 and relative/input.txt';
    const structuredContent = {
      path: realFile,
      paths: [realFile, [realFile], { path: realFile, text: prose }],
      nested: { file_path: realFile, filePath: realFile, working_dir: path.dirname(realFile) },
      text: prose,
      enabled: true, count: 1, optional: null,
    };
    const response = { jsonrpc: '2.0', id: 1, result: {
      structuredContent, content: [{ type: 'text', text: JSON.stringify({ path: realFile }) }, { type: 'text', text: prose }],
    } };
    const router = createReverseHttpRouter({
      executor,
      mcpTarget: () => ({ url: 'http://unused', headers: {} }),
      fetch: async () => new Response(sse ? 'data: ' + JSON.stringify(response) + '\n\n' : JSON.stringify(response), {
        headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
      }),
    });
    try {
      const reply = await router({ method: 'POST', path: '/mcp/cindy_helper', headers: [], body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'path_probe', arguments: {} },
      })).toString('base64') });
      if (reply.type !== 'http') throw new Error('expected MCP HTTP reply');
      const body = Buffer.from(reply.body!, 'base64').toString();
      expect(JSON.parse(sse ? body.split('\n')[0].slice(6) : body)).toEqual({
        jsonrpc: '2.0', id: 1, result: {
          structuredContent: {
            ...structuredContent,
            path: virtualFile,
            paths: [virtualFile, [virtualFile], { path: virtualFile, text: virtualProse }],
            nested: { file_path: virtualFile, filePath: virtualFile, working_dir: agentPath.dirname(virtualFile) },
            text: virtualProse,
          },
          content: [{ type: 'text', text: JSON.stringify({ path: virtualFile }) }, { type: 'text', text: virtualProse }],
        },
      });
    } finally {
      await executor.close();
    }
  });

  it.each([
    { virtual: '/Users/agent/workspace', sse: false },
    { virtual: '/Users/agent/workspace', sse: true },
    { virtual: '/home/agent/workspace', sse: false },
    { virtual: '/home/agent/workspace', sse: true },
    { virtual: 'C:\\Agent\\workspace', sse: false },
    { virtual: 'C:\\Agent\\workspace', sse: true },
  ])('returns a usable current directory to the Agent at $virtual (SSE=$sse)', async ({ virtual, sse }) => {
    const { workspace, project, executor, gate } = setup(virtual);
    const context = { sessionId: 'local-task', agentKind: 'codex' as const, workingDir: project };
    const registry = new XdtHelperToolRegistry();
    registerGetCurrentSessionIdTool(registry, { getSessionContext: () => context });
    let receivedDirectory: string | undefined;
    registry.register({
      name: 'workspace_probe', category: 'cindy', description: 'Read the current directory on the task computer.',
      inputShape: { working_dir: z.string() },
      handler: async ({ working_dir }) => {
        receivedDirectory = working_dir;
        expect(gate.authorize({ kind: 'read', path: working_dir }).ok).toBe(true);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: fs.statSync(working_dir).isDirectory(), working_dir,
        }) }] };
      },
    });
    const router = createReverseHttpRouter({
      executor,
      mcpTarget: () => ({ url: 'http://unused', headers: {} }),
      fetch: async (_url, options) => {
        const request = JSON.parse(Buffer.from(options!.body as Uint8Array).toString());
        const rawArgs = request.params.arguments.args;
        // The real MCP entry schema applies jsonObjectArg's stringified-JSON
        // preprocessing before dispatching to the registry. Mirror that here
        // so this router regression exercises the same downstream boundary.
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        const result = await registry.call(request.params.arguments.name, args);
        const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
        return new Response(sse ? 'data: ' + message + '\n\n' : message, {
          headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
        });
      },
    });
    const call = async (name: string, args: Record<string, unknown> | string) => {
      const reply = await router({ method: 'POST', path: '/mcp/cindy_helper', headers: [], body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name, args } },
      })).toString('base64') });
      if (reply.type !== 'http') throw new Error('expected MCP HTTP reply');
      const body = Buffer.from(reply.body!, 'base64').toString();
      const message = JSON.parse(sse ? body.split('\n')[0].slice(6) : body);
      expect(message.result.isError).not.toBe(true);
      return JSON.parse(message.result.content[0].text);
    };
    try {
      const current = await call('get_current_session_id', {});
      expect(current).toEqual({ ok: true, session_id: 'local-task', agent_kind: 'codex', working_dir: virtual });
      expect(await call('workspace_probe', { working_dir: current.working_dir })).toEqual({ ok: true, working_dir: virtual });
      expect(await call('workspace_probe', JSON.stringify({ working_dir: virtual }))).toEqual({ ok: true, working_dir: virtual });
      expect(receivedDirectory).toBe(project);
      expect(context.workingDir).toBe(project);
      expect(workspace.workingDir).toBe(project);
    } finally {
      await executor.close();
    }
  });

  it('restores helper, plugin and document path parameters while preserving their content and media identifiers', async () => {
    const virtual = '/Users/agent/workspace';
    const { project, executor } = setup(virtual);
    let received: Record<string, unknown> | undefined;
    const content = JSON.stringify({ path: virtual });
    const router = createReverseHttpRouter({
      executor,
      mcpTarget: () => ({ url: 'http://unused', headers: {} }),
      fetch: async (_url, options) => {
        received = JSON.parse(Buffer.from(options!.body as Uint8Array).toString()).params.arguments;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      await router({ method: 'POST', path: '/mcp/cindy', headers: [], body: Buffer.from(JSON.stringify({
        method: 'tools/call', params: { name: 'example', arguments: {
          workdir: virtual, dir: virtual, save_dir: virtual,
          extra_dirs: [virtual], writableDirs: [virtual],
          attachments: [virtual + '/image.png', 'cindy-media://blobs/abc.png', 'xdt-image://task/image.png'],
          args: { working_dir: virtual, file_path: virtual + '/file.txt', outPath: virtual + '/out.pdf', htmlPath: virtual + '/in.html', imagePath: virtual + '/image.png' },
          workers: [{ working_dir: virtual }],
          out_file: virtual + '/result.json', absPath: virtual + '/upload.txt',
          workspace_root: virtual, anchorFile: virtual + '/index.ts', file_paths: [virtual + '/input.txt'],
          content, text: virtual,
        } },
      })).toString('base64') });
      expect(received).toEqual({
        workdir: project, dir: project, save_dir: project,
        extra_dirs: [project], writableDirs: [project],
        attachments: [path.join(project, 'image.png'), 'cindy-media://blobs/abc.png', 'xdt-image://task/image.png'],
        args: { working_dir: project, file_path: path.join(project, 'file.txt'), outPath: path.join(project, 'out.pdf'), htmlPath: path.join(project, 'in.html'), imagePath: path.join(project, 'image.png') },
        workers: [{ working_dir: project }],
        out_file: path.join(project, 'result.json'), absPath: path.join(project, 'upload.txt'),
        workspace_root: project, anchorFile: path.join(project, 'index.ts'), file_paths: [path.join(project, 'input.txt')],
        content, text: virtual,
      });
    } finally {
      await executor.close();
    }
  });

  it.each(['/Users/agent/workspace', 'C:\\Agent\\workspace'].flatMap((virtual) => [
    { virtual, name: 'start_recording', key: 'output_dir', args: { record_video: true } },
    { virtual, name: 'get_window_state', key: 'screenshot_out_file', args: { pid: 123, window_id: 7 } },
    { virtual, name: 'click', key: 'debug_image_out', args: { pid: 123, window_id: 7, x: 10, y: 20 } },
  ]))('restores $name ($key) at $virtual before the real Computer MCP path guard', async ({ virtual, name, key, args }) => {
    const { project, executor } = setup(virtual);
    const agentPath = virtual.startsWith('C:') ? path.win32 : path.posix;
    const callTool = vi.fn(async () => ({ ok: true }));
    const server = createComputerMcpServer({ getStatus: vi.fn(), callTool }, {
      getSessionContext: () => ({ sessionId: 'local-task', agentKind: 'codex', workingDir: project }),
    });
    const client = new Client({ name: 'remote-path-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const router = createReverseHttpRouter({
      executor,
      mcpTarget: () => ({ url: 'http://unused', headers: {} }),
      fetch: async (_url, options) => {
        const request = JSON.parse(Buffer.from(options!.body as Uint8Array).toString());
        const result = await client.callTool({ name: request.params.name, arguments: request.params.arguments });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const invoke = async (output: string) => {
      const reply = await router({ method: 'POST', path: '/mcp/cindy_computer', headers: [], body: Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name, args: { ...args, [key]: output } } },
      })).toString('base64') });
      if (reply.type !== 'http') throw new Error('expected MCP HTTP reply');
      const result = JSON.parse(Buffer.from(reply.body!, 'base64').toString());
      return JSON.parse(result.result.content[0].text);
    };
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect(await invoke(agentPath.join(virtual, '输出 目录', 'capture'))).toMatchObject({ ok: true });
      expect(callTool).toHaveBeenCalledWith(name, expect.objectContaining({
        ...args, [key]: path.join(project, '输出 目录', 'capture'), session: 'local-task',
      }), expect.objectContaining({ sessionId: 'local-task' }));
      callTool.mockClear();
      // 保留别名前缀中的 ..，确认先还原再由本机工具的真实权限边界拒绝。
      expect(await invoke(virtual + agentPath.sep + '..' + agentPath.sep + 'outside'))
        .toMatchObject({ ok: false, errorCode: 'PATH_NOT_ALLOWED' });
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await executor.close();
    }
  });

  it('maps workbench project paths in direct and stringified generic-tool arguments', async () => {
    const virtual = '/Users/agent/workspace';
    const { project, executor } = setup(virtual);
    const forwarded: Array<Record<string, unknown>> = [];
    const router = createReverseHttpRouter({
      executor,
      mcpTarget: () => ({ url: 'http://unused', headers: {} }),
      fetch: async (_url, options) => {
        const request = JSON.parse(Buffer.from(options!.body as Uint8Array).toString()) as { params: { arguments: Record<string, unknown> } };
        forwarded.push(request.params.arguments);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    try {
      for (const args of [
        { project: virtual },
        JSON.stringify({ project: virtual }),
        { items: [{ project: virtual }] },
      ]) {
        await router({ method: 'POST', path: '/mcp/cindy_helper', headers: [], body: Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: {
            name: args && typeof args === 'object' && !Array.isArray(args) && 'items' in args ? 'set_workbench_tasks' : 'set_workbench_task', args,
          } },
        })).toString('base64') });
      }
      expect(forwarded).toEqual([
        { name: 'set_workbench_task', args: { project } },
        { name: 'set_workbench_task', args: JSON.stringify({ project }) },
        { name: 'set_workbench_tasks', args: { items: [{ project }] } },
      ]);
    } finally {
      await executor.close();
    }
  });

  it.each(['/Users/agent/workspace', 'C:\\Agent\\workspace'])('runs a Skill script in the real directory and returns JSON paths at %s', async (virtual) => {
    const { project, executor } = setup(virtual);
    const agentPath = virtual.startsWith('C:') ? path.win32 : path.posix;
    const fixtureDir = path.join(project, '目录 空格');
    const virtualDir = agentPath.join(virtual, '目录 空格');
    const script = path.join(fixtureDir, 'skill', 'probe.cjs');
    const virtualScript = agentPath.join(virtualDir, 'skill', 'probe.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const result = { cwd: process.cwd(), script: __filename, argument: path.resolve(process.argv[2]) };',
      'fs.writeFileSync("native-result.json", JSON.stringify(result));',
      'console.log("Running Skill script");',
      'console.log(JSON.stringify(result));',
    ].join('\n'));
    try {
      const result = await executor.handle('exec.run', {
        command: 'node "' + virtualScript + '" "' + virtual + '"', cwd: virtualDir,
      }) as { output: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      const output = Buffer.from(result.output, 'base64').toString();
      const lines = output.trim().split(/\r?\n/);
      expect(lines[0]).toBe('Running Skill script');
      expect(JSON.parse(lines[1])).toEqual({ cwd: virtualDir, script: virtualScript, argument: virtual });
      const nativeResult = { cwd: fixtureDir, script, argument: project };
      const actualNative = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'native-result.json'), 'utf8')) as typeof nativeResult;
      expect(actualNative).toEqual({ cwd: expect.any(String), script, argument: project });
      expect(fs.realpathSync.native(actualNative.cwd)).toBe(fs.realpathSync.native(fixtureDir));
      await executor.handle('fs.write', { path: agentPath.join(virtualDir, 'returned.json'), data: Buffer.from(lines[1]).toString('base64') });
      expect(JSON.parse(fs.readFileSync(path.join(fixtureDir, 'returned.json'), 'utf8'))).toEqual({
        cwd: written(fixtureDir, virtual), script: written(script, virtual), argument: written(project, virtual),
      });
    } finally {
      await executor.close();
    }
  });
});
