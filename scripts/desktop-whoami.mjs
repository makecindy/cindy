#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';
import {
  buildDesktopDevVerdictFromWhoami,
  printDesktopDevVerdict,
} from './desktop-dev-verdict.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

/**
 * 进程表可以很大：`ps -eo …` 在这台机器上已经输出 1.6 MB（约 930 行），而
 * spawnSync 默认 maxBuffer 只有 1 MiB。溢出时 status 变成 null、stdout 只剩半截，
 * 旧实现把这种失败当成「系统里一个进程都没有」，于是基于进程归属的结论全部失真。
 */
export const PROCESS_TABLE_MAX_BYTES = 64 * 1024 * 1024;

function processScanFailure(result, message) {
  return {
    code: result?.error?.code ?? `EXIT_${result?.status ?? 'UNKNOWN'}`,
    message: result?.error?.message || message,
  };
}

export function parsePosixProcessTable(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
        : null;
    })
    .filter(Boolean);
}

/**
 * 读全量进程表。失败时返回 error 而不是空数组：调用方必须能区分
 * 「确实没有相关进程」和「进程表根本读不到」，后者不能拿来下任何结论。
 */
export function scanProcessTable({ platform = process.platform, runCommand = run } = {}) {
  if (platform === 'win32') {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
    const result = runCommand('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { maxBuffer: PROCESS_TABLE_MAX_BYTES });
    if (result.error || result.status !== 0) {
      return {
        processes: [],
        error: processScanFailure(result, 'powershell.exe did not return a process table'),
      };
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return {
        processes: (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
          pid: Number(item.ProcessId),
          ppid: Number(item.ParentProcessId) || 0,
          command: String(item.CommandLine ?? ''),
        })),
        error: null,
      };
    } catch {
      return {
        processes: [],
        error: { code: 'PROCESS_LIST_UNPARSABLE', message: 'powershell.exe output was not valid JSON' },
      };
    }
  }

  const result = runCommand('ps', ['-eo', 'pid=,ppid=,command='], {
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });
  if (result.error || result.status !== 0) {
    return { processes: [], error: processScanFailure(result, 'ps did not return a process table') };
  }
  return { processes: parsePosixProcessTable(result.stdout), error: null };
}

function normalize(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function commandContainsPath(command, candidatePath) {
  const normalizedCommand = command.replaceAll('\\', '/').toLowerCase();
  const normalizedPath = normalize(candidatePath).replace(/\/+$/, '');
  let index = normalizedCommand.indexOf(normalizedPath);
  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPath.length];
    const start = before === undefined || /\s|["'=]/.test(before);
    const end = after === undefined || after === '/' || after === '"' || after === "'";
    if (start && end) return true;
    index = normalizedCommand.indexOf(normalizedPath, index + 1);
  }
  return false;
}

export function parseWorktreeEntries(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { rootDir: path.resolve(line.slice('worktree '.length)), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return entries;
}

function repositoryWorktrees(cwd = rootDir) {
  const result = run('git', ['worktree', 'list', '--porcelain'], { cwd });
  if (result.status !== 0) return [{ rootDir: path.resolve(cwd), branch: null }];
  const entries = parseWorktreeEntries(result.stdout);
  return entries.length > 0 ? entries : [{ rootDir: path.resolve(cwd), branch: null }];
}

function extractArgumentPath(command, name) {
  const match = command.match(new RegExp(`--${name}=(.*?)(?=\\s--[A-Za-z0-9-]+=|\\s--[A-Za-z0-9-]+\\s|$)`));
  return match?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
}

function ancestorCommands(pid, byPid) {
  const commands = [];
  let cursor = byPid.get(pid)?.ppid ?? 0;
  for (let i = 0; cursor && i < 64; i += 1) {
    const owner = byPid.get(cursor);
    if (!owner) break;
    commands.push(owner.command);
    cursor = owner.ppid;
  }
  return commands;
}

function descendants(pid, processes) {
  const result = [];
  const queue = [pid];
  const byParent = new Map();
  for (const item of processes) {
    const list = byParent.get(item.ppid) ?? [];
    list.push(item);
    byParent.set(item.ppid, list);
  }
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of byParent.get(parent) ?? []) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function inferMode(commands) {
  if (commands.some((command) => command.includes('dev-local-env.mjs'))) return 'local';
  if (commands.some((command) => command.includes('dev-remote-env.mjs'))) return 'remote';
  return 'unknown';
}

function inferPassive(commands) {
  return commands.some((command) =>
    /XDT_SCHEDULER_PASSIVE=['"]?1(?:['"]|\b)/.test(command) ||
    /(?:^|\s)--passive(?:\s|$)/.test(command));
}

/** Identify Electron main processes and renderer readiness without trusting stale marker files. */
export function identifyDesktopProcesses(processes, worktrees) {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const result = [];
  for (const worktree of worktrees) {
    const electronRoot = path.join(worktree.rootDir, 'node_modules', 'electron');
    for (const proc of processes) {
      if (
        !commandContainsPath(proc.command, electronRoot) ||
        proc.command.includes('--type=') ||
        proc.command.includes('crashpad_handler')
      ) continue;

      const children = descendants(proc.pid, processes);
      const renderer = children.find((child) =>
        child.command.includes('--type=renderer') &&
        normalize(extractArgumentPath(child.command, 'app-path') ?? path.sep) ===
          normalize(path.join(worktree.rootDir, 'apps', 'desktop')));
      const userDataDir = children
        .map((child) => extractArgumentPath(child.command, 'user-data-dir'))
        .find(Boolean) ?? null;
      const commands = [proc.command, ...ancestorCommands(proc.pid, byPid)];
      result.push({
        pid: proc.pid,
        rootDir: worktree.rootDir,
        branch: worktree.branch,
        state: renderer ? 'ready' : 'starting',
        ready: Boolean(renderer),
        mode: inferMode(commands),
        passive: inferPassive(commands),
        isolated: null,
        userDataDir,
        commit: null,
        commitVerified: false,
        source: 'process-scan',
      });
    }
  }
  return result;
}

function defaultUserDataDir(region = 'global') {
  const dirName = desktopUserDataDirNameForRegion(region);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', dirName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), dirName);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function readInstanceRecords(userDataDirs, worktrees) {
  const roots = new Set(worktrees.map((entry) => normalize(entry.rootDir)));
  const records = [];
  for (const userDataDir of userDataDirs) {
    const directory = path.join(userDataDir, '.dev-instances');
    let names = [];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of names) {
      const filePath = path.join(directory, name);
      const record = readJson(filePath);
      if (
        record?.schemaVersion !== 1 ||
        !Number.isInteger(record.pid) ||
        !['starting', 'ready', 'failed'].includes(record.state) ||
        !isProcessAlive(record.pid)
      ) {
        continue;
      }
      if (typeof record.rootDir !== 'string' || !roots.has(normalize(record.rootDir))) continue;
      records.push(record);
    }
  }
  return records;
}

function gitHead(root) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function mergeDesktopInstanceRecords(scanned, records, worktrees) {
  const branchByRoot = new Map(worktrees.map((entry) => [normalize(entry.rootDir), entry.branch]));
  const byPid = new Map(scanned.map((item) => [item.pid, item]));
  for (const record of records) {
    const scannedItem = byPid.get(record.pid);
    byPid.set(record.pid, {
      ...(scannedItem ?? {}),
      pid: record.pid,
      rootDir: path.resolve(record.rootDir),
      branch: branchByRoot.get(normalize(record.rootDir)) ?? null,
      state: record.state,
      // A marker alone is never proof of a live UI: require the matching Electron
      // main + renderer process scan as a second, independent signal.
      ready: record.state === 'ready' && scannedItem?.ready === true,
      mode: record.mode,
      region: record.region ?? null,
      passive: Boolean(record.passive),
      isolated: Boolean(record.isolated),
      isolationIntent: record.isolationIntent === true,
      profileKind: typeof record.profileKind === 'string' ? record.profileKind : null,
      userDataDir: record.userDataDir,
      commit: record.commit ?? null,
      commitVerified: typeof record.commit === 'string' && record.commit.length > 0,
      startedAtMs: record.startedAtMs,
      updatedAtMs: record.updatedAtMs,
      source: 'record',
      ...(record.failure ? { failure: record.failure } : {}),
    });
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

function parseArgs(argv) {
  const options = { json: false, all: false, userDataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--user-data-dir') options.userDataDir = argv[++i] ?? null;
    else if (arg.startsWith('--user-data-dir=')) options.userDataDir = arg.slice('--user-data-dir='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printText(report) {
  console.log(report.match ? 'Desktop source: MATCH' : 'Desktop source: NO MATCH');
  console.log(`expected root: ${report.expected.rootDir}`);
  console.log(`expected HEAD: ${report.expected.commit ?? 'unknown'}`);
  if (report.processScan?.ok === false) {
    console.log(`process table: unavailable (${report.processScan.code}: ${report.processScan.message})`);
  }
  if (report.instances.length === 0) {
    console.log('active dev instances: none');
    return;
  }
  console.log('active dev instances:');
  for (const instance of report.instances) {
    console.log(
      `- pid=${instance.pid} state=${instance.state} mode=${instance.mode} region=${instance.region ?? 'unknown'} passive=${instance.passive}` +
      ` root=${instance.rootDir} commit=${instance.commit ?? 'unverified'} userData=${instance.userDataDir ?? 'unknown'}`,
    );
  }
}

/** Linux sandboxed renderers can retain their zygote argv. Require a PID from
 * the main-window readiness report AND a live descendant from the same binary. */
export function applyLinuxRendererEvidence(scanned, records, processes, platform = process.platform) {
  if (platform !== 'linux') return scanned;
  return scanned.map((instance) => {
    if (instance.ready) return instance;
    const record = records.find((record) => record.pid === instance.pid
      && typeof record.rootDir === 'string'
      && normalize(record.rootDir) === normalize(instance.rootDir));
    if (record?.state !== 'ready' || !Number.isSafeInteger(record.rendererPid) || record.rendererPid <= 0)
      return instance;
    const renderer = descendants(instance.pid, processes).find((child) => child.pid === record.rendererPid);
    if (!renderer || !/(?:^|\s)--type=zygote(?:\s|$)/.test(renderer.command)
      || !commandContainsPath(renderer.command, path.join(instance.rootDir, 'node_modules', 'electron')))
      return instance;
    return { ...instance, ready: true, state: 'ready' };
  });
}

export function collectDesktopWhoamiReport(options = {}) {
  const expectedRoot = path.resolve(options.rootDir ?? rootDir);
  const env = options.env ?? process.env;
  const region = resolveDesktopDevRegion([], env);
  const worktrees = options.worktrees ?? repositoryWorktrees(expectedRoot);
  const scan = options.processScan
    ?? (options.processes
      ? { processes: options.processes, error: null }
      : scanProcessTable());
  const processes = scan.processes;
  const preliminary = options.scanned ?? identifyDesktopProcesses(processes, worktrees);
  const userDataDirs = new Set([
    path.resolve(options.userDataDir ?? env.XDT_USER_DATA_DIR ?? defaultUserDataDir(region)),
    ...preliminary.map((item) => item.userDataDir).filter(Boolean).map((item) => path.resolve(item)),
  ]);
  const records = options.records ?? readInstanceRecords(userDataDirs, worktrees);
  const scanned = applyLinuxRendererEvidence(preliminary, records, processes, options.platform);
  const allInstances = mergeDesktopInstanceRecords(scanned, records, worktrees);
  const expectedCommit = options.commit === undefined ? gitHead(expectedRoot) : options.commit;
  const match = allInstances.some((instance) =>
    normalize(instance.rootDir) === normalize(expectedRoot) &&
    instance.ready &&
    instance.commitVerified &&
    instance.commit === expectedCommit);
  return {
    schemaVersion: 1,
    expected: { rootDir: expectedRoot, commit: expectedCommit },
    // 进程表读不到时 match 一定是 false；把原因带出去，让 verdict 能区分
    // 「没起」和「查不了」，而不是都塌成 WHOAMI_MISMATCH。
    processScan: scan.error
      ? { ok: false, code: scan.error.code, message: scan.error.message }
      : { ok: true },
    match,
    instances: options.all
      ? allInstances
      : allInstances.filter((instance) => normalize(instance.rootDir) === normalize(expectedRoot)),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = collectDesktopWhoamiReport({
    all: options.all,
    userDataDir: options.userDataDir,
  });
  const verdict = buildDesktopDevVerdictFromWhoami(report);
  if (options.json) console.log(JSON.stringify({ ...report, verdict }, null, 2));
  else {
    printText(report);
    printDesktopDevVerdict(verdict);
  }
  process.exitCode = verdict.state === 'ready' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`desktop:whoami: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
