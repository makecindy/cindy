/**
 * SSH config IO — read/write ~/.ssh/config in OpenSSH format.
 *
 * Phase A surface:
 *   - readSshConfig(): list every concrete host (skipping wildcards
 *     like `Host *` or `Host foo*`).
 *   - upsertHost(): add or replace one host block. Preserves all
 *     other entries verbatim.
 *   - removeHost(): drop one host block. No-op if absent.
 *
 * We intentionally do NOT inherit / merge wildcard rules in readSshConfig
 * — the renderer wants concrete hosts to display; `ssh` itself will apply
 * wildcards when we eventually exec it. Concrete-host enumeration is the
 * "user-facing" set.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import SSHConfig from 'ssh-config';

import type { HostConfig } from './types.js';

const DEFAULT_PORT = 22;

/** Resolve `~/.ssh/config` on the current OS. */
export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

interface SshConfigSection {
  type?: number;
  before?: string;
  after?: string;
  param?: string;
  /**
   * Separator between key and value as the ssh-config serializer expects it
   * (normally a single space). MUST be set on directive nodes we synthesize —
   * omitting it makes `toString()` emit `KeyundefinedValue` and corrupts the
   * file. See applyDirective insert path.
   */
  separator?: string;
  value?: string | string[];
  /** Present on comment nodes (type=2). */
  content?: string;
  config?: SshConfigSection[];
}

/** ssh-config AST: type=1 = directive, type=2 = comment, type=3 = blank line. */
const SSH_CONFIG_DIRECTIVE_TYPE = 1;
const SSH_CONFIG_COMMENT_TYPE = 2;

/**
 * Marker comment inside a host block that records the user's auth-method
 * choice. Needed because both 'agent + pinned key' and 'key' modes write
 * the same `IdentityFile + IdentitiesOnly yes` directives — we'd lose the
 * distinction on re-read otherwise.
 *
 * Reads as plain `#` comment to OpenSSH (ignored). Absence of the marker
 * with an IdentityFile present means "legacy key-file host" — we preserve
 * that interpretation for backward compat with hosts added before this
 * marker was introduced.
 */
const AUTH_MARKER_PREFIX = '# xdt-maker:auth=';

function readAuthMarker(section: SshConfigSection): 'agent' | 'key' | null {
  for (const child of section.config ?? []) {
    if (child.type !== SSH_CONFIG_COMMENT_TYPE) continue;
    const content = (child.content ?? '').trim();
    if (content === `${AUTH_MARKER_PREFIX}agent`) return 'agent';
    if (content === `${AUTH_MARKER_PREFIX}key`) return 'key';
  }
  return null;
}

function isHostDirective(section: SshConfigSection): boolean {
  return section.param?.toLowerCase() === 'host';
}

/**
 * Read and parse ~/.ssh/config (or any path). Returns a list of concrete
 * hosts — wildcards and `Match` blocks are skipped. Missing file → [].
 */
export async function readSshConfig(filePath = defaultSshConfigPath()): Promise<HostConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const parsed = SSHConfig.parse(raw) as SshConfigSection[];
  const hosts: HostConfig[] = [];

  for (const section of parsed) {
    if (!isHostDirective(section)) continue;
    const aliases = Array.isArray(section.value) ? section.value : [section.value];
    for (const aliasRaw of aliases) {
      if (typeof aliasRaw !== 'string') continue;
      const alias = aliasRaw.trim();
      if (!alias || alias.includes('*') || alias.includes('?') || alias.startsWith('!')) continue;

      // Pluck params out of this Host block (case-insensitive per spec).
      const params = new Map<string, string>();
      for (const child of section.config ?? []) {
        if (!child.param || typeof child.value !== 'string') continue;
        params.set(child.param.toLowerCase(), child.value);
      }

      const identityFile = params.get('identityfile');
      // Auth-method rules:
      //   IdentityFile absent → 'agent' (unfiltered, no key pin)
      //   IdentityFile present + marker says agent → 'agent' + pinned key
      //   IdentityFile present + marker says key → 'key'
      //   IdentityFile present + no marker → 'key' (legacy host, backward compat)
      const marker = readAuthMarker(section);
      const authMethod: 'agent' | 'key' = identityFile
        ? (marker === 'agent' ? 'agent' : 'key')
        : 'agent';
      hosts.push({
        id: alias,
        hostname: params.get('hostname') ?? alias,
        port: parseIntSafe(params.get('port'), DEFAULT_PORT),
        user: params.get('user') ?? os.userInfo().username,
        authMethod,
        identityFile: identityFile ? expandHome(identityFile) : undefined,
        source: 'ssh-config',
      });
    }
  }

  return hosts;
}

/**
 * Add a NEW host block to ~/.ssh/config. If a block with the same alias
 * exists it's replaced wholesale (use `updateHostFields` for surgical edits
 * that preserve hand-written directives like ProxyJump / ServerAliveInterval).
 *
 * Atomic write via temp file. Creates the dir + file with strict perms
 * when missing.
 */
export async function upsertHost(
  host: HostConfig,
  filePath = defaultSshConfigPath(),
): Promise<void> {
  const existing = await readRawConfig(filePath);
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];

  // Remove the complete block before appending the replacement. The ssh-config
  // library's `remove({ Host: alias })` matcher is case-sensitive on the
  // directive name, while OpenSSH treats keywords case-insensitively.
  removeHostSections(parsed, host.id);

  const append = SSHConfig.parse(formatHostBlock(host)) as SshConfigSection[];
  for (const node of append) {
    (parsed as unknown as { push(node: unknown): void }).push(node);
  }

  const out = (parsed as unknown as { toString(): string }).toString();
  await writeAtomic(filePath, out);
}

/** Remove all concrete Host blocks for an alias, regardless of keyword casing. */
function removeHostSections(parsed: SshConfigSection[], alias: string): void {
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const section = parsed[index];
    if (!isHostDirective(section)) continue;
    const values = Array.isArray(section.value) ? section.value : [section.value];
    if (values.includes(alias)) parsed.splice(index, 1);
  }
}

/**
 * Surgically update only the fields we own (HostName / User / Port /
 * IdentityFile / IdentitiesOnly) inside an existing host block, leaving
 * everything else (ProxyJump / ServerAliveInterval / Tag / comments / ...)
 * exactly as the user wrote them.
 *
 * Falls back to `upsertHost` if the host block doesn't exist on disk
 * (e.g. user removed it manually since we last hydrated).
 *
 * Updating an already-set directive mutates its `.value` in place — the
 * surrounding whitespace / comments are preserved by ssh-config's
 * `.toString()` serializer.
 *
 * Adding a new directive (e.g. switching from agent to key requires
 * inserting `IdentityFile`) appends to the block's nested config array
 * with synthesized whitespace that matches OpenSSH's convention (2-space
 * indent + trailing newline).
 *
 * Removing a directive (e.g. switching from key back to agent should drop
 * `IdentityFile` and `IdentitiesOnly`) is a `.filter` on the block's
 * nested config array.
 */
export async function updateHostFields(
  host: HostConfig,
  filePath = defaultSshConfigPath(),
): Promise<void> {
  const existing = await readRawConfig(filePath);
  if (!existing) {
    return upsertHost(host, filePath);
  }
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];

  const section = findHostSection(parsed, host.id);
  if (!section || !section.config) {
    // Block disappeared since we hydrated — recreate it cleanly. Caller's
    // pool will end up consistent with disk on next hydrate.
    return upsertHost(host, filePath);
  }

  // Build the (param, value-or-null) directives we want to project onto
  // the existing block. `null` = remove the directive entirely; a value
  // = set / replace.
  // Both auth modes can carry an identityFile:
  //   key   → identityFile is the private key we read directly (no agent).
  //   agent → identityFile is the public key we filter the agent down to.
  // In both cases we want OpenSSH CLI to mirror the behaviour — that means
  // IdentityFile + IdentitiesOnly yes so a terminal `ssh <alias>` doesn't
  // enumerate every agent key and trip MaxAuthTries.
  const hasPinnedKey = !!host.identityFile;
  const desired: Array<[string, string | null]> = [
    ['HostName', host.hostname],
    ['User', host.user],
    ['Port', host.port && host.port !== DEFAULT_PORT ? String(host.port) : null],
    ['IdentityFile', hasPinnedKey ? host.identityFile! : null],
    ['IdentitiesOnly', hasPinnedKey ? 'yes' : null],
  ];

  for (const [param, value] of desired) {
    applyDirective(section, param, value);
  }
  // Marker comment lives alongside the directives. Set/clear it based on
  // the post-edit auth method so we recover the choice on next read.
  applyAuthMarker(section, hasPinnedKey ? host.authMethod : null);

  const out = (parsed as unknown as { toString(): string }).toString();
  await writeAtomic(filePath, out);
}

/** Find a Host section whose value list contains exactly `alias`. */
function findHostSection(
  parsed: SshConfigSection[],
  alias: string,
): SshConfigSection | null {
  for (const section of parsed) {
    if (!isHostDirective(section)) continue;
    const values = Array.isArray(section.value) ? section.value : [section.value];
    if (values.includes(alias)) return section;
  }
  return null;
}

/**
 * Within a Host block's nested directive list, either:
 *  - set the named directive's value (mutates first matching entry, drops
 *    any duplicate matches — multiple `IdentityFile` lines collapse to one,
 *    which is the right behavior for our managed fields), OR
 *  - remove all matching directives entirely if `value === null`.
 *
 * Matches are case-insensitive (SSH config keys are).
 */
function applyDirective(
  section: SshConfigSection,
  param: string,
  value: string | null,
): void {
  const children = section.config ?? [];
  const lowerParam = param.toLowerCase();

  if (value === null) {
    section.config = children.filter(
      (c) => !c.param || c.param.toLowerCase() !== lowerParam,
    );
    return;
  }

  let matched = false;
  const next: SshConfigSection[] = [];
  for (const child of children) {
    if (child.param && child.param.toLowerCase() === lowerParam) {
      if (matched) continue; // drop dupes — only keep the first
      matched = true;
      child.value = value;
      next.push(child);
    } else {
      next.push(child);
    }
  }
  if (!matched) {
    // Insert a fresh directive at the end of the block. Whitespace matches
    // the rest of the block — 2-space indent + trailing newline is the
    // OpenSSH convention `formatHostBlock` also emits.
    next.push({
      type: SSH_CONFIG_DIRECTIVE_TYPE,
      before: '  ',
      after: '\n',
      param,
      // Without a separator the serializer emits `<param>undefined<value>`,
      // producing an unparseable directive that corrupts ~/.ssh/config.
      separator: ' ',
      value,
    });
  }
  section.config = next;
}

/**
 * Set/clear the `# xdt-maker:auth=...` marker comment inside a host block.
 *
 * Called from `updateHostFields` so the round-trip preserves the user's
 * choice between 'agent + pinned key' and 'key' modes (both share the
 * same `IdentityFile + IdentitiesOnly yes` directives on disk).
 *
 * Passing `method = null` removes any existing marker (used when the
 * directives that warrant it are themselves being removed).
 */
function applyAuthMarker(
  section: SshConfigSection,
  method: 'agent' | 'key' | null,
): void {
  const children = section.config ?? [];
  // Drop any existing marker first — handles toggling between agent/key
  // as well as the clear-on-removal case.
  const cleaned = children.filter((c) => {
    if (c.type !== SSH_CONFIG_COMMENT_TYPE) return true;
    const content = (c.content ?? '').trim();
    return !content.startsWith(AUTH_MARKER_PREFIX);
  });
  if (method === null) {
    section.config = cleaned;
    return;
  }
  cleaned.push({
    type: SSH_CONFIG_COMMENT_TYPE,
    before: '  ',
    after: '\n',
    content: `${AUTH_MARKER_PREFIX}${method}`,
  });
  section.config = cleaned;
}

/** Drop a host block. No-op if absent. */
export async function removeHost(
  alias: string,
  filePath = defaultSshConfigPath(),
): Promise<void> {
  const existing = await readRawConfig(filePath);
  if (!existing) return;
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  removeHostSections(parsed, alias);
  await writeAtomic(filePath, (parsed as unknown as { toString(): string }).toString());
}

// ── internals ──────────────────────────────────────────────────────────────

async function readRawConfig(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.maker.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function formatHostBlock(host: HostConfig): string {
  const lines = [
    `Host ${host.id}`,
    `  HostName ${host.hostname}`,
    `  User ${host.user}`,
  ];
  if (host.port && host.port !== DEFAULT_PORT) lines.push(`  Port ${host.port}`);
  // identityFile is meaningful for BOTH auth methods (private key for 'key',
  // public key fingerprint source for 'agent' pin). Either way, pair it with
  // IdentitiesOnly yes so terminal `ssh <alias>` doesn't enumerate every
  // agent key and trigger MaxAuthTries. We also stamp an `# xdt-maker:auth=`
  // marker so on re-read we can distinguish 'agent + pinned' from 'key'.
  if (host.identityFile) {
    lines.push(`  ${AUTH_MARKER_PREFIX}${host.authMethod}`);
    lines.push(`  IdentityFile ${host.identityFile}`);
    lines.push('  IdentitiesOnly yes');
  }
  // Leading blank line keeps blocks visually separated; trailing newline ends the block.
  return `\n${lines.join('\n')}\n`;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
