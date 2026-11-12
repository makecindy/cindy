/**
 * 远程供应商的文件读写与引用：Agent 看到的虚拟路径、它写进文件和回复里的路径、命令与文件操作实际
 * 落盘的位置必须是同一个地方；没改动的文件内容写回后逐字节不变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { Link, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mapClaudeHostedEvent } from '../../controller/eventMap';
import { RemoteEventProjection } from '../../controller/eventProjection';
import { mapExecServerParams } from '../../controller/execServerRelay';
import { createRemoteAgentHandle } from '../../controller/proxyHandle';
import type { RemoteAgentRunClient } from '../../controller/runClient';
import { RemoteExecutor } from '../executor';
import { ExecutorGate } from '../gate';
import { ExecutorWorkspace } from '../workspace';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-path-fidelity-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const VIRTUAL_ROOT = '/Users/agent/Library/Application Support/Cindy/remote-agent/workspaces/0123456789abcdef/run/fs';
const SHADOW = VIRTUAL_ROOT + '/workspace/p/p';
const PARENT = VIRTUAL_ROOT + '/workspace/p';

/** 与控制端 shadowAliases 一致：工作目录和它的上级目录各对应一个虚拟目录。 */
function setup(workingDir = path.join(root, 'fp2', 'flash-party-retro')) {
  fs.mkdirSync(workingDir, { recursive: true });
  const parent = path.dirname(workingDir);
  const workspace = new ExecutorWorkspace({ workingDir, aliases: [{ from: SHADOW, to: workingDir }, { from: PARENT, to: parent }] });
  workspace.setVirtualRoot(VIRTUAL_ROOT);
  const executor = new RemoteExecutor({ workspace, gate: new ExecutorGate(workspace, 'full'), rgPath: 'unused' });
  return { parent, workingDir, workspace, executor };
}

/** Agent 写的 `/` 路径还原到本机时的写法(Windows 上沿用 `/`)。 */
const agentStyle = (local: string) => local.replace(/\\/g, '/');

function markdownLinks(markdown: string): string[] {
  const urls: string[] = [];
  visit(unified().use(remarkParse).parse(markdown) as Root, 'link', (node: Link) => { urls.push(node.url); });
  return urls;
}

function readBack(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? '').join('').split('\n').map((line) => line.replace(/^\s*\d+\t/, '')).join('\n');
}

describe('remote provider file paths', () => {
  it.each(['flash-party-retro.git', 'flash-party-retro-v1'])('keeps the sibling folder %s apart from the workspace everywhere', async (sibling) => {
    const { parent, workspace, executor } = setup();
    const real = path.join(parent, sibling, 'fp-devlog', 'v20', '验收报告.html');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    try {
      // Agent 看到的是按完整目录段换算的路径，不会把 `flash-party-retro` 当成 `.git` 目录的前缀。
      const seen = workspace.mapTextForAgent('report: ' + real).slice('report: '.length);
      expect(seen).toBe(PARENT + '/' + sibling + '/fp-devlog/v20/验收报告.html');
      expect(workspace.resolve(seen)).toBe(real);
      await executor.callTool('Write', { file_path: seen, content: 'v20' });
      expect(fs.readFileSync(real, 'utf8')).toBe('v20');
      expect(fs.readdirSync(parent).sort()).toEqual(['flash-party-retro', sibling].sort());
      // 回复里的链接和命令里的路径指向写文件的同一处。
      const [link] = markdownLinks(workspace.mapTextFromAgent('请你验收：[报告](<' + seen + '>)'));
      expect(fs.readFileSync(link, 'utf8')).toBe('v20');
      expect(workspace.mapCommand('cat "' + seen + '"')).toBe('cat "' + agentStyle(real) + '"');
      // 以前把它投影成 `…/p.git` 的旧会话里，同一个写法在文字、命令和文件操作中也落在同一处。
      const legacy = SHADOW + sibling.slice('flash-party-retro'.length) + '/a.txt';
      const literal = path.join(parent, 'p' + sibling.slice('flash-party-retro'.length), 'a.txt');
      expect(workspace.resolve(legacy)).toBe(literal);
      expect(workspace.mapTextFromAgent(legacy)).toBe(agentStyle(literal));
    } finally {
      await executor.close();
    }
  });

  it('checks the disk before treating a space or bracket after the workspace as the end of the path', async () => {
    const { parent, workingDir, workspace, executor } = setup();
    try {
      for (const name of ['flash-party-retro copy', 'flash-party-retro (1)']) {
        const real = path.join(parent, name, 'a.txt');
        fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, name);
        const seen = workspace.mapTextForAgent(real);
        expect(seen.startsWith(PARENT + '/flash-party-retro')).toBe(true);
        expect(workspace.resolve(seen)).toBe(real);
      }
      // 没有这样的同级目录时，空格、标点后面就是正文。
      expect(workspace.mapTextForAgent(workingDir + ' is ready, ' + workingDir + '. Done')).toBe(SHADOW + ' is ready, ' + SHADOW + '. Done');
      const local = agentStyle(workingDir);
      expect(workspace.mapTextFromAgent('在 ' + SHADOW + '。见 `' + SHADOW + '/src/a.ts:12`, ' + SHADOW + '.'))
        .toBe('在 ' + local + '。见 `' + local + '/src/a.ts:12`, ' + local + '.');
    } finally {
      await executor.close();
    }
  });

  it('keeps shell expansions immediately after a mapped directory prefix', async () => {
    const { workingDir, workspace, executor } = setup();
    try {
      const local = agentStyle(workingDir);
      for (const suffix of ['*', '?', '[ab]', '{a,b}', '$suffix', '${suffix}', '$' + '(printf x)', String.fromCharCode(96) + 'printf x' + String.fromCharCode(96)]) {
        expect(workspace.mapCommand('ls ' + SHADOW + suffix)).toBe('ls ' + local + suffix);
      }
      for (const suffix of ['$suffix', '${suffix}']) {
        expect(workspace.mapCommand('ls "' + SHADOW + suffix + '"')).toBe('ls "' + local + suffix + '"');
      }
      for (const suffix of ['%SUFFIX%', '!SUFFIX!']) {
        expect(workspace.mapCommand('dir "' + SHADOW + suffix + '"', 'cmd')).toBe('dir "' + local + suffix + '"');
      }
      for (const quote of ['', '"']) {
        for (const variable of ['PATH', 'Path', 'CLASSPATH', 'INCLUDE', 'LIB']) {
          expect(workspace.mapCommand('set ' + quote + variable + '=' + SHADOW + ';%PATH%' + quote, 'cmd'))
            .toBe('set ' + quote + variable + '=' + local + ';%PATH%' + quote);
        }
      }
      expect(workspace.mapCommand('type "' + SHADOW + ';literal"', 'cmd'))
        .toBe('type "' + agentStyle(workspace.resolve(SHADOW + ';literal')) + '"');
      expect(workspace.mapCommand('PATH=' + SHADOW + ':$PATH command')).toBe('PATH=' + local + ':$PATH command');
      for (const variable of ['NODE_PATH', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'PERL5LIB']) {
        for (const quote of ['', '"', "'"]) {
          expect(workspace.mapCommand(variable + '=' + quote + SHADOW + ':$' + variable + quote + ' command'))
            .toBe(variable + '=' + quote + local + ':$' + variable + quote + ' command');
        }
      }
      for (const variable of ['PATH', 'NODE_PATH']) {
        for (const quote of ['', '"', "'"]) {
          expect(workspace.mapCommand(variable + '+=' + quote + ':' + SHADOW + ':$' + variable + quote + ' command'))
            .toBe(variable + '+=' + quote + ':' + local + ':$' + variable + quote + ' command');
        }
      }
      expect(workspace.mapCommand('FILE+="' + SHADOW + ':literal" command'))
        .toBe('FILE+="' + agentStyle(workspace.resolve(SHADOW + ':literal')) + '" command');
      expect(workspace.mapCommand('FILE="' + SHADOW + ':literal" command'))
        .toBe('FILE="' + agentStyle(workspace.resolve(SHADOW + ':literal')) + '" command');
      expect(workspace.mapCommand('set "FILE=' + SHADOW + ';literal"', 'cmd'))
        .toBe('set "FILE=' + agentStyle(workspace.resolve(SHADOW + ';literal')) + '"');
      const windowsWorkspace = new ExecutorWorkspace({ workingDir, aliases: [{ from: 'C:/agent/workspace', to: workingDir }] });
      for (const virtual of ['C:/agent/workspace', 'C:\\agent\\workspace']) {
        expect(windowsWorkspace.mapCommand('set "CLASSPATH=' + virtual + ';%CLASSPATH%"', 'cmd'))
          .toBe('set "CLASSPATH=' + local + ';%CLASSPATH%"');
      }
      expect(workspace.mapCommand('cat ' + SHADOW + ':literal'))
        .toBe('cat ' + agentStyle(workspace.resolve(SHADOW + ':literal')));
      for (const quote of ['"', "'"]) {
        expect(workspace.mapCommand('PATH=' + quote + SHADOW + ':$PATH' + quote + ' command'))
          .toBe('PATH=' + quote + local + ':$PATH' + quote + ' command');
        expect(workspace.mapCommand('cat ' + quote + SHADOW + ':literal' + quote))
          .toBe('cat ' + quote + agentStyle(workspace.resolve(SHADOW + ':literal')) + quote);
        expect(workspace.mapCommand('echo ' + quote + 'PATH=' + SHADOW + ':literal' + quote))
          .toBe('echo ' + quote + 'PATH=' + agentStyle(workspace.resolve(SHADOW + ':literal')) + quote);
      }
      // 单引号里的变量和 glob、双引号里的 glob 是目录名的字面部分，必须按父目录别名解析。
      for (const suffix of ['$suffix', '*', '?', '[ab]']) {
        const virtual = SHADOW + suffix;
        expect(workspace.mapCommand("ls '" + virtual + "'")).toBe("ls '" + agentStyle(workspace.resolve(virtual)) + "'");
      }
      for (const suffix of ['*', '?', '[ab]']) {
        const virtual = SHADOW + suffix;
        expect(workspace.mapCommand('ls "' + virtual + '"')).toBe('ls "' + agentStyle(workspace.resolve(virtual)) + '"');
      }
    } finally {
      await executor.close();
    }
  });

  it('keeps dynamic suffixes in file contents and recognizes existing literal sibling names', async () => {
    const { parent, workingDir, workspace, executor } = setup();
    try {
      const script = ['*', '?', '$suffix', '${suffix}', '%SUFFIX%'].map((suffix) => 'echo ' + SHADOW + suffix).join('\n');
      const expected = ['*', '?', '$suffix', '${suffix}', '%SUFFIX%'].map((suffix) => 'echo ' + agentStyle(workingDir) + suffix).join('\n');
      await executor.callTool('Write', { file_path: SHADOW + '/script.sh', content: script });
      expect(fs.readFileSync(path.join(workingDir, 'script.sh'), 'utf8')).toBe(expected);
      expect(workspace.mapTextForAgent(expected)).toBe(script);
      expect(workspace.mapContentFromAgent(script, expected)).toBe(expected);
      for (const suffix of ['$suffix', '%SUFFIX%']) {
        const literal = path.join(parent, 'p' + suffix);
        fs.mkdirSync(literal);
        expect(workspace.mapContentFromAgent('literal: ' + SHADOW + suffix))
          .toBe('literal: ' + agentStyle(literal));
        const realSibling = workingDir + suffix;
        fs.mkdirSync(realSibling);
        expect(workspace.mapTextForAgent('literal: ' + realSibling))
          .toBe('literal: ' + PARENT + '/flash-party-retro' + suffix);
      }
    } finally {
      await executor.close();
    }
  });

  it.each(['$suffix', '%SUFFIX%'])('preserves an unchanged dynamic path ending in %s when another line is edited', async (suffix) => {
    const { parent, workingDir, workspace, executor } = setup();
    fs.mkdirSync(path.join(parent, 'p' + suffix));
    try {
      const file = path.join(workingDir, 'dynamic.txt');
      for (const tail of ['', '/child/file.txt', '\\child\\file.txt']) {
        const original = 'first=' + workingDir + suffix + tail + '\nunchanged=1';
        fs.writeFileSync(file, original);
        const seen = readBack(await executor.callTool('Read', { file_path: SHADOW + '/dynamic.txt' }));
        expect(seen).toBe('first=' + SHADOW + suffix + tail + '\nunchanged=1');
        const edited = seen.replace('unchanged=1', 'unchanged=2');
        expect(workspace.mapContentFromAgent(edited, original)).toBe(original.replace('unchanged=1', 'unchanged=2'));
        await executor.callTool('Write', { file_path: SHADOW + '/dynamic.txt', content: edited });
        expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('unchanged=1', 'unchanged=2'));
      }
    } finally {
      await executor.close();
    }
  });

  it.each([' copy', ' (1)', '.git', '-v1'])('maps quoted sibling suffix %s to the same location as file tools', async (suffix) => {
    const { parent, workspace, executor } = setup();
    try {
      const virtual = SHADOW + suffix;
      const expected = path.join(parent, 'p' + suffix);
      expect(workspace.resolve(virtual)).toBe(expected);
      for (const quote of ['"', "'"]) {
        expect(workspace.mapCommand('mkdir -p ' + quote + virtual + quote))
          .toBe('mkdir -p ' + quote + agentStyle(expected) + quote);
      }
      await executor.callTool('Write', { file_path: virtual + '/a.txt', content: 'same folder' });
      expect(fs.readFileSync(path.join(expected, 'a.txt'), 'utf8')).toBe('same folder');
      const seen = virtual + '/a.txt';
      const local = agentStyle(path.join(expected, 'a.txt'));
      expect(workspace.mapTextFromAgent('report: ' + seen)).toBe('report: ' + local);
      expect(workspace.mapContentFromAgent('report: ' + seen)).toBe('report: ' + local);
    } finally {
      await executor.close();
    }
  });

  // symlink-platform-skip: Windows filesystems are case-insensitive, so they cannot represent this POSIX alias distinction.
  it.skipIf(process.platform === 'win32')('keeps case-distinct canonical aliases on case-sensitive hosts', ({ skip }) => {
    const actual = path.join(root, 'actual', 'project');
    const link = path.join(root, 'actual', 'PROJECT');
    fs.mkdirSync(actual, { recursive: true });
    // macOS 等主机也可能使用大小写不敏感的卷，按当前临时目录的实际能力判断。
    if (fs.existsSync(link)) return skip();
    fs.symlinkSync(actual, link, 'dir');
    const workspace = new ExecutorWorkspace({ workingDir: link, aliases: [{ from: SHADOW, to: link }] });
    workspace.setVirtualRoot(VIRTUAL_ROOT);
    expect(workspace.mapTextForAgent(path.join(actual, 'src', 'main.ts')))
      .toBe(SHADOW + '/src/main.ts');
  });

  it('writes an unchanged file back byte for byte through every write path', async () => {
    const { workingDir, workspace, executor } = setup();
    const forward = workingDir.replace(/\\/g, '/');
    const spellings = [
      workingDir + path.sep + 'src' + path.sep + 'a.ts',
      ...(process.platform === 'win32' ? [
        forward + '/build/out.js',
        '/' + forward[0].toLowerCase() + forward.slice(2) + '/scripts/run.sh',
        workingDir.toUpperCase() + '\\LOUD.TXT',
        '/tmp/' + path.relative(os.tmpdir(), workingDir).replace(/\\/g, '/') + '/cache',
      ] : []),
    ];
    const lines = [
      '# paths',
      ...spellings.map((item, index) => 'const p' + index + ' = ' + JSON.stringify(item) + ';'),
      'raw: ' + spellings.join(' '),
    ];
    // Read 工具按行给出内容(不带行尾)，换行风格由 Write 决定，与路径无关；Pi 与 Codex 整文件读写保留 CRLF。
    const original = lines.join('\n');
    const crlf = lines.join('\r\n');
    const json = JSON.stringify({ root: workingDir, nested: { file: spellings.at(-1) } }, null, 2);
    const target = path.join(workingDir, 'paths.ts');
    const config = path.join(workingDir, 'config.json');
    fs.writeFileSync(target, original);
    try {
      // Claude：Read 后原样 Write 回去。
      const seen = readBack(await executor.callTool('Read', { file_path: SHADOW + '/paths.ts' }));
      expect(seen).not.toContain(path.join('fp2', 'flash-party-retro'));
      expect(seen).toContain(SHADOW + '/src/a.ts');
      await executor.callTool('Write', { file_path: SHADOW + '/paths.ts', content: seen });
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      // Pi：fs.read 后原样 fs.write。
      fs.writeFileSync(target, crlf);
      fs.writeFileSync(config, json);
      for (const file of ['paths.ts', 'config.json']) {
        const read = await executor.handle('fs.read', { path: SHADOW + '/' + file }) as { data: string };
        expect(Buffer.from(read.data, 'base64').toString('utf8')).not.toContain(path.join('fp2', 'flash-party-retro'));
        await executor.handle('fs.write', { path: SHADOW + '/' + file, data: read.data });
      }
      expect(fs.readFileSync(target, 'utf8')).toBe(crlf);
      expect(fs.readFileSync(config, 'utf8')).toBe(json);
      // Codex：整文件写入同一份虚拟内容。
      const virtual = workspace.mapTextForAgent(crlf);
      const params = mapExecServerParams({ path: SHADOW + '/paths.ts', dataBase64: Buffer.from(virtual).toString('base64') }, workspace, 'fs/writeFile') as { dataBase64: string };
      expect(Buffer.from(params.dataBase64, 'base64').toString('utf8')).toBe(crlf);
    } finally {
      await executor.close();
    }
  });

  it('writes new paths with the separators the Agent used so source strings keep their meaning', async () => {
    const { workingDir, executor } = setup();
    try {
      await executor.callTool('Write', { file_path: SHADOW + '/build.js', content: 'const out = "' + SHADOW + '/build/out.js";\n' });
      expect(fs.readFileSync(path.join(workingDir, 'build.js'), 'utf8')).toBe('const out = "' + agentStyle(workingDir) + '/build/out.js";\n');
      await executor.handle('fs.write', { path: SHADOW + '/new.json', data: Buffer.from(JSON.stringify({ out: SHADOW + '/dist' })).toString('base64') });
      expect(JSON.parse(fs.readFileSync(path.join(workingDir, 'new.json'), 'utf8'))).toEqual({ out: agentStyle(workingDir) + '/dist' });
    } finally {
      await executor.close();
    }
  });

  it('edits text around a path that the file spells differently from the Agent', async () => {
    const actual = path.join(root, 'actual', 'flash-party-retro');
    fs.mkdirSync(actual, { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    // 任务工作目录是链接，文件里记的是真实目录；两者对 Agent 都是同一个虚拟目录。
    const { workspace, executor } = setup(link);
    const file = path.join(actual, 'notes.md');
    const content = [
      'output: ' + path.join(actual, 'out', 'a.txt'),
      'again: ' + path.join(actual, 'out', 'a.txt'),
      ...(process.platform === 'win32' ? ['slash: ' + actual.replace(/\\/g, '/') + '/out/b.txt'] : []),
      '',
    ].join('\n');
    fs.writeFileSync(file, content);
    try {
      const seen = readBack(await executor.callTool('Read', { file_path: SHADOW + '/notes.md' }));
      expect(seen).toContain('output: ' + SHADOW + '/out/a.txt');
      const result = await executor.callTool('Edit', {
        file_path: SHADOW + '/notes.md',
        old_string: 'again: ' + SHADOW + '/out/a.txt',
        new_string: 'again: ' + SHADOW + '/out/a.txt (checked)',
      });
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(file, 'utf8')).toBe(content.replace(
        'again: ' + path.join(actual, 'out', 'a.txt'),
        'again: ' + path.join(actual, 'out', 'a.txt') + ' (checked)',
      ));
      if (process.platform === 'win32') {
        // 文件里用 `/` 写的路径同样找得到；新写的路径用任务工作目录的写法和 Agent 的分隔符。
        const slash = await executor.callTool('Edit', { file_path: SHADOW + '/notes.md', old_string: SHADOW + '/out/b.txt', new_string: SHADOW + '/out/c.txt' });
        expect(slash.isError).toBeFalsy();
        expect(fs.readFileSync(file, 'utf8')).toContain('slash: ' + agentStyle(link) + '/out/c.txt');
      }
    } finally {
      await executor.close();
    }
  });

  it('keeps the matching spelling when the same path is written two ways in one file', async () => {
    const actual = path.join(root, 'actual', 'flash-party-retro');
    fs.mkdirSync(actual, { recursive: true });
    const link = path.join(root, 'link');
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { executor } = setup(link);
    const file = path.join(actual, 'twice.md');
    const content = 'a: ' + path.join(link, 'x.txt') + '\nb: ' + path.join(actual, 'x.txt') + '\n';
    fs.writeFileSync(file, content);
    try {
      await executor.callTool('Read', { file_path: SHADOW + '/twice.md' });
      const result = await executor.callTool('Edit', {
        file_path: SHADOW + '/twice.md', old_string: 'b: ' + SHADOW + '/x.txt', new_string: 'b: ' + SHADOW + '/x.txt (ok)',
      });
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(file, 'utf8')).toBe('a: ' + path.join(link, 'x.txt') + '\nb: ' + path.join(actual, 'x.txt') + ' (ok)\n');
    } finally {
      await executor.close();
    }
  });

  it.each(['text', 'json'])('counts and replaces every virtual match with different original spellings in %s', async (format) => {
    const actual = path.join(root, 'actual', 'project');
    const link = path.join(root, 'linked-project');
    fs.mkdirSync(actual, { recursive: true });
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { executor } = setup(link);
    const native = path.join(link, 'x.txt');
    const forward = agentStyle(path.join(actual, 'x.txt'));
    const untouched = 'c: ' + path.join(actual, 'keep.txt') + '\r\n';
    const original = format === 'json' ? JSON.stringify({ a: native, b: forward, keep: path.join(actual, 'keep.txt') })
      : 'a: ' + native + '\r\nb: ' + forward + '\r\n' + untouched;
    const file = path.join(actual, 'all.md');
    fs.writeFileSync(file, original);
    try {
      await executor.callTool('Read', { file_path: SHADOW + '/all.md' });
      const edit = { file_path: SHADOW + '/all.md', old_string: SHADOW + '/x.txt', new_string: SHADOW + '/y.txt' };
      const ambiguous = await executor.callTool('Edit', edit);
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Found 2 matches') })]));
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      const all = await executor.callTool('Edit', { ...edit, replace_all: true });
      expect(all.isError).toBeFalsy();
      const expected = format === 'json' ? JSON.stringify({ a: agentStyle(link) + '/y.txt', b: agentStyle(link) + '/y.txt', keep: path.join(actual, 'keep.txt') })
        : 'a: ' + agentStyle(link) + '/y.txt\r\nb: ' + agentStyle(link) + '/y.txt\r\n' + untouched;
      expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    } finally {
      await executor.close();
    }
  });

  it('keeps each unchanged spelling when earlier occurrences are deleted, inserted or moved', async () => {
    const actual = path.join(root, 'actual', 'project');
    const link = path.join(root, 'linked-project');
    fs.mkdirSync(actual, { recursive: true });
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { workspace, executor } = setup(link);
    const native = path.join(link, 'build', 'out.js');
    const forward = agentStyle(path.join(actual, 'build', 'out.js'));
    const virtual = SHADOW + '/build/out.js';
    try {
      const original = '// a: ' + native + '\nconst out = "' + forward + '";\n';
      expect(workspace.mapContentFromAgent('const out = "' + virtual + '";\n', original))
        .toBe('const out = "' + forward + '";\n');
      expect(workspace.mapContentFromAgent('new: ' + virtual + '\n' + workspace.mapTextForAgent(original), original))
        .toBe('new: ' + agentStyle(link) + '/build/out.js\n' + original);
      const prose = 'a: ' + native + '; b: ' + forward + '\n';
      expect(workspace.mapContentFromAgent('b: ' + virtual + '\n', prose)).toBe('b: ' + forward + '\n');
      const json = JSON.stringify({ a: native, b: forward });
      expect(workspace.mapContentFromAgent(JSON.stringify({ b: virtual }), json)).toBe(JSON.stringify({ b: forward }));
      const jsonProse = JSON.stringify({ text: 'before ' + native + ' tail' });
      expect(workspace.mapContentFromAgent(workspace.mapTextForAgent(jsonProse).replace('before', 'after'), jsonProse))
        .toBe(JSON.stringify({ text: 'after ' + native + ' tail' }));
      const moved = 'const out = "' + virtual + '";\n// a: ' + virtual + '\n';
      expect(workspace.mapContentFromAgent(moved, original)).toBe('const out = "' + forward + '";\n// a: ' + native + '\n');
    } finally {
      await executor.close();
    }
  });

  it('edits a multiline fragment with repeated virtual paths using that fragment’s original spellings', async () => {
    const actual = path.join(root, 'actual', 'project');
    const link = path.join(root, 'linked-project');
    fs.mkdirSync(actual, { recursive: true });
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { executor } = setup(link);
    const native = path.join(link, 'build', 'out.js');
    const forward = agentStyle(path.join(actual, 'build', 'out.js'));
    const virtual = SHADOW + '/build/out.js';
    const file = path.join(actual, 'repeated.md');
    fs.writeFileSync(file, 'a: ' + native + '\nb: ' + forward + '\nc: ' + native + '\n');
    try {
      await executor.callTool('Read', { file_path: SHADOW + '/repeated.md' });
      const result = await executor.callTool('Edit', {
        file_path: SHADOW + '/repeated.md', old_string: 'b: ' + virtual + '\nc: ' + virtual,
        new_string: 'b: ' + virtual + '\nc: ' + virtual + ' (ok)',
      });
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(file, 'utf8')).toBe('a: ' + native + '\nb: ' + forward + '\nc: ' + native + ' (ok)\n');
    } finally {
      await executor.close();
    }
  });

  it('restores notebook paths from the edited cell rather than an earlier cell', async () => {
    const actual = path.join(root, 'actual', 'project');
    const link = path.join(root, 'linked-project');
    fs.mkdirSync(actual, { recursive: true });
    fs.symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { executor } = setup(link);
    const native = path.join(link, 'build', 'out.js');
    const forward = agentStyle(path.join(actual, 'build', 'out.js'));
    const file = path.join(actual, 'paths.ipynb');
    const a = 'a = "' + native + '"';
    const b = 'b = "' + forward + '"';
    fs.writeFileSync(file, JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells: [
      { id: 'a', cell_type: 'code', source: [a], metadata: {}, outputs: [] },
      { id: 'b', cell_type: 'code', source: [b], metadata: {}, outputs: [] },
    ] }));
    try {
      await executor.callTool('Read', { file_path: SHADOW + '/paths.ipynb' });
      const result = await executor.callTool('NotebookEdit', {
        notebook_path: SHADOW + '/paths.ipynb', cell_id: 'b', new_source: 'b = "' + SHADOW + '/build/out.js" # checked',
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).cells.map((cell: { source: unknown }) => cell.source))
        .toEqual([[a], b + ' # checked']);
    } finally {
      await executor.close();
    }
  });

  it('keeps Markdown links in replies intact for folders that start with punctuation', () => {
    const { workingDir, workspace } = setup();
    const target = path.join(workingDir, '.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'ci');
    const projection = new RemoteEventProjection(workspace);
    const reply = '改好了：[ci](' + SHADOW + '/.github/workflows/ci.yml)，也可以看 [同一个](<' + SHADOW + '/.github/workflows/ci.yml>)';
    const [event] = projection.project({ type: 'text', source: 'claude-code', data: { text: reply, isFinal: true } } as AgentEvent);
    const links = markdownLinks((event.data as { text: string }).text);
    expect(links).toHaveLength(2);
    for (const url of links) expect(fs.readFileSync(url, 'utf8')).toBe('ci');
  });

  it.each(['allow', 'deny'] as const)('shows plan file links locally and returns %s feedback in Agent paths', async (behavior) => {
    const { workingDir, workspace, executor } = setup();
    const controller = createRemoteAgentHandle({
      client: {} as RemoteAgentRunClient,
      started: { id: 'sdk-1', agentKind: 'claude-code', model: 'm', shadowDir: SHADOW, virtualWorkspace: true, methods: [], state: {} },
      workspace, mapEvent: mapClaudeHostedEvent, recordApproval: () => {}, newId: () => 'request-id', dispose: async () => {},
    });
    let shown: InteractionRequest | undefined;
    const local = agentStyle(workingDir);
    controller.handle.setInteractionResolver(async (request) => {
      shown = request;
      return { kind: 'plan_review', behavior,
        ...(behavior === 'allow' ? { editedPlan: (request as { plan: string }).plan + '\n2. 再看 ' + local + '/docs/b.md' } : {}),
        reason: '重新看 ' + local + '/docs/b.md',
      };
    });
    try {
      const reply = await controller.onRequest({ type: 'interaction', request: {
        kind: 'plan_review', requestId: 'plan', plan: '1. 修改 [ci](' + SHADOW + '/.github/ci.yml)', planFilePath: SHADOW + '/plan.md',
      } });
      expect(shown).toMatchObject({ plan: '1. 修改 [ci](' + local + '/.github/ci.yml)', planFilePath: path.join(workingDir, 'plan.md') });
      expect(markdownLinks((shown as { plan: string }).plan)).toEqual([local + '/.github/ci.yml']);
      expect((reply as { result: InteractionDecision }).result).toMatchObject({
        kind: 'plan_review', behavior, reason: '重新看 ' + SHADOW + '/docs/b.md',
        ...(behavior === 'allow' ? { editedPlan: '1. 修改 [ci](' + SHADOW + '/.github/ci.yml)\n2. 再看 ' + SHADOW + '/docs/b.md' } : {}),
      });
    } finally {
      controller.onClosed('closed');
      await executor.close();
    }
  });
});
