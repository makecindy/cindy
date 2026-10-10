import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mapExecServerParams, mapExecServerResult, execServerActions } from '../../controller/execServerRelay';
import { RemoteExecutor } from '../executor';
import { ExecutorGate } from '../gate';
import { ExecutorWorkspace, projectPathText } from '../workspace';
import { createReverseHttpRouter } from '../../controller/router';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-virtual-workspace-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

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
});
