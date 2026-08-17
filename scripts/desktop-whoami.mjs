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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
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

function repositoryWorktrees() {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) return [{ rootDir, branch: null }];
  const entries = parseWorktreeEntries(result.stdout);
  return entries.length > 0 ? entries : [{ rootDir, branch: null }];
}

function listProcesses() {
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
    const result = run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ]);
    if (result.status !== 0 || !result.stdout.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
        pid: Number(item.ProcessId),
        ppid: Number(item.ParentProcessId) || 0,
        command: String(item.CommandLine ?? ''),
      }));
    } catch {
      return [];
    }
  }

  const result = run('ps', ['-eo', 'pid=,ppid=,command=']);
  if (result.status !== 0) return [];
  return result.stdout
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const region = resolveDesktopDevRegion([], process.env);
  const worktrees = repositoryWorktrees();
  const processes = listProcesses();
  const preliminary = identifyDesktopProcesses(processes, worktrees);
  const userDataDirs = new Set([
    path.resolve(options.userDataDir ?? process.env.XDT_USER_DATA_DIR ?? defaultUserDataDir(region)),
    ...preliminary.map((item) => item.userDataDir).filter(Boolean).map((item) => path.resolve(item)),
  ]);
  const scanned = preliminary;
  const records = readInstanceRecords(userDataDirs, worktrees);
  const allInstances = mergeDesktopInstanceRecords(scanned, records, worktrees);
  const expectedCommit = gitHead(rootDir);
  const match = allInstances.some((instance) =>
    normalize(instance.rootDir) === normalize(rootDir) &&
    instance.ready &&
    instance.commitVerified &&
    instance.commit === expectedCommit);
  const report = {
    schemaVersion: 1,
    expected: { rootDir, commit: expectedCommit },
    match,
    instances: options.all
      ? allInstances
      : allInstances.filter((instance) => normalize(instance.rootDir) === normalize(rootDir)),
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  process.exitCode = match ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`desktop:whoami: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
