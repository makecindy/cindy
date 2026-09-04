import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexMicroGuardManager,
  CodexMicroGuardStore,
  mergeNodeOptions,
  nodeOptionsContains,
  parseLaunchEnvironmentNodeOptions,
  removeNodeOption,
  restoreNodeOptions,
  type GuardCommandResult,
  type GuardCommandRunner,
} from '../codexMicroGuardCore.js';

const roots: string[] = [];
const LEASE_ID = '11111111-1111-4111-8111-111111111111';

class FakeRunner implements GuardCommandRunner {
  readonly commands: string[][] = [];

  constructor(private readonly responses: GuardCommandResult[]) {}

  async run(arguments_: readonly string[]): Promise<GuardCommandResult> {
    this.commands.push([...arguments_]);
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected launchctl command');
    return response;
  }
}

function temporaryStore(): CodexMicroGuardStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-guard-'));
  roots.push(root);
  return new CodexMicroGuardStore(path.join(root, 'support'));
}

function printed(nodeOptions?: string): string {
  return `gui/501 = {\n\ttype = login\n\tenvironment = {\n\t\tPATH => /bin\n${
    nodeOptions === undefined ? '' : `\t\tNODE_OPTIONS =>${nodeOptions ? ` ${nodeOptions}` : ''}\n`
  }\t}\n\tservices = {\n\t\t  900 - application.example\n\t}\n}\n`;
}

function result(stdout = '', status = 0): GuardCommandResult {
  return { status, stdout, stderr: '' };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex Micro guard NODE_OPTIONS handling', () => {
  it('merges once and removes only the bounded guard token', () => {
    const token = '--require=/tmp/guard.cjs';
    expect(mergeNodeOptions('--trace-warnings', token)).toBe(`--trace-warnings ${token}`);
    expect(mergeNodeOptions(`--trace-warnings ${token}`, token)).toBe(`--trace-warnings ${token}`);
    expect(nodeOptionsContains(token, `--trace-warnings ${token}`)).toBe(true);
    expect(removeNodeOption(token, `--trace-warnings ${token} --inspect=9229`)).toBe(
      '--trace-warnings --inspect=9229',
    );
    expect(removeNodeOption(token, `${token}-other`)).toBe(`${token}-other`);
  });

  it('keeps independently managed preload tokens composable in either shutdown order', () => {
    const first = '--require=/tmp/first.cjs';
    const second = '--require=/tmp/second.cjs';
    expect(restoreNodeOptions(null, first, `${first} ${second}`, first)).toBe(second);
    expect(restoreNodeOptions(first, `${first} ${second}`, second, second)).toBeNull();
    expect(restoreNodeOptions(first, `${first} ${second}`, `${first} ${second}`, second)).toBe(
      first,
    );
  });

  it('restores the exact original but preserves later external changes', () => {
    const token = '--require=/tmp/guard.cjs';
    const original = "  --title='two  spaces'  ";
    const installed = `${original} ${token}`;
    expect(restoreNodeOptions(original, installed, installed, token)).toBe(original);
    expect(restoreNodeOptions(original, installed, `${installed}\t--inspect=9229`, token)).toBe(
      `${original}\t--inspect=9229`,
    );
    expect(
      restoreNodeOptions(
        `${original} ${token}`,
        `${original} ${token}`,
        `${original} ${token} --inspect`,
        token,
      ),
    ).toBe(`${original} ${token} --inspect`);
  });
});

describe('Codex Micro guard launchctl parsing', () => {
  it('distinguishes absent, empty, and present NODE_OPTIONS', () => {
    expect(parseLaunchEnvironmentNodeOptions(printed())).toEqual({ kind: 'absent' });
    expect(parseLaunchEnvironmentNodeOptions(printed(''))).toEqual({ kind: 'present', value: '' });
    expect(parseLaunchEnvironmentNodeOptions(printed('--trace-warnings'))).toEqual({
      kind: 'present',
      value: '--trace-warnings',
    });
  });

  it('ignores opaque service rows and nested service environments', () => {
    const input =
      'gui/501 = {\n\tenvironment = {\n\t\tPATH => /bin\n\t}\n\tservices = {\n' +
      '\t\t  58963 - application.example\n\t\tcom.example = {\n\t\t\tenvironment = {\n' +
      '\t\t\t\tNODE_OPTIONS => --wrong\n\t\t\t}\n\t\t}\n\t}\n}\n';
    expect(parseLaunchEnvironmentNodeOptions(input)).toEqual({ kind: 'absent' });
  });

  it.each([
    '',
    'gui/501 = {\n\tenvironment = {\n',
    'unexpected = {\n\tenvironment = {\n\t}\n}\n',
    'gui/501 = {\n\tservices = {\n\t}\n}\n',
  ])('rejects an unverified launchctl snapshot', (input) => {
    expect(parseLaunchEnvironmentNodeOptions(input)).toEqual({ kind: 'invalid' });
  });
});

describe('Codex Micro guard store and manager', () => {
  it('writes private files and rejects a symlinked support directory', () => {
    const store = temporaryStore();
    store.writeState({ version: 1, originalNodeOptions: null, installedNodeOptions: 'x' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.supportPath).mode & 0o777).toBe(0o700);
      expect(fs.statSync(store.statePath).mode & 0o777).toBe(0o600);
    }

    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-guard-link-'));
    roots.push(linkedRoot);
    fs.mkdirSync(path.join(linkedRoot, 'real'));
    fs.symlinkSync(
      path.join(linkedRoot, 'real'),
      path.join(linkedRoot, 'support'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => new CodexMicroGuardStore(path.join(linkedRoot, 'support')).prepare()).toThrow(
      'unsafe',
    );
  });

  it('rejects an expired lease heartbeat and safely reclaims stale leases', async () => {
    const store = temporaryStore();
    const staleLease = '22222222-2222-4222-8222-222222222222';
    const manager = new CodexMicroGuardManager(
      store,
      new FakeRunner([]),
      'gui/501',
      staleLease,
    );
    store.registerLease(staleLease, 100_000);

    await expect(manager.refreshHeartbeat(115_001)).rejects.toThrow(
      'lease is no longer fresh',
    );
    expect(store.releaseLease(LEASE_ID, 115_001)).toBe(false);
    expect(
      fs.existsSync(path.join(store.supportPath, `lease-${staleLease}.json`)),
    ).toBe(false);
  });

  it('enables from a verified snapshot and restores the original value', async () => {
    const store = temporaryStore();
    const runner = new FakeRunner([
      result(printed('--trace-warnings')),
      result(),
      result(printed(`--trace-warnings --require=${store.hookPath}`)),
      result(),
    ]);
    const manager = new CodexMicroGuardManager(store, runner, 'gui/501', LEASE_ID);

    await manager.enable('// hook\n', 100_000);
    expect(store.isFresh(100_000)).toBe(true);
    expect(store.readState()).toEqual({
      version: 1,
      originalNodeOptions: '--trace-warnings',
      installedNodeOptions: `--trace-warnings ${manager.token}`,
    });
    expect(runner.commands.slice(0, 2)).toEqual([
      ['print', 'gui/501'],
      ['setenv', 'NODE_OPTIONS', `--trace-warnings ${manager.token}`],
    ]);

    await manager.disable(100_000);
    expect(runner.commands.at(-1)).toEqual(['setenv', 'NODE_OPTIONS', '--trace-warnings']);
    expect(store.readState()).toBeNull();
    expect(store.isFresh(100_000)).toBe(false);
  });

  it('preserves NODE_OPTIONS changes made after activation', async () => {
    const store = temporaryStore();
    const token = `--require=${store.hookPath}`;
    store.writeState({
      version: 1,
      originalNodeOptions: '--trace-warnings',
      installedNodeOptions: `--trace-warnings ${token}`,
    });
    store.markEnabled();
    store.writeHeartbeat(100_000);
    const runner = new FakeRunner([
      result(printed(`--trace-warnings ${token} --inspect=9229`)),
      result(),
    ]);
    await new CodexMicroGuardManager(store, runner, 'gui/501', LEASE_ID).disable();
    expect(runner.commands.at(-1)).toEqual([
      'setenv',
      'NODE_OPTIONS',
      '--trace-warnings --inspect=9229',
    ]);
  });

  it('rolls markers and recovery state back when launchctl activation fails', async () => {
    const store = temporaryStore();
    const runner = new FakeRunner([result(printed()), result('', 9)]);
    const manager = new CodexMicroGuardManager(store, runner, 'gui/501', LEASE_ID);

    await expect(manager.enable('// hook\n')).rejects.toThrow(
      'launchctl command failed',
    );
    expect(store.readState()).toBeNull();
    expect(store.isFresh()).toBe(false);
  });

  it('deactivates the hook but keeps recovery state when restoration fails', async () => {
    const store = temporaryStore();
    const token = `--require=${store.hookPath}`;
    store.writeState({ version: 1, originalNodeOptions: null, installedNodeOptions: token });
    store.markEnabled();
    store.writeHeartbeat();
    const runner = new FakeRunner([result(printed(token)), result('', 7)]);

    await expect(
      new CodexMicroGuardManager(store, runner, 'gui/501', LEASE_ID).disable(),
    ).rejects.toThrow();
    expect(store.isFresh()).toBe(false);
    expect(store.readState()).not.toBeNull();
  });
});
