import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { changeSourceAutomationState, resolveSourceCli } from '../takeover.js';
let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }); });
it.each(['hermes', 'openclaw'] as const)('uses native %s pause/resume with only the selected environment', async kind => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-takeover-test-'));
  const state = path.join(root, `.${kind}`); const bin = path.join(root, 'host bin');
  await fs.mkdir(path.join(state, 'cron'), { recursive: true }); await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(state, kind === 'hermes' ? 'config.yaml' : 'openclaw.json'), kind === 'hermes' ? 'name: Fixture' : JSON.stringify({ agents: { list: [{ id: 'main', name: 'Fixture', workspace: state }] } }));
  const file = path.join(state, 'cron/jobs.json');
  const job = { id: 'fixture', agentId: 'main', name: 'Reminder', prompt: 'Take a break', payload: { kind: 'agentTurn', message: 'Take a break' }, schedule: { kind: 'interval', minutes: 60 }, enabled: true };
  await fs.writeFile(file, JSON.stringify({ jobs: [job] }));
  vi.stubEnv('CINDY_UNRELATED_PAT', 'fake-unrelated-host-token');
  vi.stubEnv('HTTPS_PROXY', 'https://fake-host-proxy-credential.invalid');
  vi.stubEnv('HTTP_PROXY', 'https://fake-unselected-proxy.invalid');
  const sourceBin = path.join(state, 'source-bin');
  await fs.mkdir(sourceBin);
  await fs.writeFile(path.join(sourceBin, kind), `#!${process.execPath}\nprocess.exit(99);`, { mode: 0o700 });
  const selected = { PATH: sourceBin, COMSPEC: path.join(sourceBin, 'fake-cmd.exe'), SOURCE_API_KEY: 'fake-selected-source-key', HTTPS_PROXY: 'https://fake-selected-proxy.invalid' };
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.env.CINDY_UNRELATED_PAT || process.env.HTTP_PROXY || process.env.SOURCE_API_KEY !== 'fake-selected-source-key'
  || process.env.HTTPS_PROXY !== 'https://fake-selected-proxy.invalid' || process.env.PATH !== ${JSON.stringify(sourceBin)}
  || process.env.COMSPEC !== ${JSON.stringify(selected.COMSPEC)}) process.exit(3);
const sourceRoot = process.env.HERMES_HOME || process.env.OPENCLAW_STATE_DIR;
if (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_CONFIG_PATH !== path.join(sourceRoot, 'openclaw.json')) process.exit(4);
const file = path.join(sourceRoot, 'cron/jobs.json');
const data = JSON.parse(fs.readFileSync(file,'utf8'));
const job = data.jobs.find(job => job.id === process.argv[4]);
if (process.argv[2] !== 'cron' || !job) process.exit(2);
job.enabled = ['resume', 'enable'].includes(process.argv[3]);
fs.writeFileSync(file, JSON.stringify(data));
`;
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(bin, `${kind}.cjs`), script);
    await fs.writeFile(path.join(bin, `${kind}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${kind}.cjs" %*\r\n`);
  } else {
    await fs.writeFile(path.join(bin, kind), script, { mode: 0o700 });
  }
  const readers = { home: root, env: { ...process.env, PATH: bin }, readCronDatabase: async () => [] };
  const [source] = await discoverImportSources(readers);
  const snapshot = await inspectImportSource(source!, readers); const item = snapshot.items.find(item => item.automation)!;
  await changeSourceAutomationState(source!, item, false, readers, () => {}, false, selected);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).jobs[0].enabled).toBe(false);
  await changeSourceAutomationState(source!, item, false, readers, () => {}, true, selected);
  await changeSourceAutomationState(source!, item, true, readers, () => {}, false, selected);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).jobs[0].enabled).toBe(true);
  await fs.writeFile(file, JSON.stringify({ jobs: [{ ...job, prompt: 'User changed the task' }] }));
  await expect(changeSourceAutomationState(source!, item, false, readers, () => {})).rejects.toThrow('SOURCE_AUTOMATION_CHANGED');
});

it.skipIf(process.platform === 'win32')('terminates an in-flight source CLI and its child on owner change', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-takeover-owner-test-'));
  const state = path.join(root, '.hermes'); const bin = path.join(root, '.local/bin');
  await fs.mkdir(path.join(state, 'cron'), { recursive: true }); await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(state, 'config.yaml'), 'name: Fixture');
  const file = path.join(state, 'cron/jobs.json'); const started = path.join(state, 'started.json');
  await fs.writeFile(file, JSON.stringify({ jobs: [{ id: 'fixture', name: 'Reminder', prompt: 'Take a break', schedule: { kind: 'interval', minutes: 60 }, enabled: true }] }));
  await fs.writeFile(path.join(bin, 'hermes'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(process.env.HERMES_HOME, 'started.json'), JSON.stringify([process.pid, child.pid]));
setTimeout(() => {
  const file = path.join(process.env.HERMES_HOME, 'cron/jobs.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.jobs[0].enabled = false;
  fs.writeFileSync(file, JSON.stringify(data));
}, 10000);
`, { mode: 0o700 });
  const readers = { home: root, env: {}, readCronDatabase: async () => [] };
  const [source] = await discoverImportSources(readers);
  const snapshot = await inspectImportSource(source!, readers); const item = snapshot.items.find(row => row.automation)!;
  let owns = true; let pids: number[] = [];
  const pending = changeSourceAutomationState(source!, item, false, readers, () => { if (!owns) throw new Error('OWNER_CHANGED'); });
  const result = pending.catch(error => error);
  try {
    await vi.waitFor(async () => { pids = JSON.parse(await fs.readFile(started, 'utf8')); expect(pids).toHaveLength(2); });
    owns = false;
    expect(await result).toMatchObject({ message: 'OWNER_CHANGED' });
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).jobs[0].enabled).toBe(true);
  } finally {
    owns = false;
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already terminated. */ } }
    await result;
  }
});

it('resolves Windows batch CLIs and their interpreter from case-insensitive host variables', async () => {
  const source = { kind: 'openclaw' as const, agentId: 'main', name: 'Fixture', root: 'C:\\source', workspace: 'C:\\source', configFile: 'C:\\source\\openclaw.json' };
  const executable = 'C:\\host-bin\\openclaw.cmd';
  const interpreter = 'C:\\Windows\\System32\\cmd.exe';
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async file => {
    if (String(file) === executable) return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  const host = { Path: ';relative-bin;C:\\host-bin', ComSpec: interpreter, SystemRoot: 'C:\\Windows' };
  expect(await resolveSourceCli(source, 'C:\\Users\\fixture', host, 'win32')).toEqual({ executable, interpreter });
  expect(await resolveSourceCli(source, 'C:\\Users\\fixture', { ...host, ComSpec: undefined }, 'win32')).toEqual({ executable, interpreter });
  await expect(resolveSourceCli(source, 'C:\\Users\\fixture', { ...host, ComSpec: 'cmd.exe' }, 'win32')).rejects.toThrow('SOURCE_COMMAND_UNAVAILABLE');
  expect(stat.mock.calls.every(([file]) => path.win32.isAbsolute(String(file)))).toBe(true);
});
