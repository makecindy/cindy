import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ExecServerRelay } from '../controller/execServerRelay';
import { ExecutorWorkspace } from '../executor/workspace';
import type { ExecutorAction } from '../executor/gate';

const REPO = path.resolve(__dirname, '../../../../../..');
const CODEX = path.join(REPO, 'apps', 'codex-package-bin', process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');

describe.skipIf(!fs.existsSync(CODEX))('native exec-server workspace projection', () => {
  it('initializes and executes with virtual paths while the file and authorization stay on this computer', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-projection-')));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const virtual = '/Users/agent/workspace';
    const workspace = new ExecutorWorkspace({ workingDir: project, aliases: [{ from: virtual, to: project }] });
    workspace.setVirtualRoot('/Users/agent');
    const messages: Array<Record<string, any>> = [];
    const actions: ExecutorAction[] = [];
    let parts = '';
    const relay = new ExecServerRelay({
      codexPath: CODEX,
      cwd: project,
      workspace,
      authorize: (action) => { actions.push(action); return { ok: true }; },
      push: async (frames) => {
        for (const frame of frames) {
          if (frame.kind !== 'message') continue;
          parts += frame.data;
          if (!frame.more) { messages.push(JSON.parse(parts)); parts = ''; }
        }
      },
    });
    const send = (message: unknown) => relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    try {
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      send({ id: 1, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 1), { timeout: 5000 }).toBeDefined();
      const init = messages.find((item) => item.id === 1)!;
      expect(init.result.environmentInfo.cwd).toBe('file:///Users/agent/workspace');
      expect(init.result.environmentInfo.userHomeDir).not.toBe(pathToFileURL(os.homedir()).href);
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'process/start', params: {
        processId: 'p1',
        argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "correct computer"); console.log(process.cwd());', virtual + '/made.txt'],
        cwd: 'file:///Users/agent/workspace',
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() } : {},
        tty: false,
      } });
      await expect.poll(() => messages.some((item) => item.method === 'process/closed'), { timeout: 5000 }).toBe(true);
      expect(messages.find((item) => item.id === 2)?.error).toBeUndefined();
      expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8')).toBe('correct computer');
      const output = messages.filter((item) => item.method === 'process/output')
        .map((item) => Buffer.from(item.params.chunk, 'base64').toString()).join('');
      expect(output.trim()).toBe(virtual);
      expect(actions).toEqual([expect.objectContaining({ kind: 'exec', cwd: project })]);
      expect(JSON.stringify(messages)).not.toContain(project.replace(/\\/g, '\\\\'));
    } finally {
      relay.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
