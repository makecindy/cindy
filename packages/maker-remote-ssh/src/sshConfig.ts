/**
 * SSH config IO — read ~/.ssh/config in OpenSSH format.
 *
 * Phase A surface:
 *   - readSshConfig(): list every concrete host (skipping wildcards
 *     like `Host *` or `Host foo*`).
 *   - upsertHost(): add or replace one host block. Preserves all
 *     other entries verbatim.
 *   - removeHost(): drop one host block. No-op if absent.
 *
 * Reading follows the part of OpenSSH semantics that matters to Cindy:
 * unconditional top-level Include files are expanded — including an unindented
 * Include between Host/Match blocks, the usual `config.d` layout — then the
 * parsed document is computed once for each concrete alias. Indented Include
 * that is a Host/Match child is left unexpanded. Wildcards participate in
 * compute but are never emitted as list rows. Writing helpers remain exported
 * for legacy callers/tests; the Desktop product path must not use them for
 * imported SSH config hosts.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import SSHConfig, { glob as matchesHostPattern } from 'ssh-config';

import { sshHostRef, type HostConfig } from './types.js';

const DEFAULT_PORT = 22;
const MAX_INCLUDE_DEPTH = 16;
const MAX_INCLUDE_FILES = 64;
const MAX_INCLUDE_BYTES = 1024 * 1024;

export interface SshConfigDiagnostic {
  path: string;
  kind: 'io' | 'syntax' | 'limit';
  message: string;
  recoveryHint: string;
}

export interface ReadSshConfigResult {
  hosts: HostConfig[];
  diagnostic: SshConfigDiagnostic | null;
}

interface ExpandedConfig {
  text: string;
  /** Origin for each Host directive in expanded text order. */
  hostOrigins: Array<'main' | 'include'>;
  files: string[];
}

interface IncludeState {
  rootDir: string;
  visited: Set<string>;
  hostOrigins: Array<'main' | 'include'>;
  files: string[];
  bytes: number;
}

/** Resolve `~/.ssh/config` on the current OS. */
export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Expand a leading `~` (or `~/`, `~\`) to the user's home directory.
 *
 * Exported so the ADD/UPDATE IPC boundary can normalize `identityFile` the
 * same way the config-read path does — Node never expands `~`, so a literal
 * `~/.ssh/...` stored in the pool host config would fail `fs.readFile` /
 * ssh-add. The `~\` prefix normalizes backslashes to `/` (a no-op on Windows,
 * but required on POSIX where backslash is a filename character).
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2).replace(/\\/g, '/'));
  return p;
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
  value?: string | SshConfigValueToken | Array<string | SshConfigValueToken>;
  /** Present on comment nodes (type=2). */
  content?: string;
  config?: SshConfigSection[];
}

interface SshConfigValueToken {
  val?: unknown;
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

function isMatchDirective(section: SshConfigSection): boolean {
  return section.param?.toLowerCase() === 'match';
}

/** Normalize ssh-config v5 AST tokens (`{ val }`) and legacy string values. */
function directiveValues(section: SshConfigSection): string[] {
  const raw = Array.isArray(section.value) ? section.value : [section.value];
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string') values.push(value);
    else if (value && typeof value === 'object' && typeof value.val === 'string') {
      values.push(value.val);
    }
  }
  return values;
}

/**
 * Read and parse ~/.ssh/config (or any path). Returns a list of concrete
 * hosts — wildcards and `Match` blocks are skipped. Missing file → [].
 */
export async function readSshConfig(filePath = defaultSshConfigPath()): Promise<HostConfig[]> {
  const result = await readSshConfigDetailed(filePath);
  if (result.diagnostic) throw new Error(result.diagnostic.message);
  return result.hosts;
}

/** Read SSH config plus a structured diagnostic suitable for IPC/UI. */
export async function readSshConfigDetailed(
  filePath = defaultSshConfigPath(),
): Promise<ReadSshConfigResult> {
  let expanded: ExpandedConfig;
  try {
    expanded = await expandConfig(filePath);
  } catch (err) {
    const diagnostic = toConfigDiagnostic(filePath, err);
    // A missing primary config is a valid empty state. Missing Include files
    // are skipped by expandConfig and therefore never reach this branch.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hosts: [], diagnostic: null };
    }
    return { hosts: [], diagnostic };
  }

  let parsed: SshConfigSection[];
  try {
    parsed = SSHConfig.parse(expanded.text) as SshConfigSection[];
  } catch (err) {
    return {
      hosts: [],
      diagnostic: {
        path: filePath,
        kind: 'syntax',
        message: `failed to parse SSH config: ${err instanceof Error ? err.message : String(err)}`,
        recoveryHint: 'Fix the syntax in ~/.ssh/config or one of its Include files, then refresh.',
      },
    };
  }

  const computeDocument = withoutUnsupportedComputeSections(parsed);
  const hostOriginBySection = new Map<SshConfigSection, 'main' | 'include'>();
  let hostOriginIndex = 0;
  for (const section of parsed) {
    if (!isHostDirective(section)) continue;
    hostOriginBySection.set(section, expanded.hostOrigins[hostOriginIndex] ?? 'main');
    hostOriginIndex += 1;
  }
  const hosts: HostConfig[] = [];
  const seen = new Set<string>();
  for (const section of parsed) {
    if (!isHostDirective(section)) continue;
    for (const aliasRaw of directiveValues(section)) {
      const alias = aliasRaw.trim();
      if (!isConcreteAlias(alias) || seen.has(alias)) continue;
      seen.add(alias);

      const matchingHosts = analyzeMatchingHostSections(parsed, alias, hostOriginBySection);
      const origin = matchingHosts.origin;
      const computed = computeConfig(computeDocument, alias);
      const identityRaw = firstString(getComputedValue(computed, 'identityfile'));
      const marker = matchingHosts.marker;
      const authMethod = identityRaw
        ? marker ?? (origin === 'include' || matchingHosts.ambiguousOrigin ? 'agent' : 'key')
        : 'agent';
      const hostname = firstString(getComputedValue(computed, 'hostname')) ?? alias;
      const user = firstString(getComputedValue(computed, 'user')) ?? os.userInfo().username;
      const port = parseIntSafe(firstString(getComputedValue(computed, 'port')), DEFAULT_PORT);

      hosts.push({
        id: sshHostRef(alias),
        alias,
        displayName: alias,
        hostname,
        port,
        user,
        authMethod,
        identityFile: identityRaw ? expandIdentityFile(identityRaw, path.dirname(filePath)) : undefined,
        source: 'ssh-config',
        configOrigin: origin,
        editable: false,
        deletable: false,
      });
    }
  }
  return { hosts, diagnostic: null };
}

function withoutUnsupportedComputeSections(parsed: SshConfigSection[]): SshConfigSection[] {
  const result = SSHConfig.parse('') as SshConfigSection[];
  const append = result as unknown as { push(node: SshConfigSection): void };
  for (const section of parsed) {
    if (isMatchDirective(section)) continue;
    if (isCanonicalizationDirective(section)) continue;
    append.push({
      ...section,
      ...(section.config
        ? { config: section.config.filter((child) => !isCanonicalizationDirective(child)) }
        : {}),
    });
  }
  return result;
}

function isCanonicalizationDirective(section: SshConfigSection): boolean {
  return /^canonicalize/i.test(section.param ?? '') || /^canonicaldomains$/i.test(section.param ?? '');
}

function isConcreteAlias(alias: string): boolean {
  // OpenSSH host patterns also support bracket character classes (including
  // negated classes such as [!0-9]). They are selectors, not concrete rows in
  // Cindy's host list.
  return !!alias
    && !alias.includes('*')
    && !alias.includes('?')
    && !alias.includes('[')
    && !alias.startsWith('!');
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string');
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function getComputedValue(record: Record<string, unknown>, key: string): unknown {
  const wanted = key.toLowerCase();
  const entry = Object.entries(record).find(([name]) => name.toLowerCase() === wanted);
  return entry?.[1];
}

function computeConfig(parsed: SshConfigSection[], alias: string): Record<string, unknown> {
  const candidate = parsed as unknown as {
    compute?: (host: string, options?: { matchExec?: boolean }) => unknown;
  };
  // SSH config is user-controlled input. `ssh-config` evaluates Match exec by
  // default; Cindy deliberately does not support Match and must never execute
  // a shell command merely because Settings refreshed the host list.
  const computed = candidate.compute?.(alias, { matchExec: false });
  if (computed && typeof computed === 'object') return computed as Record<string, unknown>;
  // Defensive fallback for old ssh-config versions. This is deliberately
  // shallow; supported runtimes have compute().
  const section = parsed.find((s) => isHostDirective(s)
    && directiveValues(s).includes(alias));
  const out: Record<string, unknown> = {};
  for (const child of section?.config ?? []) {
    if (child.param) out[child.param.toLowerCase()] = child.value;
  }
  return out;
}

function analyzeMatchingHostSections(
  parsed: SshConfigSection[],
  alias: string,
  hostOriginBySection: ReadonlyMap<SshConfigSection, 'main' | 'include'>,
): {
  origin: 'main' | 'include';
  ambiguousOrigin: boolean;
  marker: 'agent' | 'key' | null;
} {
  let firstOrigin: 'main' | 'include' | null = null;
  let marker: 'agent' | 'key' | null = null;
  const matchingOrigins = new Set<'main' | 'include'>();
  for (const section of parsed) {
    if (!isHostDirective(section)) continue;
    if (!matchesHostPattern(directiveValues(section), alias)) continue;
    const origin = hostOriginBySection.get(section) ?? 'main';
    firstOrigin ??= origin;
    matchingOrigins.add(origin);
    marker ??= readAuthMarker(section);
  }
  return {
    origin: firstOrigin ?? 'main',
    ambiguousOrigin: matchingOrigins.size > 1,
    marker,
  };
}

function expandIdentityFile(value: string, configDir: string): string {
  const expanded = expandHome(value);
  // OpenSSH accepts relative IdentityFile values. Cindy resolves them against
  // the config directory (~/.ssh), never Electron's process.cwd().
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

async function expandConfig(filePath: string): Promise<ExpandedConfig> {
  const state: IncludeState = {
    rootDir: path.dirname(path.resolve(filePath)),
    visited: new Set(),
    hostOrigins: [],
    files: [],
    bytes: 0,
  };
  const text = await expandFile(path.resolve(filePath), state, 0, 'main');
  return { text, hostOrigins: state.hostOrigins, files: state.files };
}

async function expandFile(
  filePath: string,
  state: IncludeState,
  depth: number,
  origin: 'main' | 'include',
): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) throw limitError(filePath, `Include nesting exceeds ${MAX_INCLUDE_DEPTH} levels`);
  const normalized = path.normalize(filePath);
  if (state.visited.has(normalized)) return '';
  let raw: string;
  try {
    raw = await fs.readFile(normalized, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && origin === 'include') return '';
    throw err;
  }
  if (state.files.length >= MAX_INCLUDE_FILES) {
    throw limitError(normalized, `Include file count exceeds ${MAX_INCLUDE_FILES}`);
  }
  if (state.bytes + Buffer.byteLength(raw, 'utf8') > MAX_INCLUDE_BYTES) {
    throw limitError(normalized, `expanded SSH config exceeds ${MAX_INCLUDE_BYTES} bytes`);
  }
  state.visited.add(normalized);
  state.files.push(normalized);
  state.bytes += Buffer.byteLength(raw, 'utf8');

  const lines = raw.split(/(?<=\n)/);
  let out = '';
  for (const line of lines) {
    const trimmed = line.trim();
    const directive = parseDirectiveLine(trimmed);
    const keyword = directive?.keyword;
    if (keyword === 'host') {
      state.hostOrigins.push(origin);
      out += line;
      continue;
    }
    if (keyword === 'match') {
      out += line;
      continue;
    }
    // OpenSSH attaches every keyword to the preceding Host/Match until the
    // next Host/Match, indentation aside. Cindy still expands an unindented
    // Include between blocks — that is the usual `config.d` layout — and
    // leaves indented Include as a Host/Match child unexpanded.
    if (!isIndentedDirective(line) && directive && keyword === 'include') {
      const patternText = directive.value;
      const patterns = splitIncludePatterns(patternText);
      for (const pattern of patterns) {
        const expandedPattern = expandHome(pattern);
        const absolutePattern = path.isAbsolute(expandedPattern)
          ? expandedPattern
          : path.resolve(state.rootDir, expandedPattern);
        const matches = await globPaths(absolutePattern);
        for (const match of matches) out += await expandFile(match, state, depth + 1, 'include');
      }
      continue;
    }
    // Conditional Include inside Host/Match is intentionally not expanded.
    // Keeping the directive in the document makes the unsupported construct
    // visible to syntax/debugging rather than silently changing its scope.
    out += line;
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}

function isIndentedDirective(line: string): boolean {
  return /^[ \t]/.test(line);
}

function parseDirectiveLine(line: string): { keyword: string; value: string } | null {
  if (!line || line.startsWith('#')) return null;
  const match = /^([^\s=#]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (match) return { keyword: match[1]!.toLowerCase(), value: match[2]!.trim() };
  return { keyword: line.toLowerCase(), value: '' };
}

function splitIncludePatterns(value: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  const pushWord = (): void => {
    if (!word) return;
    words.push(word);
    word = '';
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && value[index + 1] === '"') {
        word += '"';
        index += 1;
      } else word += char;
      continue;
    }
    if (char === '#') break;
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    if (char === '\\' && /[\s#'"\\]/.test(value[index + 1] ?? '')) {
      word += value[index + 1];
      index += 1;
      continue;
    }
    word += char;
  }
  pushWord();
  return words;
}

async function globPaths(pattern: string): Promise<string[]> {
  const normalized = path.normalize(pattern);
  const root = path.parse(normalized).root;
  // Strip the root before splitting. The previous implementation split the
  // full absolute path and then skipped index 0, which accidentally dropped
  // the first real directory (`/var/...` became `/folders/...` on macOS).
  // Keeping the root separate also handles Windows drive roots (`C:\\`).
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);
  const start = root || '.';
  const walk = async (dir: string, index: number): Promise<string[]> => {
    if (index >= segments.length) {
      try {
        const stat = await fs.stat(dir);
        return stat.isFile() ? [dir] : [];
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        throw err;
      }
    }
    const segment = segments[index]!;
    if (!hasGlob(segment)) {
      const next = path.join(dir, segment);
      try {
        await fs.access(next);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        throw err;
      }
      return walk(next, index + 1);
    }
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries) {
      // Match glob(3)/OpenSSH: `*` and `?` do not consume a leading dot.
      // Hidden files require a pattern segment that explicitly starts `.`.
      if (entry.startsWith('.') && !segment.startsWith('.')) continue;
      if (path.matchesGlob(entry, segment)) {
        out.push(...await walk(path.join(dir, entry), index + 1));
      }
    }
    return out;
  };
  return walk(start, 0);
}

function hasGlob(value: string): boolean { return /[*?\[]/.test(value); }

function limitError(pathName: string, message: string): Error & { code: string; path: string } {
  const error = new Error(message) as Error & { code: string; path: string };
  error.code = 'SSH_CONFIG_LIMIT';
  error.path = pathName;
  error.name = 'SshConfigLimitError';
  return error;
}

function toConfigDiagnostic(filePath: string, err: unknown): SshConfigDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const kind = (err as { code?: string })?.code === 'SSH_CONFIG_LIMIT' ? 'limit' : 'io';
  const diagnosticPath = typeof (err as { path?: unknown })?.path === 'string'
    ? (err as { path: string }).path
    : filePath;
  return {
    path: diagnosticPath,
    kind,
    message,
    recoveryHint: kind === 'limit'
      ? 'Reduce Include nesting, file count, or config size, then refresh.'
      : 'Check file permissions and the paths named by Include, then refresh.',
  };
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
  removeHostSections(parsed, host.alias ?? host.id);

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
    if (directiveValues(section).includes(alias)) parsed.splice(index, 1);
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

  const section = findHostSection(parsed, host.alias ?? host.id);
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
    if (directiveValues(section).includes(alias)) return section;
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
    `Host ${host.alias ?? host.id}`,
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
