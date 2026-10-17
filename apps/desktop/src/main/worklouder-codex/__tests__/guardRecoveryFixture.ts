import fs from 'node:fs';
import path from 'node:path';
import {
  CodexMicroGuardStore,
  type GuardCommandResult,
  type GuardCommandRunner,
} from '../codexMicroGuardCore.js';

/** In-memory launchctl replacement; never reads or changes the real GUI environment. */
export class GuardEnvironmentRunner implements GuardCommandRunner {
  readonly commands: string[][] = [];
  failNextMutation = false;
  ignoreMutations = false;
  invalidSnapshot = false;

  constructor(public nodeOptions: string | null) {}

  async run(arguments_: readonly string[]): Promise<GuardCommandResult> {
    this.commands.push([...arguments_]);
    if (arguments_[0] === 'print') {
      const entry = this.nodeOptions === null ? '' : 'NODE_OPTIONS => ' + this.nodeOptions + '\n';
      return {
        status: 0,
        stdout: this.invalidSnapshot
          ? 'invalid'
          : 'gui/501 = {\n\tenvironment = {\n' + entry + '\t}\n}\n',
        stderr: '',
      };
    }
    if (this.failNextMutation) {
      this.failNextMutation = false;
      return { status: 7, stdout: '', stderr: 'fixture failure' };
    }
    if (!this.ignoreMutations) {
      if (arguments_[0] === 'setenv') this.nodeOptions = arguments_[2];
      if (arguments_[0] === 'unsetenv') this.nodeOptions = null;
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

/** Materialize only legacy-format files, including the lease of a still-running old version. */
export function seedLegacyGuard(store: CodexMicroGuardStore, original: string | null = null) {
  const token = '--require=' + store.hookPath;
  store.installHook('// retained legacy hook\n');
  store.writeState({
    version: 1,
    originalNodeOptions: original,
    installedNodeOptions: original ? original + ' ' + token : token,
  });
  store.markEnabled();
  store.registerLease('11111111-1111-4111-8111-111111111111', Date.now());
  fs.writeFileSync(path.join(store.supportPath, 'receipt.json'), '{}', { mode: 0o600 });
  return token;
}
