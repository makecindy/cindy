import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TerminalProgram } from '../terminalPrompt.js';

const exec = promisify(execFile);

/**
 * Who is asking through Cindy's askpass helper. Only a real system `sudo`,
 * `ssh` / `ssh-add` or git's HTTPS transport may receive the owner's answer:
 * those read the helper's output themselves. A direct call by the agent, a
 * script it wrote, or `git credential fill` (which prints the password) is
 * refused, so the answer can never come back to the agent through stdout.
 *
 * Threat boundary (design 4.3): this stops accidental and prompt-induced
 * leaks. It is not a sandbox against an agent that is itself malicious and
 * replaces system tools under a package-manager prefix it can write to.
 */

export interface ProcessFacts {
  pid: number;
  ppid: number;
  /** Effective uid. */
  uid: number;
  args: string;
}

export interface ProcessProbe {
  facts(pid: number): Promise<ProcessFacts | null>;
  /** Real executable path; null when it cannot be read (other users' processes). */
  executable(pid: number): Promise<string | null>;
}

export interface VerifiedAsker {
  program: TerminalProgram;
  /** The command the owner should recognise, e.g. `sudo -A brew install x` or `git push origin main`. */
  command: string;
  /** Origin from the verified Git transport, never from the prompt alone. */
  gitOrigin?: string;
}

export type ChainVerdict = { ok: true; asker: VerifiedAsker } | { ok: false; reason: string };

/** Install roots that only an administrator or a package manager populates. */
const SYSTEM_ROOTS: RegExp[] = [
  /^\/usr\/bin\//,
  /^\/bin\//,
  /^\/usr\/libexec\//,
  /^\/usr\/lib\/git-core\//,
  /^\/usr\/local\//,
  /^\/opt\/homebrew\//,
  /^\/opt\/local\//,
  /^\/Library\/Developer\/CommandLineTools\//,
  /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\//,
  /^\/nix\/store\//,
  /^\/run\/current-system\/sw\//,
];

const SSH_NAMES = new Set(['ssh', 'ssh-add']);
const GIT_TRANSPORTS = new Set(['git-remote-http', 'git-remote-https']);
const COMMAND_MAX = 1000;

function isSystemPath(file: string): boolean {
  const normal = path.posix.normalize(file);
  return normal === file && SYSTEM_ROOTS.some((root) => root.test(normal));
}

function argv0Name(args: string): string {
  return path.posix.basename(args.trim().split(/\s+/)[0] ?? '');
}

function shorten(command: string): string {
  const clean = command.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > COMMAND_MAX ? `${clean.slice(0, COMMAND_MAX - 1)}…` : clean;
}

/**
 * @param helperPid pid the helper reported for itself (the curl it exec'd into)
 * @param expectHelperArg text that must appear in that process's arguments (the private socket path)
 */
export async function verifyAskpassChain(
  probe: ProcessProbe,
  helperPid: number,
  expectHelperArg: string,
  userUid: number,
): Promise<ChainVerdict> {
  const helper = await probe.facts(helperPid);
  if (!helper || helper.uid !== userUid || !helper.args.includes(expectHelperArg) || argv0Name(helper.args) !== 'curl')
    return { ok: false, reason: 'helper' };
  const helperExe = await probe.executable(helperPid);
  if (!helperExe || !isSystemPath(helperExe) || path.posix.basename(helperExe) !== 'curl')
    return { ok: false, reason: 'helper' };

  return verifyAsker(probe, helper, userUid);
}

/** The preflight shell can receive guidance only; the credential path still requires curl. */
export async function verifyAskpassRecoveryChain(
  probe: ProcessProbe,
  helperPid: number,
  helperPath: string,
  userUid: number,
): Promise<ChainVerdict> {
  const helper = await probe.facts(helperPid);
  if (!helper || helper.uid !== userUid || argv0Name(helper.args) !== 'sh')
    return { ok: false, reason: 'helper' };
  const argv0 = helper.args.trim().split(/\s+/)[0];
  const invocation = `${argv0} ${helperPath}`;
  if (helper.args !== invocation && !helper.args.startsWith(`${invocation} `))
    return { ok: false, reason: 'helper' };
  const exe = await probe.executable(helperPid);
  if (!exe || !isSystemPath(exe) || !['sh', 'bash', 'dash'].includes(path.posix.basename(exe)))
    return { ok: false, reason: 'helper' };
  return verifyAsker(probe, helper, userUid, true);
}

async function verifyAsker(probe: ProcessProbe, helper: ProcessFacts, userUid: number, metadataOnly = false): Promise<ChainVerdict> {
  const parent = await probe.facts(helper.ppid);
  if (!parent) return { ok: false, reason: 'parent' };
  const name = argv0Name(parent.args);

  // sudo is setuid root: an imitation cannot run with an effective uid of 0.
  if (name === 'sudo') {
    if (parent.uid !== 0) return { ok: false, reason: 'sudo' };
    return { ok: true, asker: { program: 'sudo', command: shorten(parent.args) } };
  }

  if (parent.uid !== userUid) return { ok: false, reason: 'parent' };
  const exe = await probe.executable(parent.pid);
  if (!exe) return { ok: false, reason: 'parent' };
  const exeName = path.posix.basename(exe);
  // Bundled Git may live outside system roots. It can receive non-secret recovery
  // guidance, but the credential-delivery path keeps its original system-path gate.
  if (!isSystemPath(exe) && !(metadataOnly && GIT_TRANSPORTS.has(exeName)))
    return { ok: false, reason: 'parent' };

  if (SSH_NAMES.has(exeName)) {
    return { ok: true, asker: { program: exeName as 'ssh' | 'ssh-add', command: shorten(parent.args) } };
  }
  // git prompts for HTTPS credentials from its transport helper only. `git`
  // itself asking (e.g. `git credential fill`) would print the answer.
  if (GIT_TRANSPORTS.has(exeName) || GIT_TRANSPORTS.has(name)) {
    if (!GIT_TRANSPORTS.has(exeName)) return { ok: false, reason: 'git' };
    const gitOrigin = transportOrigin(parent.args);
    return { ok: true, asker: {
      program: 'git', command: shorten(await gitCommand(probe, parent)),
      ...(gitOrigin ? { gitOrigin } : {}),
    } };
  }
  return { ok: false, reason: 'parent' };
}

function transportOrigin(command: string): string | undefined {
  // Git's transport argv ends with the remote URL. Ambiguous/truncated argv is
  // insufficient evidence for recovery; ordinary credential handling still works.
  const remote = command.match(/ (https?:\/\/[^\s]+)$/)?.[1];
  if (!remote) return undefined;
  try { return new URL(remote).origin; } catch { return undefined; }
}

/** The git command the agent ran, skipping git's own `git remote-http` hop. */
async function gitCommand(probe: ProcessProbe, transport: ProcessFacts): Promise<string> {
  let command = transport.args;
  let ppid = transport.ppid;
  for (let depth = 0; depth < 3; depth++) {
    const up = await probe.facts(ppid);
    if (!up || argv0Name(up.args) !== 'git') break;
    command = up.args;
    if (!/^\S+\s+remote-https?\b/.test(up.args)) break;
    ppid = up.ppid;
  }
  return command;
}

/** `ps` for process facts; `/proc` on Linux and `lsof` on macOS for the executable. */
export function createSystemProcessProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  return {
    async facts(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return null;
      try {
        const { stdout } = await exec('/bin/ps', ['-ww', '-o', 'pid=,ppid=,uid=,args=', '-p', String(pid)], {
          timeout: 3000,
          maxBuffer: 256 * 1024,
        });
        const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/s);
        if (!match || Number(match[1]) !== pid) return null;
        return { pid, ppid: Number(match[2]), uid: Number(match[3]), args: match[4] };
      } catch {
        return null;
      }
    },
    async executable(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return null;
      if (platform === 'linux') return readlink(`/proc/${pid}/exe`).catch(() => null);
      try {
        const { stdout } = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
          timeout: 3000,
          maxBuffer: 256 * 1024,
        });
        const first = stdout.split('\n').find((line) => line.startsWith('n/'));
        return first ? first.slice(1) : null;
      } catch {
        return null;
      }
    },
  };
}
