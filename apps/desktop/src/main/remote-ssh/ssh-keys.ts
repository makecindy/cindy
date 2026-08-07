/**
 * ssh-keys — backend for the "Setup SSH key" wizard.
 *
 * Operations are deliberately READ-ONLY by default. The only mutating ops
 * are `generateNewKey` (writes a key pair under ~/.ssh/) and the install
 * command is rendered as a string for the user to run themselves — we do
 * NOT spawn `ssh-copy-id` here because it needs interactive password
 * input which would require a PTY round-trip we haven't built.
 *
 * Security boundaries:
 *   - Only ever READ existing pubkeys (`.pub` files). Private keys are
 *     never opened or transmitted.
 *   - Generated keys land in ~/.ssh/ with file mode 600 (ssh-keygen's
 *     default — we don't override).
 *   - Fingerprints surfaced to the UI are SHA256-prefixed (`SHA256:...`)
 *     so they're harmless to log / display.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

export interface LocalSshKey {
  /** absolute path to private key (e.g. /Users/foo/.ssh/id_ed25519). */
  privateKeyPath: string;
  /** absolute path to public key (privateKeyPath + ".pub"). */
  pubkeyPath: string;
  /** key type: "ed25519" | "rsa" | "ecdsa" | "dsa" | "unknown". */
  type: string;
  /** comment field from the .pub file (typically "user@host"). */
  comment: string;
  /** `SHA256:...` fingerprint as reported by `ssh-keygen -lf`. */
  fingerprintSha256: string | null;
  /** true if this key's fingerprint is currently loaded in ssh-agent. */
  inAgent: boolean;
  /** mtime of private key file (ISO) — used for "recently created" hints. */
  mtimeIso: string | null;
}

export interface GenerateNewKeyResult {
  privateKeyPath: string;
  pubkeyPath: string;
  pubkeyContent: string;
  fingerprintSha256: string | null;
}

const SSH_DIR_DEFAULT = path.join(os.homedir(), '.ssh');

// ── public API ────────────────────────────────────────────────────────────

/**
 * Scan ~/.ssh/ for all key pairs: every file with a matching ".pub" sibling.
 * Returns metadata only — never reads private key contents.
 *
 * Each key gets cross-referenced against ssh-agent's currently loaded
 * fingerprints (`ssh-add -l`) so the UI can show "in agent" badges.
 */
export async function listLocalSshKeys(): Promise<LocalSshKey[]> {
  const dir = SSH_DIR_DEFAULT;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  // Find every <name>.pub that has a matching private key <name>.
  const pairs: { priv: string; pub: string }[] = [];
  const nameSet = new Set(names);
  for (const name of names) {
    if (!name.endsWith('.pub')) continue;
    const privName = name.slice(0, -'.pub'.length);
    if (!nameSet.has(privName)) continue;
    pairs.push({
      priv: path.join(dir, privName),
      pub: path.join(dir, name),
    });
  }

  const agentFingerprints = await listAgentFingerprints();

  const keys: LocalSshKey[] = [];
  for (const { priv, pub } of pairs) {
    keys.push(await readKeyMetadata(priv, pub, agentFingerprints));
  }

  // Stable order: ed25519 first (recommended), then rsa, then others; tie-break by name.
  keys.sort((a, b) => {
    const rank = (t: string) =>
      t === 'ed25519' ? 0 : t === 'rsa' ? 1 : t === 'ecdsa' ? 2 : 3;
    const r = rank(a.type) - rank(b.type);
    if (r !== 0) return r;
    return a.privateKeyPath.localeCompare(b.privateKeyPath);
  });
  return keys;
}

/**
 * Generate a new ed25519 key pair at `~/.ssh/<name>`. If `passphrase`
 * is non-empty the private key file is encrypted with it; otherwise the
 * key is stored unencrypted (user can `ssh-keygen -p -f <path>` later
 * to retrofit a passphrase). `name` defaults to `cindy` — bumps with
 * `-1`, `-2`, ... on collision so we never overwrite. (2026-07-17 品牌翻转:
 * 只影响之后新生成的密钥文件名;用户已有密钥按显式路径保存,不受影响。)
 *
 * The passphrase is passed to ssh-keygen via the `-N` arg, which means
 * it briefly appears in our argv and ssh-keygen's argv. ssh-keygen
 * doesn't log argv anywhere accessible to other users, and the maker
 * process's argv is only readable by the same user; that's the same
 * exposure model as typing it on a shell command line.
 *
 * We DO NOT store the passphrase anywhere after this call returns.
 * Caller is responsible for piping it directly into `addKeyToAgent`
 * if they want the key loaded into ssh-agent (which is the recommended
 * post-generation step — see header).
 */
export async function generateNewKey(opts: {
  name?: string;
  comment?: string;
  passphrase?: string;
}): Promise<GenerateNewKeyResult> {
  const baseName = sanitizeFilename(opts.name ?? 'cindy');
  const comment = opts.comment ?? `cindy@${os.hostname()}`;
  const passphrase = opts.passphrase ?? '';
  const dir = SSH_DIR_DEFAULT;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const privPath = await pickNonCollidingPath(dir, baseName);
  const pubPath = `${privPath}.pub`;

  // ssh-keygen flags:
  //   -t ed25519    : key type (smallest, fastest, most secure widely-supported)
  //   -f <path>     : output private key path (.pub written alongside)
  //   -N <pass>     : passphrase ("" = unencrypted)
  //   -C <comment>  : embedded comment (shows in .pub last field)
  //   -q            : quiet (suppress randomart / banner)
  await execFileP('ssh-keygen', [
    '-t', 'ed25519',
    '-f', privPath,
    '-N', passphrase,
    '-C', comment,
    '-q',
  ]);

  // Verify both files now exist (defensive — ssh-keygen failures should throw
  // already, but `_, stderr` shapes vary by build).
  await fs.access(privPath);
  await fs.access(pubPath);

  const pubkeyContent = (await fs.readFile(pubPath, 'utf-8')).trim();
  const fingerprintSha256 = await readFingerprint(pubPath);
  return { privateKeyPath: privPath, pubkeyPath: pubPath, pubkeyContent, fingerprintSha256 };
}

/**
 * Coarse classification of why ssh-add failed. The renderer maps this to
 * platform-specific remediation (install ssh-add, start ssh-agent, retype
 * passphrase) rather than parsing the English `errorHint` string.
 *
 * We deliberately collapse "ssh-add binary missing" and "ssh-agent not
 * reachable" into one bucket — distinguishing them is unreliable across
 * OpenSSH variants and they share the same remediation path ("get the
 * agent stack working").
 */
export type AgentFailureReason =
  | 'agent_unavailable'  // ssh-add missing OR ssh-agent down OR SSH_AUTH_SOCK absent
  | 'bad_passphrase'     // passphrase rejected
  | 'no_such_file'       // key path missing on disk
  | 'other';             // unclassified — show raw stderr in details

export interface AddKeyToAgentResult {
  success: boolean;
  /**
   * Coarse class for the UI to render platform-specific guidance. Null when
   * success=true.
   */
  failureReason: AgentFailureReason | null;
  /**
   * Short English message for logs / details panel. UI should NOT show this
   * directly to the user — `failureReason` drives the dialog copy.
   */
  errorHint: string | null;
  /** Raw stderr — for the logger / details panel, not the user-facing toast. */
  stderr: string;
}

/**
 * Load a private key into the user's ssh-agent. Designed to be called
 * IMMEDIATELY after `generateNewKey` (passing the freshly typed passphrase
 * in memory) so the user types it once at creation and never again.
 *
 * Passphrase handling — see this file's header for the full security model.
 * Briefly: passphrase is written to a temp script under `os.tmpdir()` with
 * mode 0700; ssh-add reads it via SSH_ASKPASS; the script is overwritten
 * with zeros and unlinked in `finally`. The window in which the passphrase
 * exists on disk is the time ssh-add takes to invoke the askpass helper
 * (milliseconds). Same-uid attackers could in principle read it; that's
 * the same threat model as the user manually typing `ssh-add` in their own
 * terminal (where the passphrase is in their shell process memory).
 *
 * Platform notes:
 *  - macOS: we pass `--apple-use-keychain` so the passphrase is cached in
 *    the user's Keychain → ssh-agent re-loads the key automatically after
 *    reboot. End result: passphrase typed exactly once, ever.
 *  - Linux: no Keychain equivalent. Key stays in agent until reboot /
 *    agent restart, at which point user clicks "Unlock" in the wizard
 *    and types passphrase again. We don't cache.
 *  - Windows: ssh-add exists (Win10 1809+) but SSH_ASKPASS support is
 *    spotty. We try anyway; if it fails the UI falls back to "open a
 *    terminal and run ssh-add <path> yourself".
 */
export async function addKeyToAgent(opts: {
  privateKeyPath: string;
  passphrase?: string;
}): Promise<AddKeyToAgentResult> {
  const { privateKeyPath, passphrase } = opts;

  // Deterministic pre-flight: confirm the private key actually exists BEFORE
  // handing the path to ssh-add. ssh-add's failure mode for a missing file is
  // inconsistent across platforms — on Windows OpenSSH it prints
  // "No such file or directory" (→ no_such_file), but a Git Bash / MSYS
  // ssh-add can emit "Could not open a connection to your authentication
  // agent" instead (→ agent_unavailable), sending the user down the wrong
  // remediation path. We classify the path problem ourselves and carry the
  // real path in the hint so the UI can say "key file not found at <path>".
  try {
    await fs.access(privateKeyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        failureReason: 'no_such_file',
        errorHint: `private key file not found: ${privateKeyPath}`,
        stderr: String((err as Error).message),
      };
    }
    // Non-ENOENT IO error (permissions etc.) — fall through so ssh-add
    // attempts the key and buildFailure classifies its stderr downstream.
  }

  // No passphrase = key is unencrypted; ssh-add doesn't need to prompt
  // and we can skip the askpass dance entirely.
  if (!passphrase) {
    try {
      const args = sshAddArgs(privateKeyPath);
      // execFile defaults to pipes (not inherit) so ssh-add won't grab a tty.
      const result = await execFileP('ssh-add', args);
      return { success: true, failureReason: null, errorHint: null, stderr: result.stderr };
    } catch (err) {
      return buildFailure(err);
    }
  }

  // Encrypted key: feed passphrase via SSH_ASKPASS. We write a tiny helper
  // script under os.tmpdir() that just emits the passphrase to stdout.
  // ssh-add invokes it when it needs the passphrase.
  //
  // Windows note: file extension MUST be `.cmd` (or `.bat`/`.exe`) — Windows'
  // `CreateProcessW` rejects `.sh` with error 193 (ERROR_BAD_EXE_FORMAT)
  // because it has no concept of shebangs. The Windows OpenSSH ssh-add
  // calls the askpass via `posix_spawnp`, which on Win32 maps straight to
  // CreateProcessW.
  const askpassExt = process.platform === 'win32' ? '.cmd' : '.sh';
  const askpassPath = path.join(os.tmpdir(), `xdt-askpass-${process.pid}-${Date.now()}${askpassExt}`);
  let scriptContent: string;
  if (process.platform === 'win32') {
    // `echo(<text>` idiom: parens after echo bypass the ECHO ON/OFF parse
    // path, so passphrases happening to equal "on" / "off" / "." are emitted
    // literally instead of toggling echo state. setlocal disabledelayedexpansion
    // ensures `!` chars in the passphrase aren't expanded as variables.
    const winSafe = passphrase
      .replace(/%/g, '%%')              // suppress %VAR% expansion
      .replace(/[&|<>()^]/g, '^$&');    // escape cmd meta chars
    scriptContent = `@echo off\r\nsetlocal disabledelayedexpansion\r\necho(${winSafe}\r\n`;
  } else {
    // POSIX sh: single-quoted printf is unambiguous; escape only ' itself.
    const safePass = passphrase.replace(/'/g, `'\\''`);
    scriptContent = `#!/bin/sh\nprintf '%s\\n' '${safePass}'\n`;
  }

  await fs.writeFile(askpassPath, scriptContent, { mode: 0o700 });

  try {
    const args = sshAddArgs(privateKeyPath);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      // Force askpass even when no tty — OpenSSH 8.4+ flag. Older versions
      // ignore it gracefully. Required on most modern Linux/macOS.
      SSH_ASKPASS_REQUIRE: 'force',
    };
    // Some Linux distros refuse to invoke askpass without DISPLAY set; pick
    // a benign default. Harmless on macOS / Windows.
    if (process.platform === 'linux' && !env.DISPLAY) env.DISPLAY = ':0';

    const result = await execFileP('ssh-add', args, { env });
    return { success: true, failureReason: null, errorHint: null, stderr: result.stderr };
  } catch (err) {
    return buildFailure(err);
  } finally {
    // Best-effort: overwrite then delete so passphrase doesn't linger in
    // filesystem free-blocks. fs.unlink alone leaves the contents readable
    // until the inode is reused.
    try {
      await fs.writeFile(askpassPath, '0'.repeat(scriptContent.length));
      await fs.unlink(askpassPath);
    } catch {
      /* best effort */
    }
  }
}

function sshAddArgs(privateKeyPath: string): string[] {
  if (process.platform === 'darwin') {
    // --apple-use-keychain caches the passphrase in macOS Keychain so the
    // user only types it once, ever (system ssh-agent reloads the key
    // automatically after reboot). Newer macOS only — older built-in
    // OpenSSH uses -K with the same semantics; --apple-use-keychain is
    // accepted on all macOS-shipped builds we care about (12+).
    return ['--apple-use-keychain', privateKeyPath];
  }
  return [privateKeyPath];
}

/**
 * Coarse-classify a thrown error from `execFileP('ssh-add', ...)` into the
 * three buckets the UI knows how to render. The classification is intentionally
 * conservative — anything we can't pattern-match falls into `'other'` and the
 * user sees the generic "use ssh-config fallback" panel.
 */
function classifyAgentFailure(err: unknown): { reason: AgentFailureReason; hint: string } {
  const e = err as NodeJS.ErrnoException & { stderr?: string; message: string };
  const stderr = String(e.stderr ?? '');
  const msg = stderr || e.message;

  // ENOENT from execFile = binary missing from PATH entirely (ssh-add not
  // installed). Group with agent-down because both have the same fix path
  // from the user's perspective: get the local ssh-agent stack working.
  if (e.code === 'ENOENT' || /not.*found|command not found/i.test(msg)) {
    return { reason: 'agent_unavailable', hint: 'ssh-add binary not found on PATH' };
  }
  if (/agent.*not.*running|could not open.*authentication agent|communication.*authentication agent/i.test(msg)) {
    return { reason: 'agent_unavailable', hint: 'ssh-agent is not running / SSH_AUTH_SOCK unreachable' };
  }
  if (/incorrect|bad passphrase|wrong passphrase/i.test(msg)) {
    return { reason: 'bad_passphrase', hint: 'passphrase rejected by ssh-add' };
  }
  // Note: addKeyToAgent's fs.access pre-flight now handles the missing-key-file
  // case before ssh-add runs, so this branch only catches post-spawn "no such
  // file" errors (ssh-add runtime dependency missing, etc.).
  if (/no such file|enoent/i.test(msg)) {
    return { reason: 'no_such_file', hint: 'private key file not found at expected path' };
  }
  return { reason: 'other', hint: `ssh-add failed: ${msg.slice(0, 200)}` };
}

function buildFailure(err: unknown): AddKeyToAgentResult {
  const { reason, hint } = classifyAgentFailure(err);
  return {
    success: false,
    failureReason: reason,
    errorHint: hint,
    stderr: String((err as Error & { stderr?: string }).stderr ?? (err as Error).message),
  };
}

/** Read a `.pub` file as plain text. Bounded size (4KB) — pubkeys are tiny. */
export async function readPubkey(pubkeyPath: string): Promise<string> {
  const stat = await fs.stat(pubkeyPath);
  if (stat.size > 4096) {
    throw new Error(`pubkey file unexpectedly large (${stat.size} bytes): ${pubkeyPath}`);
  }
  return (await fs.readFile(pubkeyPath, 'utf-8')).trim();
}

/**
 * Render the install command the user should run from THEIR terminal to
 * install the pubkey on the remote. We don't run it for them — `ssh-copy-id`
 * needs interactive password input which is out of scope for this iteration.
 *
 * Platform behaviour:
 *  - macOS / Linux: `ssh-copy-id` is shipped with OpenSSH; emit it directly.
 *  - Windows: the stock `OpenSSH_for_Windows_*` does NOT include ssh-copy-id.
 *    We emit a PowerShell-ready one-liner that delegates to Git Bash's
 *    bundled ssh-copy-id (Git for Windows is near-universal among devs).
 *    If the user doesn't have Git installed, the UI surfaces a fallback
 *    note pointing them at the manual `type | ssh` approach.
 *
 * Returns a shell-ready single-line command.
 */
export function buildInstallCommand(
  user: string,
  hostname: string,
  port: number | undefined,
  pubkeyPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const portArg = port && port !== 22 ? `-p ${port} ` : '';
  if (platform === 'win32') {
    // Convert Windows path → POSIX form bash can resolve. Keys under
    // ~/.ssh/ get the tilde shorthand; anything else falls back to the
    // Git Bash drive-prefix form (/c/Users/foo/...).
    const bashPubkey = toGitBashPath(pubkeyPath);
    // `& '...bash.exe'` is PowerShell's call operator for paths with spaces.
    // -l = login shell (loads PATH so /usr/bin/ssh-copy-id is visible).
    // -c "<cmd>" = run the bash command string verbatim.
    return `& 'C:\\Program Files\\Git\\bin\\bash.exe' -lc "ssh-copy-id ${portArg}-i ${bashPubkey} ${user}@${hostname}"`;
  }
  return `ssh-copy-id ${portArg}-i ${shellQuote(pubkeyPath)} ${user}@${hostname}`;
}

/**
 * Map a Windows absolute path to the form Git Bash expects.
 *
 * Examples:
 *   C:\Users\Foo\.ssh\id_ed25519.pub  →  ~/.ssh/id_ed25519.pub
 *   D:\projects\keys\bar.pub          →  /d/projects/keys/bar.pub
 *
 * The first form is preferred (shorter, more portable across machines)
 * when the file lives under the user's home `.ssh` directory.
 */
function toGitBashPath(p: string): string {
  const home = os.homedir();
  const sshDir = path.join(home, '.ssh');
  if (p === sshDir || p.startsWith(sshDir + path.sep)) {
    const rel = p.slice(sshDir.length + 1).replace(/\\/g, '/');
    return `~/.ssh/${rel}`;
  }
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) {
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  return p;
}

// ── internals ─────────────────────────────────────────────────────────────

async function readKeyMetadata(
  priv: string,
  pub: string,
  agentFingerprints: ReadonlyArray<string>,
): Promise<LocalSshKey> {
  let pubContent = '';
  try {
    pubContent = (await fs.readFile(pub, 'utf-8')).trim();
  } catch {
    /* leave empty — keys missing pubkey content are still listable */
  }

  // .pub format: "<type> <base64-key> <comment...>"
  const parts = pubContent.split(/\s+/);
  const typeRaw = parts[0] ?? '';
  const type = typeRaw.startsWith('ssh-') ? typeRaw.slice('ssh-'.length)
    : typeRaw.startsWith('ecdsa-') ? 'ecdsa'
    : typeRaw === 'sk-ssh-ed25519@openssh.com' ? 'ed25519-sk'
    : typeRaw === 'sk-ecdsa-sha2-nistp256@openssh.com' ? 'ecdsa-sk'
    : typeRaw || 'unknown';
  const comment = parts.slice(2).join(' ');

  const fingerprintSha256 = await readFingerprint(pub);
  const inAgent = fingerprintSha256 != null && agentFingerprints.includes(fingerprintSha256);

  let mtimeIso: string | null = null;
  try {
    const stat = await fs.stat(priv);
    mtimeIso = new Date(stat.mtime).toISOString();
  } catch {
    /* leave null */
  }

  return {
    privateKeyPath: priv,
    pubkeyPath: pub,
    type,
    comment,
    fingerprintSha256,
    inAgent,
    mtimeIso,
  };
}

/**
 * Run `ssh-add -l` to list fingerprints currently loaded in the user's
 * ssh-agent. Returns empty array if agent is unreachable / empty / not
 * installed. Errors are swallowed because this is metadata only —
 * worst case the UI shows "in agent: unknown".
 */
async function listAgentFingerprints(): Promise<string[]> {
  try {
    const { stdout } = await execFileP('ssh-add', ['-l']);
    // ssh-add -l output: "<bits> SHA256:<...> <comment> (<type>)"
    const out: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = /SHA256:[A-Za-z0-9+/=]+/.exec(line);
      if (m) out.push(m[0]);
    }
    return out;
  } catch {
    return [];
  }
}

async function readFingerprint(pubkeyPath: string): Promise<string | null> {
  try {
    // -l = print fingerprint; -f = input file; default hash is SHA256.
    const { stdout } = await execFileP('ssh-keygen', ['-lf', pubkeyPath]);
    const m = /SHA256:[A-Za-z0-9+/=]+/.exec(stdout);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Return a path under `dir` whose basename starts with `base` and does NOT
 * collide with an existing file. First tries `<base>` itself; on collision
 * appends `-1`, `-2`, ... until free.
 *
 * We never overwrite an existing key — losing a private key the user
 * actually depends on would be catastrophic.
 */
async function pickNonCollidingPath(dir: string, base: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const candidate = path.join(dir, i === 0 ? base : `${base}-${i}`);
    if (!(await pathExists(candidate)) && !(await pathExists(`${candidate}.pub`))) {
      return candidate;
    }
  }
  // 100 collisions is absurd — bail rather than spin forever.
  throw new Error(`too many existing keys named ${base}-N under ${dir}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sanitizeFilename(s: string): string {
  // Strip anything that could escape ~/.ssh/ or break shell quoting.
  // Conservative whitelist: alnum + dash + underscore. Replace others with `-`.
  const cleaned = s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'cindy';
}

function shellQuote(s: string): string {
  // POSIX single-quote escape.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
