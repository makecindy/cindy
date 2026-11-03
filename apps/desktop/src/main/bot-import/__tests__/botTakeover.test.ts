import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverImportSources, inspectImportSource } from '../sources.js';
import { takeOverImportedBot, type ImportBotRecord } from '../botTakeover.js';
import type { ImportedImBotTarget } from '../imBotConnections.js';

// Fake native CLIs only: the host's real hermes / openclaw are never reachable (home/.local/bin is searched first).
const FAKE = `
const fs = require('node:fs'), path = require('node:path');
const home = process.env.HERMES_HOME || process.env.OPENCLAW_STATE_DIR;
const file = process.env.OPENCLAW_CONFIG_PATH || path.join(home, 'config.yaml');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'cli.log'), JSON.stringify(args) + '\\n');
if (fs.existsSync(path.join(home, 'fail-config')) && args[0] === 'config') process.exit(1);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const walk = keys => keys.reduce((node, key) => (node[key] ??= {}), config);
if (args[0] === 'config' && args[1] === 'set') { const keys = args[2].split('.'); walk(keys.slice(0, -1))[keys.at(-1)] = args[3] === 'true' ? true : args[3] === 'false' ? false : args[3]; }
else if (args[0] === 'config' && args[1] === 'unset') { const keys = args[2].split('.'); delete walk(keys.slice(0, -1))[keys.at(-1)]; }
else if (args[0] === 'config' && args[1] === 'patch') {
  const merge = (node, patch) => { for (const [key, value] of Object.entries(patch)) { if (value === null) delete node[key]; else if (typeof value === 'object') merge(node[key] ??= {}, value); else node[key] = value; } };
  merge(config, JSON.parse(fs.readFileSync(0, 'utf8')));
} else if (args[0] === 'gateway' && args[1] === 'restart') {
  if (fs.existsSync(path.join(home, 'fail-restart'))) process.exit(1);
  const stateFile = path.join(home, 'gateway_state.json');
  if (!fs.existsSync(path.join(home, 'restart-keeps-live'))) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const [name, platform] of Object.entries(state.platforms)) if (config.platforms?.[name]?.enabled === false) platform.state = 'disconnected';
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  process.exit(0);
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(config));
`;

let root: string;
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function setup(kind: 'hermes' | 'openclaw', config: Record<string, unknown>, options: { profile?: string; live?: boolean; parked?: boolean; env?: string } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-bot-takeover-test-'));
  const host = path.join(root, `.${kind}`);
  const state = options.profile ? path.join(host, 'profiles', options.profile) : host;
  const bin = path.join(root, '.local', 'bin');
  await fs.mkdir(state, { recursive: true }); await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(host, kind === 'hermes' ? 'config.yaml' : 'openclaw.json'), JSON.stringify(options.profile ? {} : config));
  if (options.profile) await fs.writeFile(path.join(state, 'config.yaml'), JSON.stringify(config));
  if (options.env) await fs.writeFile(path.join(state, '.env'), options.env);
  if (options.parked) await fs.writeFile(path.join(state, 'gateway.parked'), '');
  // A named profile is served by the host gateway under "<profile>:<platform>".
  const key = options.profile ? `${options.profile}:telegram` : 'telegram';
  await fs.writeFile(path.join(host, 'gateway_state.json'), JSON.stringify({ pid: process.pid, platforms: { [key]: { state: options.live ? 'connected' : 'disconnected', writer_pid: process.pid } } }));
  if (process.platform === 'win32') {
    // Windows finds the .cmd wrapper and runs it through the system shell, which needs the host environment.
    await fs.writeFile(path.join(bin, `${kind}.cjs`), FAKE);
    await fs.writeFile(path.join(bin, `${kind}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${kind}.cjs" %*\r\n`);
  } else {
    await fs.writeFile(path.join(bin, kind), `#!${process.execPath}\n${FAKE}`, { mode: 0o700 });
  }
  const readers = { home: root, env: { ...(process.platform === 'win32' ? process.env : {}), PATH: path.join(root, 'empty-path') }, readCronDatabase: async () => [] };
  const source = (await discoverImportSources(readers)).find(item => item.agentId === (options.profile ?? (kind === 'hermes' ? 'default' : 'main')))!;
  const item = (await inspectImportSource(source, readers, undefined, { bots: true })).items.find(entry => entry.view.category === 'bots')!;
  const saves: Array<ImportBotRecord | undefined> = [];
  const target = { channel: 'telegram' as const, existing: vi.fn<ImportedImBotTarget['existing']>(() => undefined),
    preflight: vi.fn(async () => undefined), connect: vi.fn<ImportedImBotTarget['connect']>(async () => undefined) };
  const sleep = vi.fn(async () => {});
  let clock = 0;
  const run = (record?: ImportBotRecord, timing = {}) => takeOverImportedBot({ source, item, target, record, readers, assertOwner: () => {},
    save: async next => { saves.push(next); }, timing: { pollMs: 2_000, timeoutMs: 6_000, settleMs: 3_000, sleep, now: () => (clock += 1_000), ...timing } });
  const readConfig = async () => JSON.parse(await fs.readFile(kind === 'hermes' ? path.join(state, 'config.yaml') : path.join(host, 'openclaw.json'), 'utf8'));
  const calls = async () => (await fs.readFile(path.join(state, 'cli.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).join(' '));
  return { state, host, item, target, saves, sleep, run, readConfig, calls };
}

const telegramEnv = 'TELEGRAM_BOT_TOKEN=12345:fake-telegram-token\nTELEGRAM_ALLOWED_USERS=424242';

it('stops a live Hermes bot, restarts the gateway, waits for it to let go, then connects', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { live: true, env: telegramEnv });
  expect(await t.run()).toBeUndefined();
  expect(await t.calls()).toEqual(['config set platforms.telegram.enabled false', 'gateway restart']);
  expect((await t.readConfig()).platforms.telegram.enabled).toBe(false);
  expect(t.target.connect).toHaveBeenCalledTimes(1);
  expect(t.saves.map(record => record?.phase)).toEqual(['stopping', 'stopping', 'stopped', 'stopped', 'stopped', 'connected']);
  expect(t.saves.at(-1)).toEqual({ phase: 'connected', original: { present: false }, wasLive: true, changed: true, restartRequested: true, restarted: true });
  for (const call of await t.calls()) expect(call).not.toContain('fake-telegram-token');
});

it('never restarts a parked Hermes profile and waits for the host to drop the bot', async () => {
  const t = await setup('hermes', { name: 'Family' }, { profile: 'family', parked: true, live: true, env: telegramEnv });
  // The host rescan drops the bot after the second poll.
  t.sleep.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
    await fs.writeFile(path.join(t.host, 'gateway_state.json'), JSON.stringify({ platforms: { 'family:telegram': { state: 'disconnected' } } }));
  });
  expect(await t.run()).toBeUndefined();
  expect(await t.calls()).toEqual(['config set platforms.telegram.enabled false']);
  expect(t.sleep).toHaveBeenCalledTimes(2);
  expect(t.target.connect).toHaveBeenCalledTimes(1);
});

it.each([
  { original: undefined, restore: 'config unset platforms.telegram.enabled' },
  { original: true, restore: 'config set platforms.telegram.enabled true' },
])('restores the original Hermes switch ($original) and gateway when the companion cannot connect', async ({ original, restore }) => {
  const t = await setup('hermes', { name: 'Ada', ...(original === undefined ? {} : { platforms: { telegram: { enabled: original } } }) }, { live: true, env: telegramEnv });
  t.target.connect.mockResolvedValueOnce('IMPORT_IM_BOT_GATEWAY_RUNNING');
  expect(await t.run()).toBe('IMPORT_IM_BOT_GATEWAY_RUNNING');
  expect(await t.calls()).toEqual(['config set platforms.telegram.enabled false', 'gateway restart', restore, 'gateway restart']);
  expect(object((await t.readConfig()).platforms?.telegram).enabled).toBe(original);
  // A later retry starts from scratch.
  expect(t.saves.at(-1)).toBeUndefined();
});

it('does not connect when the source switch or the live bot does not stop', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { live: true, env: telegramEnv });
  await fs.writeFile(path.join(t.state, 'fail-config'), '');
  expect(await t.run()).toBe('IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED');
  expect(t.saves.at(-1)).toBeUndefined();
  await fs.rm(path.join(t.state, 'fail-config'));
  await fs.writeFile(path.join(t.state, 'restart-keeps-live'), '');
  t.saves.length = 0;
  expect(await t.run()).toBe('IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED');
  expect(t.target.connect).not.toHaveBeenCalled();
  // The switch stays off: the user moved the bot, the gateway has just not let go yet.
  expect(t.saves.at(-1)).toMatchObject({ phase: 'stopped', changed: true, restarted: true });
  expect((await t.readConfig()).platforms.telegram.enabled).toBe(false);
});

it('retries a gateway restart that did not succeed instead of waiting on it forever', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { live: true, env: telegramEnv });
  await fs.writeFile(path.join(t.state, 'fail-restart'), '');
  expect(await t.run()).toBe('IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED');
  const record = t.saves.at(-1)!;
  expect(record).toMatchObject({ phase: 'stopped', restartRequested: true });
  expect(record.restarted).toBeUndefined();
  await fs.rm(path.join(t.state, 'fail-restart'));
  expect(await t.run(record)).toBeUndefined();
  expect((await t.calls()).filter(call => call === 'gateway restart')).toHaveLength(2);
  expect(t.target.connect).toHaveBeenCalledTimes(1);
});

it('finishes an interrupted rollback and re-stops a source that came back on, never serving both sides', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { env: telegramEnv });
  // Crash after the switch was restored but before the record was cleared.
  const restoring: ImportBotRecord = { phase: 'restoring', original: { present: false }, wasLive: false, changed: true };
  expect(await t.run(restoring)).toBe('IMPORT_IM_BOT_CONNECT_FAILED');
  expect(t.target.connect).not.toHaveBeenCalled();
  expect(t.saves.at(-1)).toBeUndefined();
  // A "stopped" record whose source is enabled again is stopped once more before connecting.
  expect(await t.run({ ...restoring, phase: 'stopped' })).toBeUndefined();
  expect(await t.calls()).toEqual(['config unset platforms.telegram.enabled', 'config set platforms.telegram.enabled false']);
  expect((await t.readConfig()).platforms.telegram.enabled).toBe(false);
  expect(t.target.connect).toHaveBeenCalledTimes(1);
});

it('keeps the source off when another companion claimed the bot, and retries a rollback whose restart failed', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { live: true, env: telegramEnv });
  // A concurrent import connected the bot to another companion first.
  t.target.connect.mockResolvedValueOnce('IMPORT_IM_BOT_IN_USE');
  expect(await t.run()).toBe('IMPORT_IM_BOT_IN_USE');
  expect((await t.readConfig()).platforms.telegram.enabled).toBe(false);
  expect(t.saves.at(-1)).toBeUndefined();
  // An ordinary connect failure rolls back; a failed restart keeps the rollback pending.
  const stopped = { phase: 'stopped' as const, original: { present: false }, wasLive: true, changed: true, restartRequested: true, restarted: true };
  t.target.connect.mockResolvedValueOnce('IMPORT_IM_BOT_CONNECT_FAILED');
  await fs.writeFile(path.join(t.state, 'fail-restart'), '');
  expect(await t.run(stopped)).toBe('IMPORT_IM_BOT_CONNECT_FAILED');
  expect(t.saves.at(-1)).toMatchObject({ phase: 'restoring' });
  await fs.rm(path.join(t.state, 'fail-restart'));
  expect(await t.run(t.saves.at(-1))).toBe('IMPORT_IM_BOT_CONNECT_FAILED');
  expect(t.saves.at(-1)).toBeUndefined();
  expect(t.target.connect).toHaveBeenCalledTimes(2);
});

it('leaves a bot swapped in after the preview running and does not connect the old one', async () => {
  const t = await setup('hermes', { name: 'Ada' }, { live: true, env: telegramEnv });
  await fs.writeFile(path.join(t.state, '.env'), 'TELEGRAM_BOT_TOKEN=67890:fake-new-token\nTELEGRAM_ALLOWED_USERS=424242');
  expect(await t.run()).toBe('IMPORT_IM_BOT_SOURCE_CHANGED');
  expect(await t.calls()).toEqual([]);
  expect(t.target.connect).not.toHaveBeenCalled();
  expect(t.saves).toEqual([]);
});

it('resumes an interrupted takeover without stopping or restarting twice', async () => {
  const t = await setup('hermes', { name: 'Ada', platforms: { telegram: { enabled: false } } }, { env: telegramEnv });
  const record: ImportBotRecord = { phase: 'stopped', original: { present: false }, wasLive: true, changed: true, restarted: true };
  expect(await t.run(record)).toBeUndefined();
  expect(await t.calls()).toEqual([]);
  expect(t.target.connect).toHaveBeenCalledTimes(1);
  // A connection created just before the crash is recognized instead of added again.
  t.target.existing.mockReturnValue('self');
  expect(await t.run(record)).toBeUndefined();
  expect(await t.run({ ...record, phase: 'connected' })).toBeUndefined();
  expect(t.target.connect).toHaveBeenCalledTimes(1);
  expect(await t.calls()).toEqual([]);
});

it('disables an OpenClaw account through a stdin patch and removes it again on failure', async () => {
  const t = await setup('openclaw', { commands: { ownerAllowFrom: ['telegram:424242'] }, channels: { telegram: { accounts: { default: { botToken: '1234567:fake-telegram-token' } } } } });
  t.target.connect.mockResolvedValueOnce('IMPORT_IM_BOT_CONNECT_FAILED');
  expect(await t.run()).toBe('IMPORT_IM_BOT_CONNECT_FAILED');
  expect(await t.calls()).toEqual(['config patch --stdin', 'config patch --stdin']);
  expect(t.sleep).toHaveBeenCalledWith(3_000);
  expect((await t.readConfig()).channels.telegram.accounts.default).toEqual({ botToken: '1234567:fake-telegram-token' });
  expect(await t.run()).toBeUndefined();
  expect((await t.readConfig()).channels.telegram.accounts.default.enabled).toBe(false);
});

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
