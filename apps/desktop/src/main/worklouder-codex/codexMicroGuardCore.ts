import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CodexMicroGuardStateRecord {
  version: 1;
  originalNodeOptions: string | null;
  installedNodeOptions: string;
}

export type LaunchEnvironmentNodeOptions =
  { kind: 'present'; value: string } | { kind: 'absent' } | { kind: 'invalid' };

export interface GuardCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface GuardCommandRunner {
  run(arguments_: readonly string[]): Promise<GuardCommandResult>;
}

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export class LaunchctlGuardCommandRunner implements GuardCommandRunner {
  async run(arguments_: readonly string[]): Promise<GuardCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/launchctl', [...arguments_], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.kill();
        reject(error);
      };
      timer = setTimeout(() => {
        fail(new Error('launchctl command timed out'));
      }, COMMAND_TIMEOUT_MS);
      const capture =
        (target: Buffer[]) =>
        (chunk: Buffer): void => {
          outputBytes += chunk.length;
          if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
            fail(new Error('launchctl output exceeded the safety limit'));
            return;
          }
          target.push(chunk);
        };
      child.stdout.on('data', capture(stdout));
      child.stderr.on('data', capture(stderr));
      child.once('error', fail);
      child.once('close', (status) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          status: status ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  }
}

export class CodexMicroGuardStore {
  readonly statePath: string;
  readonly enabledPath: string;
  readonly heartbeatPath: string;
  readonly hookPath: string;
  readonly receiptPath: string;

  constructor(readonly supportPath: string) {
    this.statePath = path.join(supportPath, 'state.json');
    this.enabledPath = path.join(supportPath, 'enabled');
    this.heartbeatPath = path.join(supportPath, 'heartbeat');
    this.hookPath = path.join(supportPath, 'guard-hook.cjs');
    this.receiptPath = path.join(supportPath, 'receipt.json');
  }

  prepare(): void {
    fs.mkdirSync(this.supportPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = fs.lstatSync(this.supportPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) {
      throw new Error('guard support path is unsafe');
    }
    fs.chmodSync(this.supportPath, PRIVATE_DIRECTORY_MODE);
  }

  installHook(contents: string): void {
    this.atomicWrite('guard-hook.cjs', contents);
    if (this.readPrivateFile('guard-hook.cjs') !== contents) {
      throw new Error('guard hook verification failed');
    }
  }

  readState(): CodexMicroGuardStateRecord | null {
    const text = this.readPrivateFileIfPresent('state.json');
    if (text === null) return null;
    const value = JSON.parse(text) as Partial<CodexMicroGuardStateRecord>;
    if (
      value.version !== 1 ||
      (value.originalNodeOptions !== null && typeof value.originalNodeOptions !== 'string') ||
      typeof value.installedNodeOptions !== 'string'
    ) {
      throw new Error('guard recovery state is invalid');
    }
    return value as CodexMicroGuardStateRecord;
  }

  writeState(state: CodexMicroGuardStateRecord): void {
    this.atomicWrite('state.json', JSON.stringify(state));
  }

  markEnabled(): void {
    this.atomicWrite('enabled', '');
  }

  writeHeartbeat(now: number = Date.now()): void {
    this.atomicWrite('heartbeat', JSON.stringify(now / 1_000));
  }

  isFresh(now: number = Date.now(), maximumAgeMs = 15_000): boolean {
    try {
      this.readPrivateFile('enabled');
      const heartbeat = JSON.parse(this.readPrivateFile('heartbeat')) as unknown;
      if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) return false;
      const ageMs = now - heartbeat * 1_000;
      return ageMs >= 0 && ageMs <= maximumAgeMs;
    } catch {
      return false;
    }
  }

  hasInterceptionReceipt(): boolean {
    try {
      const receipt = JSON.parse(this.readPrivateFile('receipt.json')) as Record<string, unknown>;
      return (
        typeof receipt.interceptedAt === 'number' &&
        Number.isFinite(receipt.interceptedAt) &&
        typeof receipt.service === 'string' &&
        /^service-[A-Za-z0-9_-]+\.js$/.test(receipt.service)
      );
    } catch {
      return false;
    }
  }

  removeEnabled(): void {
    this.removePrivateFile('enabled');
  }

  removeHeartbeat(): void {
    this.removePrivateFile('heartbeat');
  }

  removeState(): void {
    this.removePrivateFile('state.json');
  }

  removeReceipt(): void {
    this.removePrivateFile('receipt.json');
  }

  private readPrivateFileIfPresent(name: string): string | null {
    try {
      return this.readPrivateFile(name);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private readPrivateFile(name: string): string {
    this.prepare();
    const filename = path.join(this.supportPath, name);
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      const linked = fs.lstatSync(filename);
      if (
        !opened.isFile() ||
        opened.isSymbolicLink() ||
        !ownedByCurrentUser(opened) ||
        (opened.mode & 0o077) !== 0 ||
        opened.dev !== linked.dev ||
        opened.ino !== linked.ino
      ) {
        throw new Error('guard file is unsafe');
      }
      return fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private removePrivateFile(name: string): void {
    this.prepare();
    const filename = path.join(this.supportPath, name);
    try {
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error('refusing to remove a symlinked guard file');
      fs.unlinkSync(filename);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private atomicWrite(name: string, contents: string): void {
    this.prepare();
    const supportStat = fs.lstatSync(this.supportPath);
    const temporaryName = `.tmp-${process.pid}-${Date.now()}-${randomSuffix()}`;
    const temporaryPath = path.join(this.supportPath, temporaryName);
    const destinationPath = path.join(this.supportPath, name);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeFileSync(descriptor, contents, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      const currentSupportStat = fs.lstatSync(this.supportPath);
      if (
        currentSupportStat.dev !== supportStat.dev ||
        currentSupportStat.ino !== supportStat.ino ||
        currentSupportStat.isSymbolicLink()
      ) {
        throw new Error('guard support path changed while writing');
      }
      fs.renameSync(temporaryPath, destinationPath);
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      try {
        const temporaryStat = fs.lstatSync(temporaryPath);
        if (!temporaryStat.isSymbolicLink()) fs.unlinkSync(temporaryPath);
      } catch {
        // Best effort cleanup after the primary write failure.
      }
      throw error;
    }
  }
}

export class CodexMicroGuardManager {
  readonly token: string;

  constructor(
    readonly store: CodexMicroGuardStore,
    private readonly runner: GuardCommandRunner,
    private readonly launchctlDomain: string,
  ) {
    this.token = `--require=${store.hookPath}`;
  }

  async enable(hookContents: string, now: number = Date.now()): Promise<void> {
    if (/\s/u.test(this.store.hookPath)) {
      throw new Error('guard hook path must not contain whitespace');
    }
    this.store.removeReceipt();
    const original = await this.readNodeOptions();
    this.store.installHook(hookContents);
    const existing = this.store.readState();
    const canReuse = existing !== null && nodeOptionsContains(this.token, original);
    if (canReuse && !nodeOptionsContains(this.token, existing.installedNodeOptions)) {
      throw new Error('guard recovery state is inconsistent');
    }
    const installed = canReuse ? (original ?? this.token) : mergeNodeOptions(original, this.token);
    const stateWasCreated = !canReuse;
    if (stateWasCreated) {
      this.store.writeState({
        version: 1,
        originalNodeOptions: original,
        installedNodeOptions: installed,
      });
    }
    this.store.writeHeartbeat(now);

    let environmentInstalled = false;
    try {
      if (installed !== original) {
        await this.runLaunchctl(['setenv', 'NODE_OPTIONS', installed]);
        environmentInstalled = true;
      }
      this.store.markEnabled();
    } catch (error) {
      let rollbackFailed = false;
      try {
        this.store.removeEnabled();
        this.store.removeHeartbeat();
      } catch {
        rollbackFailed = true;
      }
      if (environmentInstalled) {
        try {
          await this.restoreEnvironment(original);
        } catch {
          rollbackFailed = true;
        }
      }
      if (stateWasCreated && !rollbackFailed) this.store.removeState();
      if (rollbackFailed) throw new Error('guard activation rollback failed');
      throw error;
    }
  }

  async disable(): Promise<void> {
    this.store.removeEnabled();
    try {
      let state: CodexMicroGuardStateRecord | null;
      try {
        state = this.store.readState();
      } catch {
        // Emergency recovery cannot reconstruct a corrupt snapshot. Removing
        // only Cindy's bounded token is safer than leaving a global preload in
        // place, and preserves every unrelated current option.
        state = null;
      }
      const current = await this.readNodeOptions();
      const restored = state
        ? restoreNodeOptions(
            state.originalNodeOptions,
            state.installedNodeOptions,
            current,
            this.token,
          )
        : removeNodeOption(this.token, current);
      await this.restoreEnvironment(restored);
      this.store.removeState();
    } finally {
      this.store.removeHeartbeat();
      this.store.removeReceipt();
    }
  }

  refreshHeartbeat(now: number = Date.now()): void {
    if (!this.store.isFresh(now)) throw new Error('guard heartbeat is no longer fresh');
    this.store.writeHeartbeat(now);
  }

  private async readNodeOptions(): Promise<string | null> {
    const result = await this.runLaunchctl(['print', this.launchctlDomain]);
    const parsed = parseLaunchEnvironmentNodeOptions(result.stdout);
    if (parsed.kind === 'invalid') throw new Error('launchctl environment snapshot is invalid');
    return parsed.kind === 'present' ? parsed.value : null;
  }

  private async restoreEnvironment(value: string | null): Promise<void> {
    if (value === null) await this.runLaunchctl(['unsetenv', 'NODE_OPTIONS']);
    else await this.runLaunchctl(['setenv', 'NODE_OPTIONS', value]);
  }

  private async runLaunchctl(arguments_: readonly string[]): Promise<GuardCommandResult> {
    const result = await this.runner.run(arguments_);
    if (result.status !== 0) throw new Error('launchctl command failed');
    return result;
  }
}

export function parseLaunchEnvironmentNodeOptions(input: string): LaunchEnvironmentNodeOptions {
  let depth = 0;
  let environmentDepth: number | null = null;
  let sawRoot = false;
  let rootClosed = false;
  let sawEnvironment = false;
  let nodeOptions: string | null = null;

  for (const rawLine of input.split('\n')) {
    const line = rawLine.replace(/^[ \t]+/u, '');
    if (line.length === 0) continue;
    if (depth === 0) {
      if (sawRoot || !/^gui\/\d+ = \{$/u.test(line)) return { kind: 'invalid' };
      sawRoot = true;
      depth = 1;
      continue;
    }
    if (line === '}') {
      depth -= 1;
      if (depth < 0) return { kind: 'invalid' };
      if (environmentDepth !== null && depth < environmentDepth) environmentDepth = null;
      if (depth === 0) rootClosed = true;
      continue;
    }
    const opensBlock = !line.includes('=>') && line.endsWith(' = {');
    if (opensBlock) {
      if (depth === 1 && line === 'environment = {') {
        if (sawEnvironment || environmentDepth !== null) return { kind: 'invalid' };
        sawEnvironment = true;
        environmentDepth = depth + 1;
      } else if (environmentDepth !== null) {
        return { kind: 'invalid' };
      }
      depth += 1;
      continue;
    }
    if (depth > 1 && environmentDepth === null) continue;
    if (!line.includes(' = ') && !line.includes(' => ') && !line.endsWith(' =>')) {
      return { kind: 'invalid' };
    }
    if (environmentDepth !== null && depth === environmentDepth) {
      const key = 'NODE_OPTIONS =>';
      if (line === key) {
        if (nodeOptions !== null) return { kind: 'invalid' };
        nodeOptions = '';
      } else if (line.startsWith(`${key} `)) {
        if (nodeOptions !== null) return { kind: 'invalid' };
        nodeOptions = line.slice(key.length + 1);
      } else if (line.startsWith('NODE_OPTIONS')) {
        return { kind: 'invalid' };
      }
    }
  }

  if (!sawRoot || !rootClosed || !sawEnvironment || depth !== 0 || environmentDepth !== null) {
    return { kind: 'invalid' };
  }
  return nodeOptions === null ? { kind: 'absent' } : { kind: 'present', value: nodeOptions };
}

export function nodeOptionsContains(token: string, value: string | null): boolean {
  return value?.split(/\s+/u).includes(token) ?? false;
}

export function mergeNodeOptions(current: string | null, token: string): string {
  if (!current) return token;
  return nodeOptionsContains(token, current) ? current : `${current} ${token}`;
}

export function removeNodeOption(token: string, current: string | null): string | null {
  if (current === null) return null;
  const range = boundedTokenRange(current, token);
  if (!range) return current;
  let [start, end] = range;
  if (start > 0) start -= 1;
  else if (end < current.length) end += 1;
  const result = current.slice(0, start) + current.slice(end);
  return result.length > 0 ? result : null;
}

export function restoreNodeOptions(
  original: string | null,
  installed: string,
  current: string | null,
  token: string,
): string | null {
  if (current === installed) return original;
  if (installed === original || current === null) return current;
  const range = boundedTokenRange(current, token);
  if (!range) return current;
  let [start, end] = range;
  if (start > 0) start -= 1;
  else if (end < current.length) end += 1;
  const result = current.slice(0, start) + current.slice(end);
  return result.length > 0 ? result : null;
}

function boundedTokenRange(value: string, token: string): [number, number] | null {
  let from = 0;
  while (from <= value.length - token.length) {
    const start = value.indexOf(token, from);
    if (start < 0) return null;
    const end = start + token.length;
    const beforeBoundary = start === 0 || /\s/u.test(value[start - 1] ?? '');
    const afterBoundary = end === value.length || /\s/u.test(value[end] ?? '');
    if (beforeBoundary && afterBoundary) return [start, end];
    from = end;
  }
  return null;
}

function ownedByCurrentUser(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12);
}
