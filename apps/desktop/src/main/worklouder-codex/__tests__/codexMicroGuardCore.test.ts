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
  stripLegacyGuardNodeOptions,
} from '../codexMicroGuardCore.js';

import { GuardEnvironmentRunner, seedLegacyGuard } from './guardRecoveryFixture';

const roots: string[] = [];

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

describe('paused Codex Micro guard recovery', () => {
  function fixture(original: string | null = '--trace-warnings') {
    const store = temporaryStore();
    const token = seedLegacyGuard(store, original);
    const runner = new GuardEnvironmentRunner(original ? original + ' ' + token : token);
    const environment = { NODE_OPTIONS: runner.nodeOptions! };
    const manager = new CodexMicroGuardManager(store, runner, 'gui/501', environment);
    return { store, token, runner, environment, manager };
  }

  it('clears an active legacy lease, retains its hook, and preserves external options exactly', async () => {
    const original = '  --title="two  spaces"  ';
    const { store, runner, manager, environment } = fixture(original);
    await manager.recover();
    expect(runner.nodeOptions).toBe(original);
    expect(environment.NODE_OPTIONS).toBe(original);
    expect(store.isFresh()).toBe(false);
    expect(store.readState()).toBeNull();
    expect(fs.readFileSync(store.hookPath, 'utf8')).toBe('// retained legacy hook\n');
    expect(fs.existsSync(store.receiptPath)).toBe(false);
    const mutations = runner.commands.filter(([command]) => command !== 'print');
    expect(mutations).toEqual([['setenv', 'NODE_OPTIONS', original]]);
    await manager.recover();
    expect(runner.commands.filter(([command]) => command !== 'print')).toEqual(mutations);
  });

  it.each([null, ''])('restores an original %j environment distinctly', async (original) => {
    const { runner, manager } = fixture(original);
    await manager.recover();
    expect(runner.nodeOptions).toBe(original);
  });

  it.each([
    { original: null, profileCount: 2 },
    { original: '', profileCount: 2 },
    { original: null, profileCount: 3 },
    { original: '', profileCount: 3 },
  ])(
    'restores original $original distinctly through $profileCount sequential profile snapshots',
    async ({ original, profileCount }) => {
      const { store, runner, manager } = fixture(original);
      const stores = [store];
      for (let profileIndex = 1; profileIndex < profileCount; profileIndex += 1) {
        const nextStore = new CodexMicroGuardStore(
          path.join(path.dirname(store.supportPath), profileIndex.toString(16).padStart(12, '0')),
        );
        const nextToken = seedLegacyGuard(nextStore, runner.nodeOptions);
        runner.nodeOptions = mergeNodeOptions(runner.nodeOptions, nextToken);
        stores.push(nextStore);
      }

      await manager.recover();

      expect(runner.nodeOptions).toBe(original);
      const expectedMutations =
        original === null ? [['unsetenv', 'NODE_OPTIONS']] : [['setenv', 'NODE_OPTIONS', '']];
      expect(runner.commands.filter(([command]) => command !== 'print')).toEqual(expectedMutations);
      for (const profileStore of stores) {
        expect(profileStore.isFresh()).toBe(false);
        expect(profileStore.readState()).toBeNull();
        expect(fs.existsSync(profileStore.hookPath)).toBe(true);
      }
      await manager.recover();
      expect(runner.nodeOptions).toBe(original);
      expect(runner.commands.filter(([command]) => command !== 'print')).toEqual(expectedMutations);
    },
  );

  it('does not infer an empty original from an unrelated profile snapshot', async () => {
    const { store, runner, manager } = fixture(null);
    const unrelated = new CodexMicroGuardStore(
      path.join(path.dirname(store.supportPath), 'aaaaaaaaaaaa'),
    );
    seedLegacyGuard(unrelated, '');

    await manager.recover();

    expect(runner.nodeOptions).toBeNull();
    expect(runner.commands.filter(([command]) => command !== 'print')).toEqual([
      ['unsetenv', 'NODE_OPTIONS'],
    ]);
  });

  it('terminates a cyclic snapshot chain without inventing an empty original', async () => {
    const { store, token, runner, manager } = fixture(null);
    const second = new CodexMicroGuardStore(
      path.join(path.dirname(store.supportPath), 'aaaaaaaaaaaa'),
    );
    const secondToken = seedLegacyGuard(second, token);
    runner.nodeOptions = mergeNodeOptions(token, secondToken);
    store.writeState({
      version: 1,
      originalNodeOptions: runner.nodeOptions,
      installedNodeOptions: token,
    });

    await manager.recover();

    expect(runner.nodeOptions).toBeNull();
    expect(store.readState()).toBeNull();
    expect(second.readState()).toBeNull();
  });

  it('removes all profiles and duplicate arguments without restoring another profile from a snapshot', async () => {
    const { store, token, runner, manager } = fixture(null);
    const second = new CodexMicroGuardStore(
      path.join(path.dirname(store.supportPath), 'aaaaaaaaaaaa'),
    );
    const secondToken = seedLegacyGuard(second, token);
    runner.nodeOptions = token + ' ' + secondToken + ' ' + token + ' --inspect=9229';
    await manager.recover();
    expect(runner.nodeOptions).toBe('--inspect=9229');
    expect(second.isFresh()).toBe(false);
    expect(second.readState()).toBeNull();
    expect(fs.existsSync(second.hookPath)).toBe(true);
  });

  it('cleans known preload paths even when a profile or its recovery state has disappeared', async () => {
    const { store, token, runner, manager } = fixture();
    store.removeState();
    const missing = path.join(path.dirname(store.supportPath), 'bbbbbbbbbbbb', 'guard-hook.cjs');
    runner.nodeOptions = '--require=' + missing + ' ' + token;
    await manager.recover();
    expect(runner.nodeOptions).toBeNull();
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('cleans a corrupt recovery snapshot without using its contents', async () => {
    const { store, runner, manager } = fixture();
    fs.writeFileSync(store.statePath, 'broken');
    await manager.recover();
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(store.readState()).toBeNull();
  });

  it('keeps options added after activation', async () => {
    const { runner, manager } = fixture();
    runner.nodeOptions += ' --inspect=9229';
    await manager.recover();
    expect(runner.nodeOptions).toBe('--trace-warnings --inspect=9229');
  });

  it('stops interception and keeps recovery evidence after a failed write, then retries', async () => {
    const { store, runner, manager, environment } = fixture();
    runner.failNextMutation = true;
    await expect(manager.recover()).rejects.toThrow('launchctl command failed');
    expect(store.isFresh()).toBe(false);
    expect(store.readState()).not.toBeNull();
    expect(environment.NODE_OPTIONS).toBe('--trace-warnings');
    await manager.recover();
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(store.readState()).toBeNull();
  });

  it('does not report cleanup complete when launchctl still contains the preload', async () => {
    const { store, runner, manager } = fixture();
    runner.ignoreMutations = true;
    await expect(manager.recover()).rejects.toThrow('remains in the launch environment');
    expect(store.readState()).not.toBeNull();
  });

  it('still clears the GUI environment if the inherited options cannot be safely parsed', async () => {
    const { runner, manager, environment } = fixture();
    environment.NODE_OPTIONS = '--title="unfinished';
    await expect(manager.recover()).rejects.toThrow('inherited environment');
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(environment.NODE_OPTIONS).toBe('--title="unfinished');
  });

  it('does not mutate an unverified launchctl snapshot', async () => {
    const { store, runner, manager } = fixture();
    runner.invalidSnapshot = true;
    await expect(manager.recover()).rejects.toThrow('snapshot is invalid');
    expect(runner.commands).toEqual([['print', 'gui/501']]);
    expect(store.isFresh()).toBe(false);
  });

  it('serializes concurrent cleanup from different profiles without losing unrelated options', async () => {
    const { store, runner, manager } = fixture();
    const second = new CodexMicroGuardStore(
      path.join(path.dirname(store.supportPath), 'cccccccccccc'),
    );
    runner.nodeOptions += ' ' + seedLegacyGuard(second, runner.nodeOptions);
    const other = new CodexMicroGuardManager(second, runner, 'gui/501', {});
    await Promise.all([manager.recover(), other.recover()]);
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(runner.commands.filter(([command]) => command === 'setenv')).toHaveLength(1);
  });

  it('clears the preload but does not follow a symlinked profile or erase the target files', async () => {
    const { store, runner, manager } = fixture();
    const outside = path.join(path.dirname(store.supportPath), 'unrelated');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'enabled'), 'keep');
    const linked = path.join(path.dirname(store.supportPath), 'dddddddddddd');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    runner.nodeOptions += ' --require=' + path.join(linked, 'guard-hook.cjs');
    await expect(manager.recover()).rejects.toThrow('legacy files could not be deactivated');
    expect(runner.nodeOptions).toBe('--trace-warnings');
    expect(fs.readFileSync(path.join(outside, 'enabled'), 'utf8')).toBe('keep');
  });

  it('writes private state and rejects a symlinked support root', async () => {
    const store = temporaryStore();
    store.writeState({ version: 1, originalNodeOptions: null, installedNodeOptions: 'x' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.supportPath).mode & 0o777).toBe(0o700);
      expect(fs.statSync(store.statePath).mode & 0o777).toBe(0o600);
    }
    const outside = temporaryStore();
    outside.prepare();
    const linked = path.join(path.dirname(store.supportPath), 'linked');
    fs.symlinkSync(outside.supportPath, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new CodexMicroGuardManager(
      new CodexMicroGuardStore(path.join(linked, 'aaaaaaaaaaaa')),
      new GuardEnvironmentRunner(null),
      'gui/501',
      {},
    );
    await expect(manager.recover()).rejects.toThrow('unsafe');
    expect(fs.readdirSync(outside.supportPath)).toEqual([]);
  });
});

describe('legacy preload argument boundaries', () => {
  const root = path.join(os.tmpdir(), 'CindyCodexMicroGuard');
  const hook = path.join(root, 'aaaaaaaaaaaa', 'guard-hook.cjs');
  // Quoted NODE_OPTIONS strings escape Windows separators just as Node expects.
  const quotedHook = JSON.stringify(hook);
  const strip = (value: string | null) => stripLegacyGuardNodeOptions(value, root, hook);

  it.each([
    '--require=' + hook,
    '--require=' + quotedHook,
    '--require ' + quotedHook,
    '-r ' + quotedHook,
  ])('removes a real preload argument: %s', (argument) => {
    expect(strip('--trace-warnings ' + argument + ' --inspect=9229')).toBe(
      '--trace-warnings --inspect=9229',
    );
    expect(strip(argument)).toBeNull();
  });

  it('preserves similarly named files, other scripts, and quoted option values', () => {
    const lookalike = '--require=' + hook + '.backup';
    const elsewhere = '--require=' + path.join(os.tmpdir(), 'other', 'guard-hook.cjs');
    const embedded = '--title=' + JSON.stringify('literal --require=' + hook + ' text');
    const value = lookalike + ' ' + elsewhere + ' ' + embedded;
    expect(strip(value)).toBe(value);
    expect(strip(value + ' --require=' + hook)).toBe(value);
  });

  it('keeps absence and empty values unchanged and rejects malformed quotes', () => {
    expect(strip(null)).toBeNull();
    expect(strip('')).toBe('');
    expect(() => strip('--title="unfinished')).toThrow('cannot safely parse');
  });
});
