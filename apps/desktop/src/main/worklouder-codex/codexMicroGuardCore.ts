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
const LEASE_NAME =
  /^lease-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const LEASE_MAX_AGE_MS = 15_000;
const LEASE_LOCK_NAME = '.lease-lock';

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
  /** Written by releases where protection defaults on; legacy migration then never reruns. */
  readonly defaultOnPath: string;

  constructor(readonly supportPath: string) {
    this.statePath = path.join(supportPath, 'state.json');
    this.enabledPath = path.join(supportPath, 'enabled');
    this.heartbeatPath = path.join(supportPath, 'heartbeat');
    this.hookPath = path.join(supportPath, 'guard-hook.cjs');
    this.receiptPath = path.join(supportPath, 'receipt.json');
    this.defaultOnPath = path.join(supportPath, 'default-on');
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
    this.markDefaultOn();
  }

  markDefaultOn(): void {
    this.atomicWrite('default-on', '');
  }

  /** The hook outlives disabling; without the marker it came from a default-off release. */
  hasLegacyHook(): boolean {
    return fs.existsSync(this.hookPath) && !fs.existsSync(this.defaultOnPath);
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

  async withLeaseLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5_000;
    let identity: fs.Stats | null = null;
    while (!identity) {
      identity = this.tryCreateLeaseLock();
      if (identity) break;
      if (this.reclaimAbandonedLeaseLock()) continue;
      if (Date.now() >= deadline) throw new Error('guard lease lock timed out');
      await delay(25);
    }
    try {
      return await operation();
    } finally {
      this.releaseLeaseLock(identity);
    }
  }

  registerLease(leaseId: string, now: number): void {
    this.listFreshLeaseTimes(now);
    this.atomicWrite(leaseFilename(leaseId), JSON.stringify(now / 1_000));
    this.writeHeartbeat(now);
  }

  refreshLease(leaseId: string, now: number): void {
    const timestamp = parseLeaseTimestamp(this.readPrivateFile(leaseFilename(leaseId)));
    if (!isFreshTimestamp(timestamp, now)) throw new Error('guard lease is no longer fresh');
    this.atomicWrite(leaseFilename(leaseId), JSON.stringify(now / 1_000));
    this.writeHeartbeat(now);
  }

  releaseLease(leaseId: string, now: number): boolean {
    this.removePrivateFile(leaseFilename(leaseId));
    const fresh = this.listFreshLeaseTimes(now);
    if (fresh.length === 0) {
      this.removeHeartbeat();
      return false;
    }
    this.writeHeartbeat(Math.max(...fresh));
    return true;
  }

  private listFreshLeaseTimes(now: number): number[] {
    this.prepare();
    const fresh: number[] = [];
    for (const name of fs.readdirSync(this.supportPath)) {
      if (!LEASE_NAME.test(name)) continue;
      let timestamp: number;
      try {
        timestamp = parseLeaseTimestamp(this.readPrivateFile(name));
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (isFreshTimestamp(timestamp, now)) fresh.push(timestamp);
      else this.removePrivateFile(name);
    }
    return fresh;
  }

  private releaseLeaseLock(identity: fs.Stats): void {
    const lockPath = path.join(this.supportPath, LEASE_LOCK_NAME);
    const current = fs.lstatSync(lockPath);
    if (current.isSymbolicLink() || !sameIdentity(current, identity)) {
      throw new Error('guard lease lock changed while held');
    }
    fs.rmdirSync(lockPath);
  }

  private tryCreateLeaseLock(): fs.Stats | null {
    this.prepare();
    const lockPath = path.join(this.supportPath, LEASE_LOCK_NAME);
    try {
      fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      fs.chmodSync(lockPath, PRIVATE_DIRECTORY_MODE);
      return fs.lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
  }

  private reclaimAbandonedLeaseLock(): boolean {
    const lockPath = path.join(this.supportPath, LEASE_LOCK_NAME);
    try {
      const stat = fs.lstatSync(lockPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) {
        throw new Error('guard lease lock is unsafe');
      }
      if (Date.now() - stat.mtimeMs <= 30_000) return false;
      const stalePath = path.join(this.supportPath, `.stale-lock-${randomSuffix()}`);
      fs.renameSync(lockPath, stalePath);
      fs.rmdirSync(stalePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return true;
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
        !hasPrivatePermissions(opened) ||
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

/** Retires legacy global preloads across all Cindy profiles in the current user's GUI domain. */
export class CodexMicroGuardManager {
  readonly token: string;
  private readonly rootStore: CodexMicroGuardStore;

  constructor(
    readonly store: CodexMicroGuardStore,
    private readonly runner: GuardCommandRunner,
    private readonly launchctlDomain: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.token = `--require=${store.hookPath}`;
    this.rootStore = new CodexMicroGuardStore(path.dirname(store.supportPath));
  }

  /**
   * Protection is suspended (#5985). Retire every profile's preload, even if
   * an old instance still has a live lease. Keep hook files for processes that
   * already inherited NODE_OPTIONS; removing the environment cannot update them.
   */
  async recover(): Promise<void> {
    const inherited = this.environment.NODE_OPTIONS;
    let inheritedFailed = false;
    if (inherited !== undefined) {
      try {
        const cleaned = this.stripNodeOptions(inherited);
        if (cleaned === null) delete this.environment.NODE_OPTIONS;
        else this.environment.NODE_OPTIONS = cleaned;
      } catch {
        inheritedFailed = true;
      }
    }
    // Profiles share launchctl's environment. New instances must serialize the
    // complete read/remove/write transaction, not just each profile's files.
    await this.rootStore.withLeaseLock(() => this.recoverLocked());
    if (inheritedFailed) throw new Error('guard inherited environment could not be cleaned');
  }

  private stripNodeOptions(value: string | null): string | null {
    return stripLegacyGuardNodeOptions(value, this.rootStore.supportPath, this.store.hookPath);
  }

  private async recoverLocked(): Promise<void> {
    const profiles = new Set<string>();
    if (fs.existsSync(this.store.supportPath)) profiles.add(this.store.supportPath);
    for (const name of fs.readdirSync(this.rootStore.supportPath)) {
      if (/^[0-9a-f]{12}$/u.test(name)) profiles.add(path.join(this.rootStore.supportPath, name));
    }
    const cleanedStores: CodexMicroGuardStore[] = [];
    const states: CodexMicroGuardStateRecord[] = [];
    let filesFailed = false;
    for (const profile of profiles) {
      const store = new CodexMicroGuardStore(profile);
      try {
        await store.withLeaseLock(async () => {
          store.removeEnabled();
          store.removeHeartbeat();
          store.removeReceipt();
          try {
            const state = store.readState();
            if (state) states.push(state);
          } catch {
            // A missing/corrupt snapshot must not keep the known preload active.
          }
        });
        cleanedStores.push(store);
      } catch {
        // Still remove the global preload if one profile's files are unsafe or
        // inaccessible. Expose recovery-required so cleanup can be retried.
        filesFailed = true;
      }
    }

    const current = await this.readNodeOptions();
    let restored = this.stripNodeOptions(current);
    // Preserve an explicitly empty original value. Never restore snapshot text:
    // another profile's original value can contain a preload already retired.
    if (restored === null && current !== null && hasEmptyOriginalNodeOptions(current, states))
      restored = '';
    if (restored !== current) {
      await this.restoreEnvironment(restored);
      const actual = await this.readNodeOptions();
      if (this.stripNodeOptions(actual) !== actual) {
        throw new Error('guard preload remains in the launch environment');
      }
    }
    for (const store of cleanedStores) {
      try {
        await store.withLeaseLock(async () => store.removeState());
      } catch {
        filesFailed = true;
      }
    }
    if (filesFailed) throw new Error('guard legacy files could not be deactivated');
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

function hasEmptyOriginalNodeOptions(
  current: string,
  states: readonly CodexMicroGuardStateRecord[],
): boolean {
  const values = new Set([current]);
  for (const value of values) {
    for (const state of states) {
      if (state.installedNodeOptions !== value) continue;
      if (state.originalNodeOptions === '') return true;
      if (state.originalNodeOptions !== null) values.add(state.originalNodeOptions);
    }
  }
  return false;
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

/** Remove only preload arguments pointing at Cindy's known legacy hook layout. */
export function stripLegacyGuardNodeOptions(
  value: string | null,
  supportRoot: string,
  currentHookPath: string,
): string | null {
  if (value === null) return null;
  const arguments_: Array<{ start: number; end: number; value: string }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (/\s/u.test(value[cursor])) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    let argument = '';
    let quoted = false;
    while (cursor < value.length) {
      const character = value[cursor];
      if (!quoted && /\s/u.test(character)) break;
      if (character === '"') quoted = !quoted;
      else if (quoted && character === '\\' && cursor + 1 < value.length) {
        argument += value[++cursor];
      } else argument += character;
      cursor += 1;
    }
    if (quoted) throw new Error('guard cannot safely parse NODE_OPTIONS');
    arguments_.push({ start, end: cursor, value: argument });
  }
  const isGuardHook = (filename: string): boolean => {
    if (filename === currentHookPath) return true;
    const profile = path.basename(path.dirname(filename));
    return (
      /^[0-9a-f]{12}$/u.test(profile) &&
      filename === path.join(supportRoot, profile, 'guard-hook.cjs')
    );
  };
  const removals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument.value.startsWith('--require=') && isGuardHook(argument.value.slice(10))) {
      removals.push(argument);
    } else if (
      (argument.value === '--require' || argument.value === '-r') &&
      arguments_[index + 1] &&
      isGuardHook(arguments_[index + 1].value)
    ) {
      removals.push({ start: argument.start, end: arguments_[++index].end });
    }
  }
  let cleaned = value;
  for (const removal of removals.reverse()) {
    let { start, end } = removal;
    // Retain unrelated options, quoting and whitespace byte-for-byte, removing
    // just one separator owned by the appended token (as legacy recovery did).
    if (start > 0) start -= 1;
    else if (end < cleaned.length) end += 1;
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return cleaned.length > 0 || removals.length === 0 ? cleaned : null;
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

function leaseFilename(leaseId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(leaseId)) {
    throw new Error('guard lease id is invalid');
  }
  return `lease-${leaseId}.json`;
}

function parseLeaseTimestamp(input: string): number {
  const seconds = JSON.parse(input) as unknown;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return Number.NaN;
  return seconds * 1_000;
}

function isFreshTimestamp(timestamp: number, now: number): boolean {
  const age = now - timestamp;
  return age >= 0 && age <= LEASE_MAX_AGE_MS;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ownedByCurrentUser(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function hasPrivatePermissions(stat: fs.Stats): boolean {
  // Windows does not expose POSIX permission bits and this guard is unsupported
  // there. Keep the store testable without weakening the macOS runtime check.
  return process.platform === 'win32' || (stat.mode & 0o077) === 0;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12);
}
