/**
 * OpenSSH config discovery plus Cindy's narrowly-owned config writer.
 *
 * Discovery intentionally implements only the subset Cindy consumes. Include
 * is expanded at root scope and inside a pure `Host *` block. Other Host
 * scopes are conditional, so expanding them without evaluating OpenSSH's full
 * matcher would invent aliases that `ssh <alias>` cannot actually see. If a
 * skipped conditional Include or an unevaluated Match may affect a discovered
 * alias, that host remains visible but is marked unsupported instead of using
 * default fields.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SSHConfig from 'ssh-config';

import {
  defaultIdentityPaths,
  resolveIdentityFingerprints,
  type IdentityFingerprintResolution,
} from './sshAuthentication.js';
import type { HostConfig } from './types.js';

const DEFAULT_PORT = 22;
const MAX_INCLUDE_DEPTH = 16;
const MAX_INCLUDE_FILES = 64;
const MAX_INCLUDE_BYTES = 1024 * 1024;
const AUTH_MARKER_PREFIX = '# xdt-maker:auth=';
/** File-level marker proving that Cindy created/owns the managed config. */
export const MANAGED_CONFIG_MARKER = '# xdt-maker:managed=v1';
export const MANAGED_CONFIG_OWNERSHIP_REQUIRED_CODE = 'SSH_CONFIG_OWNERSHIP_REQUIRED';
export const MANAGED_CONFIG_CONCURRENT_MODIFICATION_CODE = 'SSH_CONFIG_CONCURRENT_MODIFICATION';
export const MANAGED_CONFIG_WRITE_TOKEN_REQUIRED_CODE = 'SSH_CONFIG_WRITE_TOKEN_REQUIRED';
const MATCH_NO_ARGUMENT_CRITERIA = new Set(['all', 'canonical', 'final']);
const MATCH_ONE_ARGUMENT_CRITERIA = new Set([
  'command',
  'exec',
  'host',
  'localaddress',
  'localcommand',
  'localnetwork',
  'localport',
  'localuser',
  'originalhost',
  'remoteaddress',
  'remoteport',
  'tagged',
  'user',
  'version',
]);

export interface SshConfigDiagnostic {
  path: string;
  kind: 'io' | 'syntax' | 'limit';
  message: string;
  recoveryHint: string;
}

export interface ReadSshConfigOptions {
  /** Cindy-owned config file. Omit it to make every discovered host read-only. */
  managedConfigPath?: string;
}

export interface ReadSshConfigResult {
  hosts: HostConfig[];
  diagnostic: SshConfigDiagnostic | null;
  warnings: string[];
  /**
   * Opaque SHA-256 token for the exact Cindy-owned managed config bytes read
   * during this discovery pass. Trusted hosts may pass it to managed writers;
   * it must never be projected over IPC or stored on a host snapshot.
   * Undefined when no managed path was requested, the file was not reached,
   * or its Cindy ownership marker was absent.
   */
  managedConfigWriteToken?: ManagedConfigWriteToken;
}

declare const managedConfigWriteTokenBrand: unique symbol;
export type ManagedConfigWriteToken = string & {
  readonly [managedConfigWriteTokenBrand]: true;
};

/**
 * Conditional rollback for a host that was successfully published to the
 * managed SSH file. The rollback refuses to overwrite later external edits.
 */
export interface ManagedHostAddReceipt {
  rollback(): Promise<boolean>;
}

type AuthMarker = 'agent' | 'key';
type Scope =
  | { kind: 'root' }
  | { kind: 'host'; declaration: HostDeclaration }
  | { kind: 'match'; declaration: MatchDeclaration };

interface HostDeclaration {
  patterns: string[];
  sourcePath: string;
  physicalPath: string;
  marker: AuthMarker | null;
  order: number;
}

interface MatchDeclaration {
  expression: string;
  /** True once the block contains a directive Cindy would otherwise ignore. */
  hasDirectives: boolean;
  order: number;
}

interface SkippedConditionalInclude {
  /** Host scope whose effective directives may come from the skipped Include. */
  scope: Extract<Scope, { kind: 'host' }>;
}

interface DirectiveRecord {
  name: string;
  value: string;
  scope: Scope;
  order: number;
}

interface WalkState {
  rootDir: string;
  managedComparable: string | null;
  visited: Set<string>;
  files: string[];
  bytes: number;
  declarations: HostDeclaration[];
  matches: MatchDeclaration[];
  skippedConditionalIncludes: SkippedConditionalInclude[];
  incompleteUnconditionalInclude: boolean;
  managedConfigOwned: boolean;
  managedConfigWriteToken?: ManagedConfigWriteToken;
  directives: DirectiveRecord[];
  warnings: string[];
  order: number;
}

interface SshConfigSection {
  type?: number;
  before?: string;
  after?: string;
  param?: string;
  separator?: string;
  quoted?: boolean;
  value?: string | SshConfigValueToken | Array<string | SshConfigValueToken>;
  content?: string;
  config?: SshConfigSection[];
}

interface SshConfigValueToken { val?: unknown }

const SSH_CONFIG_DIRECTIVE_TYPE = 1;
const SSH_CONFIG_COMMENT_TYPE = 2;

export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

export function defaultManagedSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'cindy.conf');
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  if (value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2).replace(/\\/g, '/'));
  }
  return value;
}

type IncludePathExpansionResult =
  | { pattern: string; warning?: never }
  | { pattern?: never; warning: string };

/** Expand the environment and home-directory forms accepted by OpenSSH Include. */
function expandIncludePath(value: string): IncludePathExpansionResult {
  let pattern = '';
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf('${', cursor);
    if (start < 0) {
      pattern += value.slice(cursor);
      break;
    }
    pattern += value.slice(cursor, start);
    const end = value.indexOf('}', start + 2);
    if (end < 0) {
      return { warning: 'malformed environment variable expression; Include was not expanded.' };
    }
    const name = value.slice(start + 2, end);
    if (!name || name.includes('{')) {
      return { warning: 'malformed environment variable expression; Include was not expanded.' };
    }
    const environmentValue = process.env[name];
    if (environmentValue === undefined) {
      return {
        warning: `environment variable "${name}" is not set; Include was not expanded.`,
      };
    }
    pattern += environmentValue;
    cursor = end + 1;
  }

  const currentUserPattern = /^~([^/\\]+)(?:[/\\](.*))?$/.exec(pattern);
  if (currentUserPattern) {
    const username = currentUserPattern[1]!;
    if (username !== os.userInfo().username) {
      return {
        warning: `home directory for user "${username}" cannot be resolved by Cindy; Include was not expanded.`,
      };
    }
    const remainder = currentUserPattern[2];
    return {
      pattern: remainder === undefined
        ? os.homedir()
        : path.join(os.homedir(), remainder.replace(/\\/g, '/')),
    };
  }

  return { pattern: expandHome(pattern) };
}

type HostNameExpansionResult =
  | { hostname: string; unsupportedToken?: never }
  | { hostname?: never; unsupportedToken: string };

/** HostName accepts only %% and %h; expand once so alias contents are not re-read as tokens. */
function expandHostNameTokens(value: string, alias: string): HostNameExpansionResult {
  let hostname = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== '%') {
      hostname += char;
      continue;
    }

    const token = value[index + 1];
    if (token === '%') hostname += '%';
    else if (token === 'h') hostname += alias;
    else return { unsupportedToken: token === undefined ? '%' : `%${token}` };
    index += 1;
  }
  return { hostname };
}

export async function readSshConfig(
  filePath = defaultSshConfigPath(),
  options: ReadSshConfigOptions = {},
): Promise<HostConfig[]> {
  const result = await readSshConfigDetailed(filePath, options);
  if (result.diagnostic) throw new Error(result.diagnostic.message);
  return result.hosts;
}

export async function readSshConfigDetailed(
  filePath = defaultSshConfigPath(),
  options: ReadSshConfigOptions = {},
): Promise<ReadSshConfigResult> {
  const absoluteMainPath = path.resolve(filePath);
  const managedComparable = options.managedConfigPath
    ? await comparablePath(options.managedConfigPath)
    : null;
  const state: WalkState = {
    rootDir: path.dirname(absoluteMainPath),
    managedComparable,
    visited: new Set(),
    files: [],
    bytes: 0,
    declarations: [],
    matches: [],
    skippedConditionalIncludes: [],
    incompleteUnconditionalInclude: false,
    managedConfigOwned: false,
    directives: [],
    warnings: [],
    order: 0,
  };

  try {
    await walkFile(absoluteMainPath, { kind: 'root' }, state, 0, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const warnings = options.managedConfigPath && await pathExists(options.managedConfigPath)
        ? ['Cindy\'s SSH host file exists but is not reachable through a supported Include.']
        : [];
      return { hosts: [], diagnostic: null, warnings };
    }
    return {
      hosts: [],
      diagnostic: toConfigDiagnostic(absoluteMainPath, error),
      warnings: state.warnings,
    };
  }

  if (options.managedConfigPath) {
    const managedExists = await pathExists(options.managedConfigPath);
    const reachedManaged = managedComparable
      ? Array.from(state.visited).some((item) => pathsEqual(item, managedComparable))
      : false;
    if (managedExists && !reachedManaged) {
      state.warnings.push('Cindy\'s SSH host file exists but is not reachable through a supported Include.');
    }
  }

  return {
    hosts: await buildHosts(state, managedComparable),
    diagnostic: null,
    warnings: state.warnings,
    ...(state.managedConfigWriteToken
      ? { managedConfigWriteToken: state.managedConfigWriteToken }
      : {}),
  };
}

async function walkFile(
  filePath: string,
  inheritedScope: Scope,
  state: WalkState,
  depth: number,
  optional: boolean,
): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw limitError(filePath, `Include nesting exceeds ${MAX_INCLUDE_DEPTH} levels`);
  }

  let physicalPath: string;
  try {
    physicalPath = await comparablePath(filePath);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (state.visited.has(physicalPath)) return;

  let rawBytes: Buffer;
  try {
    rawBytes = await fs.readFile(physicalPath);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (state.files.length >= MAX_INCLUDE_FILES) {
    throw limitError(physicalPath, `Include file count exceeds ${MAX_INCLUDE_FILES}`);
  }
  const bytes = rawBytes.byteLength;
  if (state.bytes + bytes > MAX_INCLUDE_BYTES) {
    throw limitError(physicalPath, `expanded SSH config exceeds ${MAX_INCLUDE_BYTES} bytes`);
  }

  const raw = rawBytes.toString('utf8');
  try {
    SSHConfig.parse(raw);
  } catch (error) {
    const syntaxError = new Error(
      `failed to parse SSH config: ${error instanceof Error ? error.message : String(error)}`,
    ) as Error & { code?: string; path?: string };
    syntaxError.code = 'SSH_CONFIG_SYNTAX';
    syntaxError.path = physicalPath;
    throw syntaxError;
  }

  state.visited.add(physicalPath);
  state.files.push(physicalPath);
  state.bytes += bytes;
  if (state.managedComparable !== null && pathsEqual(physicalPath, state.managedComparable)) {
    state.managedConfigOwned = hasManagedConfigMarker(raw);
    state.managedConfigWriteToken = state.managedConfigOwned
      ? managedConfigToken(rawBytes)
      : undefined;
  }

  let scope = inheritedScope;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (scope.kind === 'host' && scope.declaration.marker === null) {
        const marker = parseAuthMarker(trimmed);
        if (marker) scope.declaration.marker = marker;
      }
      continue;
    }

    const directive = parseDirectiveLine(trimmed);
    if (!directive) continue;
    const location = `${physicalPath}:${index + 1}`;

    if (directive.keyword === 'host') {
      const patterns = splitWords(directive.value);
      const declaration: HostDeclaration = {
        patterns,
        sourcePath: filePath,
        physicalPath,
        marker: null,
        order: state.order++,
      };
      state.declarations.push(declaration);
      scope = { kind: 'host', declaration };
      continue;
    }

    if (directive.keyword === 'match') {
      const declaration: MatchDeclaration = {
        expression: directive.value,
        hasDirectives: false,
        order: state.order++,
      };
      state.matches.push(declaration);
      scope = { kind: 'match', declaration };
      state.warnings.push(`${location}: Match is not evaluated by Cindy.`);
      continue;
    }

    if (scope.kind === 'match') scope.declaration.hasDirectives = true;

    if (directive.keyword === 'include') {
      if (!isSupportedIncludeScope(scope)) {
        if (scope.kind === 'host') {
          state.skippedConditionalIncludes.push({ scope });
        }
        state.warnings.push(`${location}: conditional Include was not expanded.`);
        continue;
      }
      for (const patternValue of splitWords(directive.value)) {
        const expansion = expandIncludePath(patternValue);
        if ('warning' in expansion) {
          state.warnings.push(`${location}: ${expansion.warning}`);
          state.incompleteUnconditionalInclude = true;
          continue;
        }
        const expanded = expansion.pattern;
        const absolutePattern = path.isAbsolute(expanded)
          ? expanded
          : path.resolve(state.rootDir, expanded);
        for (const includedPath of await globPaths(absolutePattern)) {
          const includedComparable = await comparablePath(includedPath);
          const repeatedManagedGlob = hasGlob(expanded)
            && state.managedComparable !== null
            && state.visited.has(includedComparable)
            && pathsEqual(includedComparable, state.managedComparable);
          // The child starts in the parent's active scope. This local scope is
          // deliberately restored when the recursive call returns.
          await walkFile(includedPath, scope, state, depth + 1, true);
          if (repeatedManagedGlob) {
            state.warnings.push(
              `${location}: Include glob reaches Cindy's SSH host file after it was already loaded.`,
            );
          }
        }
      }
      continue;
    }

    if (isCanonicalizationDirective(directive.keyword)) {
      state.warnings.push(`${location}: hostname canonicalization is not evaluated by Cindy.`);
      if (directive.keyword === 'canonicalizehostname' && scope.kind !== 'match') {
        state.directives.push({
          name: directive.keyword,
          value: firstWordOrRaw(directive.value),
          scope,
          order: state.order++,
        });
      }
      continue;
    }
    if (scope.kind === 'match') continue;

    const name = directive.keyword;
    if (name === 'hostname'
      || name === 'user'
      || name === 'port'
      || name === 'identityfile'
      || name === 'identitiesonly'
      || name === 'identityagent'
      || name === 'hostkeyalias'
      || name === 'proxyjump'
      || name === 'proxycommand'
      || name === 'certificatefile'
      || name === 'pkcs11provider'
      || name === 'securitykeyprovider') {
      state.directives.push({
        name,
        value: firstWordOrRaw(directive.value),
        scope,
        order: state.order++,
      });
    }
  }
}

async function buildHosts(
  state: WalkState,
  managedComparable: string | null,
): Promise<HostConfig[]> {
  const aliases: string[] = [];
  const fingerprintCache = new Map<string, Promise<IdentityFingerprintResolution>>();
  const seen = new Set<string>();
  for (const declaration of state.declarations) {
    for (const pattern of declaration.patterns) {
      if (!isConcreteAlias(pattern) || seen.has(pattern)) continue;
      seen.add(pattern);
      aliases.push(pattern);
    }
  }

  const hosts: HostConfig[] = [];
  // Keep public-key inspection sequential. A config may contain many aliases
  // pointing at the same identities; unbounded Promise.all would turn a small
  // config into a burst of file descriptors during startup.
  for (const alias of aliases) {
    const introducing = state.declarations.filter((declaration) =>
      declaration.patterns.some((pattern) => pattern === alias));
    const firstIntroducing = introducing[0];
    const identityDirectives = matchingDirectives(state.directives, alias, 'identityfile');
    const introducingIdentity = identityDirectives.find((directive) =>
      directive.scope.kind === 'host'
      && directive.scope.declaration === firstIntroducing
      && directive.value.toLowerCase() !== 'none')?.value;
    const marker = firstIntroducing?.marker ?? null;
    const matchMayAffectHost = state.matches.some((declaration) =>
      declaration.hasDirectives
      && matchExpressionMayApplyToAlias(declaration.expression, alias));
    const conditionalIncludeMayAffectHost = state.skippedConditionalIncludes.some(
      ({ scope }) => scopeMatches(scope, alias),
    );
    // Strategy B: ordinary OpenSSH hosts are Agent-first, independently of
    // whether the concrete IdentityFile lives in the main file or an Include.
    // Only Cindy's marker opts into direct private-key reads or an explicit
    // agent pin. Compatibility trade-off: a legacy no-marker host that relied
    // on Cindy reading an unencrypted private key must load it with ssh-add or
    // migrate to a marked Cindy-managed key host. managedByCindy remains
    // ownership-only.
    const authMethod = marker ?? 'agent';
    const identityRaw = marker === 'key'
      ? introducingIdentity
      : marker === 'agent'
        ? introducingIdentity
        : undefined;
    const hostnameRaw = firstMatchingDirective(state.directives, alias, 'hostname');
    const hostnameExpansion = hostnameRaw === undefined
      ? { hostname: alias }
      : expandHostNameTokens(hostnameRaw, alias);
    const unsupportedHostNameToken = hostnameExpansion.unsupportedToken;
    if (hostnameExpansion.unsupportedToken !== undefined) {
      state.warnings.push(
        `SSH host ${JSON.stringify(alias)} remains listed but unsupported because HostName uses token `
        + `${JSON.stringify(hostnameExpansion.unsupportedToken)}.`,
      );
    }
    // The alias is display-only on this path. unsupportedReason below prevents
    // it from reaching TCP, TOFU, or endpoint fingerprinting.
    const hostname = hostnameExpansion.hostname ?? alias;
    const user = firstMatchingDirective(state.directives, alias, 'user')
      ?? os.userInfo().username;
    const port = parseIntSafe(firstMatchingDirective(state.directives, alias, 'port'), DEFAULT_PORT);

    const uniquelyManaged = managedComparable !== null
      && introducing.length === 1
      && firstIntroducing?.patterns.length === 1
      && pathsEqual(firstIntroducing.physicalPath, managedComparable);
    const managedOwnership = uniquelyManaged && state.managedConfigOwned;

    const identityFileDirectiveSeen = identityDirectives.length > 0;
    const identityFileNoneSeen = identityDirectives.some(
      (directive) => directive.value.toLowerCase() === 'none',
    );
    const identityContext: IdentityFileTokenContext = {
      alias,
      hostname,
      user,
      port,
      hostKeyAlias: firstMatchingDirective(state.directives, alias, 'hostkeyalias'),
      proxyJump: firstMatchingDirective(state.directives, alias, 'proxyjump'),
    };
    const concreteIdentityDirectives = identityDirectives
      .filter((directive) => directive.value.toLowerCase() !== 'none');
    const explicitIdentityFiles: string[] = [];
    let unsupportedIdentityToken: string | undefined;
    for (const directive of concreteIdentityDirectives) {
      const expansion = expandIdentityFile(directive.value, identityContext);
      if ('unsupportedToken' in expansion) {
        unsupportedIdentityToken = expansion.unsupportedToken;
        break;
      }
      explicitIdentityFiles.push(expansion.filePath);
    }
    if (unsupportedIdentityToken !== undefined) {
      state.warnings.push(
        `SSH host ${JSON.stringify(alias)} remains listed but unsupported because IdentityFile uses token `
        + `${JSON.stringify(unsupportedIdentityToken)}.`,
      );
    }
    const introducingIdentityIndex = identityRaw === undefined
      ? -1
      : concreteIdentityDirectives.findIndex((directive) => directive.value === identityRaw);
    const identityFile = introducingIdentityIndex >= 0
      ? explicitIdentityFiles[introducingIdentityIndex]
      : undefined;
    const identitiesOnlyRaw = firstMatchingDirective(
      state.directives,
      alias,
      'identitiesonly',
    );
    const identitiesOnly = identitiesOnlyRaw?.toLowerCase() === 'yes';
    const configuredIdentityFiles = identityFileDirectiveSeen
      ? explicitIdentityFiles
      : identitiesOnly
        ? defaultIdentityPaths()
        : [];
    const canonicalizeHostname = firstMatchingDirective(
      state.directives,
      alias,
      'canonicalizehostname',
    )?.toLowerCase();
    let unsupportedReason = state.incompleteUnconditionalInclude
      ? 'Cindy could not completely expand an unconditional Include'
      : matchMayAffectHost
        ? 'Cindy does not evaluate a Match block that may affect this SSH host'
        : conditionalIncludeMayAffectHost
          ? 'Cindy does not expand a conditional Include that may affect this SSH host'
          : canonicalizeHostname !== undefined && canonicalizeHostname !== 'no'
            ? canonicalizeHostname === 'yes' || canonicalizeHostname === 'always'
              ? 'Cindy does not implement OpenSSH hostname canonicalization'
              : `unsupported CanonicalizeHostname value: ${canonicalizeHostname}`
            : unsupportedHostNameToken !== undefined
              ? `unsupported HostName token: ${unsupportedHostNameToken}`
              : unsupportedIdentityToken !== undefined
                ? `unsupported IdentityFile token: ${unsupportedIdentityToken}`
                : identitiesOnlyRaw !== undefined
                  && identitiesOnlyRaw.toLowerCase() !== 'yes'
                  && identitiesOnlyRaw.toLowerCase() !== 'no'
                  ? `unsupported IdentitiesOnly value: ${identitiesOnlyRaw}`
                  : undefined;
    const unsupportedTransportDirectives = ['proxyjump', 'proxycommand']
      .filter((name) => {
        const value = firstMatchingDirective(state.directives, alias, name);
        return value !== undefined && value.toLowerCase() !== 'none';
      });
    if (unsupportedTransportDirectives.length > 0) {
      unsupportedReason ??= `Cindy does not support ${unsupportedTransportDirectives.join(' / ')} transport configuration`;
    }
    const unsupportedAgentDirectives = [
      'certificatefile',
      'pkcs11provider',
      'securitykeyprovider',
    ].filter((name) => matchingDirectives(state.directives, alias, name).length > 0);
    if (authMethod === 'agent' && unsupportedAgentDirectives.length > 0) {
      if (identitiesOnly) {
        unsupportedReason ??= `Cindy cannot enforce IdentitiesOnly with ${unsupportedAgentDirectives.join(', ')}`;
      } else {
        state.warnings.push(
          `Host ${alias}: ${unsupportedAgentDirectives.join(', ')} is not interpreted by Cindy; SSH Agent will be used.`,
        );
      }
    }
    let allowedAgentFingerprints: string[] | undefined;
    if (authMethod === 'agent' && identitiesOnly && !unsupportedReason) {
      const resolved = await resolveCompleteFingerprintSet(
        configuredIdentityFiles,
        !identityFileDirectiveSeen,
        fingerprintCache,
      );
      allowedAgentFingerprints = resolved.fingerprints;
      unsupportedReason = resolved.unsupportedReason;
    }

    hosts.push({
      id: alias,
      hostname,
      port,
      user,
      authMethod,
      identityFile,
      sshAuthentication: {
        ...(marker ? { marker } : {}),
        identitiesOnly,
        ...(firstMatchingDirective(state.directives, alias, 'identityagent') !== undefined
          ? { identityAgent: firstMatchingDirective(state.directives, alias, 'identityagent') }
          : {}),
        configuredIdentityFiles,
        identityFileDirectiveSeen,
        identityFileNoneSeen,
        ...(allowedAgentFingerprints ? { allowedAgentFingerprints } : {}),
        ...(unsupportedReason ? { unsupportedReason } : {}),
      },
      source: 'ssh-config' as const,
      managedByCindy: managedOwnership,
    });
  }
  return hosts;
}

async function resolveCompleteFingerprintSet(
  identityFiles: string[],
  usingDefaults: boolean,
  cache: Map<string, Promise<IdentityFingerprintResolution>>,
): Promise<{ fingerprints?: string[]; unsupportedReason?: string }> {
  const fingerprints: string[] = [];
  for (const identityFile of identityFiles) {
    let pending = cache.get(identityFile);
    if (!pending) {
      pending = resolveIdentityFingerprints(identityFile);
      cache.set(identityFile, pending);
    }
    const resolved = await pending;
    if (usingDefaults && resolved.missing) continue;
    if (resolved.fingerprints.length === 0) {
      return {
        unsupportedReason: usingDefaults
          ? `default identity ${identityFile} exists but Cindy cannot resolve its public key`
          : `IdentityFile ${identityFile} has no public key Cindy can resolve without reading the private key`,
      };
    }
    for (const fingerprint of resolved.fingerprints) {
      if (!fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
    }
  }
  return fingerprints.length > 0
    ? { fingerprints }
    : { unsupportedReason: 'IdentitiesOnly yes has no identity Cindy can pin in ssh-agent' };
}

function matchingDirectives(
  directives: DirectiveRecord[],
  alias: string,
  name: string,
): DirectiveRecord[] {
  return directives
    .filter((directive) => directive.name === name && scopeMatches(directive.scope, alias))
    .sort((a, b) => a.order - b.order);
}

function firstMatchingDirective(
  directives: DirectiveRecord[],
  alias: string,
  name: string,
  scopeFilter: (scope: Scope) => boolean = () => true,
): string | undefined {
  return directives
    .filter((directive) => directive.name === name
      && scopeFilter(directive.scope)
      && scopeMatches(directive.scope, alias))
    .sort((a, b) => a.order - b.order)[0]?.value;
}

function scopeMatches(scope: Scope, alias: string): boolean {
  if (scope.kind === 'root') return true;
  if (scope.kind === 'match') return false;
  try {
    return matchesHostPattern(scope.declaration.patterns, alias);
  } catch {
    return false;
  }
}

/**
 * OpenSSH host patterns support only `*`, `?`, and a leading `!` negation.
 * The ssh-config package's glob helper treats `?` as optional (`.?`), which
 * can apply a wildcard block to the wrong alias (for example `foo?` → `foo`).
 */
function matchesHostPattern(patterns: readonly string[], alias: string): boolean {
  let matched = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    let source = '^';
    for (const char of pattern) {
      if (char === '*') source += '.*';
      else if (char === '?') source += '.';
      else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    source += '$';
    // OpenSSH host patterns are case-sensitive. Do not pass the `i` flag:
    // `Host F*` must not match the distinct alias `foo`.
    if (!new RegExp(source).test(alias)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/**
 * Cindy deliberately does not execute OpenSSH Match expressions. We only
 * prove a block cannot affect an alias when an `originalhost` criterion
 * excludes it; every other condition remains conservatively possible.
 * Match criteria are ANDed, so one definitely-false originalhost condition
 * is enough to make the whole expression irrelevant to this alias.
 */
function matchExpressionMayApplyToAlias(expression: string, alias: string): boolean {
  const words = splitWords(expression);
  if (words.length === 0) return true;

  for (let index = 0; index < words.length;) {
    const criterion = words[index]!.toLowerCase();
    if (MATCH_NO_ARGUMENT_CRITERIA.has(criterion)) {
      index += 1;
      continue;
    }
    if (!MATCH_ONE_ARGUMENT_CRITERIA.has(criterion)) return true;
    const value = words[index + 1];
    if (value === undefined) return true;
    if (criterion === 'originalhost' && !matchesMatchPatternList(value, alias)) return false;
    index += 2;
  }
  return true;
}

/** Match pattern-lists are comma-separated and may contain negated entries. */
function matchesMatchPatternList(value: string, alias: string): boolean {
  const patterns = value.split(',').filter(Boolean);
  if (patterns.length === 0) return true;

  let hasPositive = false;
  let positiveMatched = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    if (!pattern) return true;
    const matches = matchesHostPattern([pattern], alias);
    if (negated && matches) return false;
    if (!negated) {
      hasPositive = true;
      positiveMatched ||= matches;
    }
  }
  return hasPositive ? positiveMatched : true;
}

function isSupportedIncludeScope(scope: Scope): boolean {
  return scope.kind === 'root'
    || (scope.kind === 'host'
      && scope.declaration.patterns.length === 1
      && scope.declaration.patterns[0] === '*');
}

function parseDirectiveLine(line: string): { keyword: string; value: string } | null {
  if (!line || line.startsWith('#')) return null;
  const match = /^([^\s=#]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (match) return { keyword: match[1]!.toLowerCase(), value: match[2]!.trim() };
  return { keyword: line.toLowerCase(), value: '' };
}

function splitWords(value: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    if (!word) return;
    words.push(word);
    word = '';
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\'
        && quote === '"'
        && (value[index + 1] === '"' || value[index + 1] === '\\')) {
        word += value[index + 1];
        index += 1;
      } else word += char;
      continue;
    }
    if (char === '#') {
      if (!word) break;
      word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === '\\' && /[\s#'"\\]/.test(value[index + 1] ?? '')) {
      word += value[index + 1];
      index += 1;
      continue;
    }
    word += char;
  }
  push();
  return words;
}

function firstWordOrRaw(value: string): string {
  return splitWords(value)[0] ?? value.trim();
}

function parseAuthMarker(comment: string): AuthMarker | null {
  const normalized = comment.trim();
  if (normalized === `${AUTH_MARKER_PREFIX}agent`) return 'agent';
  if (normalized === `${AUTH_MARKER_PREFIX}key`) return 'key';
  return null;
}

function hasManagedConfigMarker(raw: string): boolean {
  const firstContentLine = raw.split(/\r?\n/).find((line) => line.trim() !== '');
  return firstContentLine?.trim() === MANAGED_CONFIG_MARKER;
}

function isCanonicalizationDirective(keyword: string): boolean {
  return keyword.startsWith('canonicalize') || keyword === 'canonicaldomains';
}

function isConcreteAlias(alias: string): boolean {
  return !!alias
    && !alias.includes('*')
    && !alias.includes('?')
    && !alias.includes('[')
    && !alias.startsWith('!');
}

interface IdentityFileTokenContext {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  hostKeyAlias?: string;
  proxyJump?: string;
}

type IdentityFileExpansionResult =
  | { filePath: string }
  | { unsupportedToken: string };

/** Expand IdentityFile tokens once using the effective host connection context. */
function expandIdentityFile(
  value: string,
  context: IdentityFileTokenContext,
): IdentityFileExpansionResult {
  const localUser = os.userInfo();
  const localHostname = os.hostname();
  const proxyJump = context.proxyJump ?? '';
  const connectionHash = createHash('sha1').update(
    `${localHostname}${context.hostname}${context.port}${context.user}${proxyJump}`,
  ).digest('hex');
  const replacements: Record<string, string> = {
    '%': '%',
    C: connectionHash,
    d: os.homedir(),
    h: context.hostname,
    i: String(localUser.uid),
    j: proxyJump,
    k: context.hostKeyAlias ?? context.alias,
    L: localHostname.split('.')[0] ?? localHostname,
    l: localHostname,
    n: context.alias,
    p: String(context.port),
    r: context.user,
    u: localUser.username,
  };
  let expanded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== '%') {
      expanded += char;
      continue;
    }
    const token = value[index + 1];
    if (token === undefined || replacements[token] === undefined) {
      return { unsupportedToken: token === undefined ? '%' : `%${token}` };
    }
    expanded += replacements[token];
    index += 1;
  }
  expanded = expandHome(expanded);
  // Unlike Include, OpenSSH does not resolve a relative IdentityFile against
  // the config file directory. It remains relative to the ssh process cwd.
  return {
    filePath: path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded),
  };
}

async function globPaths(pattern: string): Promise<string[]> {
  const normalized = path.normalize(pattern);
  const root = path.parse(normalized).root;
  const segments = normalized.slice(root.length).split(path.sep).filter(Boolean);
  const start = root || '.';

  const walk = async (directory: string, index: number): Promise<string[]> => {
    if (index >= segments.length) {
      try {
        const stat = await fs.stat(directory);
        return stat.isFile() ? [directory] : [];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        throw error;
      }
    }

    const segment = segments[index]!;
    if (!hasGlob(segment)) return walk(path.join(directory, segment), index + 1);

    let entries: string[];
    try {
      entries = (await fs.readdir(directory)).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw error;
    }

    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.') && !segment.startsWith('.')) continue;
      if (path.matchesGlob(entry, segment)) {
        matches.push(...await walk(path.join(directory, entry), index + 1));
      }
    }
    return matches;
  };

  return walk(start, 0);
}

function hasGlob(value: string): boolean {
  return /[*?\[]/.test(value);
}

/** Ensure the main config has one supported, canonical exact Include. */
export async function ensureManagedConfigInclude(
  mainConfigPath: string,
  managedConfigPath: string,
): Promise<void> {
  const managedExisting = await readRawConfig(managedConfigPath);
  if (managedExisting) assertManagedConfigOwnership(managedExisting);
  const existing = await readRawConfig(mainConfigPath);
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLinesKeepingEndings(existing);
  const kept: string[] = [];
  const movedInlineComments: string[] = [];
  let scope: 'root' | 'pure-star' | 'conditional' | 'match' = 'root';

  for (const line of lines) {
    const directive = parseDirectiveLine(line.trim());
    if (directive?.keyword === 'host') {
      const patterns = splitWords(directive.value);
      scope = patterns.length === 1 && patterns[0] === '*' ? 'pure-star' : 'conditional';
    } else if (directive?.keyword === 'match') {
      scope = 'match';
    }

    const supported = scope === 'root' || scope === 'pure-star';
    if (supported
      && directive?.keyword === 'include'
      && await isSingleExactInclude(
        directive.value,
        path.dirname(path.resolve(mainConfigPath)),
        managedConfigPath,
      )) {
      const inlineComment = extractInlineComment(stripLineEnding(line));
      if (inlineComment && !movedInlineComments.includes(inlineComment)) {
        movedInlineComments.push(inlineComment);
      }
      continue;
    }
    kept.push(line);
  }

  let insertionIndex = 0;
  while (insertionIndex < kept.length) {
    const content = stripLineEnding(kept[insertionIndex]!).trim();
    if (content === '' || content.startsWith('#')) insertionIndex += 1;
    else break;
  }
  const [firstInlineComment, ...extraInlineComments] = movedInlineComments;
  const includeLine = `Include ${formatIncludePath(managedConfigPath)}`
    + `${firstInlineComment ? ` ${firstInlineComment}` : ''}${eol}`;
  const preservedExtraComments = extraInlineComments.map((comment) => `${comment}${eol}`);
  kept.splice(insertionIndex, 0, includeLine, ...preservedExtraComments);
  if (insertionIndex > 0 && !/[\r\n]$/.test(kept[insertionIndex - 1]!)) {
    kept[insertionIndex - 1] = `${kept[insertionIndex - 1]}${eol}`;
  }
  const next = kept.join('');
  if (next !== existing) {
    await writeAtomicPreservingTarget(mainConfigPath, next, existing);
  }
}

/** Append a new, single-alias Host block to Cindy's managed file. */
export async function addManagedHost(host: HostConfig, managedConfigPath: string): Promise<void> {
  const existing = await readRawConfig(managedConfigPath);
  const next = prepareManagedHostAdd(host, existing);
  await writeAtomicPreservingTarget(managedConfigPath, next, existing);
}

/**
 * Publish a new managed host without ever making a known-bad managed file
 * reachable from the user's main SSH config.
 */
export async function addManagedHostWithInclude(
  host: HostConfig,
  mainConfigPath: string,
  managedConfigPath: string,
): Promise<ManagedHostAddReceipt> {
  const existing = await readRawConfig(managedConfigPath);
  assertManagedConfigOwnership(existing);
  // Parse and serialize the complete next file before publishing either disk
  // mutation. A malformed pre-existing cindy.conf therefore cannot be exposed
  // by a newly inserted Include.
  const next = prepareManagedHostAdd(host, existing);
  await writeAtomicPreservingTarget(managedConfigPath, next, existing);
  try {
    await ensureManagedConfigInclude(mainConfigPath, managedConfigPath);
  } catch (includeError) {
    // Roll back only if nobody changed the managed file after our atomic write.
    // If it did change, preserving that external edit is safer; both versions
    // are syntactically valid, so the main SSH graph is not poisoned.
    try {
      await restoreManagedConfigIfUnchanged(managedConfigPath, next, existing);
    } catch (rollbackError) {
      throw new AggregateError(
        [includeError, rollbackError],
        'failed to publish managed SSH Include and roll back the staged host',
      );
    }
    throw includeError;
  }
  return {
    rollback: () => restoreManagedConfigIfUnchanged(managedConfigPath, next, existing),
  };
}

/** Update only Cindy-owned connection fields and preserve all other directives. */
export async function updateManagedHostFields(
  host: HostConfig,
  managedConfigPath: string,
  expectedToken: ManagedConfigWriteToken,
): Promise<void> {
  assertManagedWriteToken(expectedToken);
  const existingBytes = await readRawConfigBytes(managedConfigPath);
  assertManagedConfigUnchanged(existingBytes, expectedToken);
  const existing = existingBytes.toString('utf8');
  assertManagedConfigOwnership(existing);
  if (!existing) throw new Error(`managed SSH host not found: ${host.id}`);
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  const section = findSingleHostSection(parsed, host.id);
  if (!section?.config) throw new Error(`managed SSH host not found or ambiguous: ${host.id}`);
  projectManagedFields(section, host, existing.includes('\r\n') ? '\r\n' : '\n');
  await writeAtomicPreservingTarget(
    managedConfigPath,
    (parsed as unknown as { toString(): string }).toString(),
    existing,
  );
}

export async function removeManagedHost(
  alias: string,
  managedConfigPath: string,
  expectedToken: ManagedConfigWriteToken,
): Promise<void> {
  assertManagedWriteToken(expectedToken);
  const existingBytes = await readRawConfigBytes(managedConfigPath);
  assertManagedConfigUnchanged(existingBytes, expectedToken);
  const existing = existingBytes.toString('utf8');
  assertManagedConfigOwnership(existing);
  if (!existing) return;
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  const matches = parsed.filter((section) => isSingleAliasHostSection(section, alias));
  if (matches.length !== 1) throw new Error(`managed SSH host not found or ambiguous: ${alias}`);
  parsed.splice(parsed.indexOf(matches[0]!), 1);
  await writeAtomicPreservingTarget(
    managedConfigPath,
    (parsed as unknown as { toString(): string }).toString(),
    existing,
  );
}

/** Legacy helpers retained for package callers/tests. Every path is required. */
export async function upsertHost(host: HostConfig, filePath: string): Promise<void> {
  const existing = await readRawConfig(filePath);
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  removeHostSections(parsed, host.id);
  const append = SSHConfig.parse(formatHostBlock(host, '\n')) as SshConfigSection[];
  for (const node of append) (parsed as unknown as { push(node: unknown): void }).push(node);
  await writeAtomicPreservingTarget(
    filePath,
    (parsed as unknown as { toString(): string }).toString(),
    existing,
  );
}

export async function updateHostFields(host: HostConfig, filePath: string): Promise<void> {
  const existing = await readRawConfig(filePath);
  if (!existing) return upsertHost(host, filePath);
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  const section = findHostSection(parsed, host.id);
  if (!section?.config) return upsertHost(host, filePath);
  projectManagedFields(section, host, existing.includes('\r\n') ? '\r\n' : '\n');
  await writeAtomicPreservingTarget(
    filePath,
    (parsed as unknown as { toString(): string }).toString(),
    existing,
  );
}

export async function removeHost(alias: string, filePath: string): Promise<void> {
  const existing = await readRawConfig(filePath);
  if (!existing) return;
  const parsed = SSHConfig.parse(existing) as SshConfigSection[];
  removeHostSections(parsed, alias);
  await writeAtomicPreservingTarget(
    filePath,
    (parsed as unknown as { toString(): string }).toString(),
    existing,
  );
}

function projectManagedFields(section: SshConfigSection, host: HostConfig, eol: string): void {
  const hasIdentity = !!host.identityFile;
  const desired: Array<[string, string | null]> = [
    ['HostName', host.hostname],
    ['User', host.user],
    ['Port', host.port && host.port !== DEFAULT_PORT ? String(host.port) : null],
    ['IdentityFile', hasIdentity ? host.identityFile! : null],
    ['IdentitiesOnly', hasIdentity ? 'yes' : null],
  ];
  for (const [name, value] of desired) applyDirective(section, name, value, eol);
  // Always persist Cindy's auth choice. Without an agent marker, a managed
  // host with no local IdentityFile would silently become key auth if it
  // inherits an IdentityFile from an earlier Host * block.
  applyAuthMarker(section, host.authMethod, eol);
}

function findAnyHostSection(parsed: SshConfigSection[], alias: string): SshConfigSection | null {
  return parsed.find((section) => isHostDirective(section)
    && directiveValues(section).includes(alias)) ?? null;
}

function findHostSection(parsed: SshConfigSection[], alias: string): SshConfigSection | null {
  return findAnyHostSection(parsed, alias);
}

function findSingleHostSection(parsed: SshConfigSection[], alias: string): SshConfigSection | null {
  const matches = parsed.filter((section) => isSingleAliasHostSection(section, alias));
  return matches.length === 1 ? matches[0]! : null;
}

function isSingleAliasHostSection(section: SshConfigSection, alias: string): boolean {
  const values = directiveValues(section);
  return isHostDirective(section) && values.length === 1 && values[0] === alias;
}

function isHostDirective(section: SshConfigSection): boolean {
  return section.param?.toLowerCase() === 'host';
}

function directiveValues(section: SshConfigSection): string[] {
  const raw = Array.isArray(section.value) ? section.value : [section.value];
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') values.push(item);
    else if (item && typeof item.val === 'string') values.push(item.val);
  }
  return values;
}

function removeHostSections(parsed: SshConfigSection[], alias: string): void {
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    if (isHostDirective(parsed[index]!) && directiveValues(parsed[index]!).includes(alias)) {
      parsed.splice(index, 1);
    }
  }
}

function applyDirective(
  section: SshConfigSection,
  param: string,
  value: string | null,
  eol: string,
): void {
  const children = section.config ?? [];
  const wanted = param.toLowerCase();
  if (value === null) {
    section.config = children.filter((child) => child.param?.toLowerCase() !== wanted);
    return;
  }
  const serialized = serializeSshValue(value);
  let found = false;
  const next: SshConfigSection[] = [];
  for (const child of children) {
    if (child.param?.toLowerCase() === wanted) {
      if (found) continue;
      child.value = serialized.value;
      child.quoted = serialized.quoted || undefined;
      found = true;
    }
    next.push(child);
  }
  if (!found) {
    next.push({
      type: SSH_CONFIG_DIRECTIVE_TYPE,
      before: '  ',
      after: eol,
      param,
      separator: ' ',
      value: serialized.value,
      quoted: serialized.quoted || undefined,
    });
  }
  section.config = next;
}

function applyAuthMarker(
  section: SshConfigSection,
  method: AuthMarker,
  eol: string,
): void {
  const children = section.config ?? [];
  const next = children.filter((child) => !(child.type === SSH_CONFIG_COMMENT_TYPE
    && (child.content ?? '').trim().startsWith(AUTH_MARKER_PREFIX)));
  const identityIndex = next.findIndex((child) => child.param?.toLowerCase() === 'identityfile');
  const marker: SshConfigSection = {
    type: SSH_CONFIG_COMMENT_TYPE,
    before: '  ',
    after: eol,
    content: `${AUTH_MARKER_PREFIX}${method}`,
  };
  next.splice(identityIndex >= 0 ? identityIndex : next.length, 0, marker);
  section.config = next;
}

function formatHostBlock(host: HostConfig, eol: string): string {
  assertManagedAlias(host.id);
  const parsed = SSHConfig.parse(
    `Host ${formatSshArgument(host.id)}${eol}`,
  ) as SshConfigSection[];
  const section = parsed[0];
  if (!section) throw new Error(`failed to construct managed SSH host: ${host.id}`);
  projectManagedFields(section, host, eol);
  return (parsed as unknown as { toString(): string }).toString();
}

function prepareManagedHostAdd(host: HostConfig, existing: string): string {
  const ownedExisting = assertManagedConfigOwnership(existing);
  const parsed = SSHConfig.parse(ownedExisting) as SshConfigSection[];
  if (findAnyHostSection(parsed, host.id)) {
    throw new Error(`host already exists in managed SSH config: ${host.id}`);
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const separator = existing && !existing.endsWith('\n') && !existing.endsWith('\r') ? eol : '';
  const next = `${ownedExisting}${separator}${formatHostBlock(host, eol)}`;
  // The package parser is also the syntax gate used by discovery. Reparse the
  // exact bytes that will be written so escaping changes cannot publish an
  // unreadable managed file.
  SSHConfig.parse(next);
  return next;
}

function assertManagedConfigOwnership(existing: string): string {
  if (!existing.trim()) return `${MANAGED_CONFIG_MARKER}\n`;
  if (!hasManagedConfigMarker(existing)) {
    const error = new Error(
      'existing managed SSH config is not owned by Cindy; add the Cindy ownership marker or choose another file',
    ) as Error & { code?: string };
    error.code = MANAGED_CONFIG_OWNERSHIP_REQUIRED_CODE;
    throw error;
  }
  return existing;
}

async function isSingleExactInclude(
  value: string,
  configDir: string,
  managedConfigPath: string,
): Promise<boolean> {
  const patterns = splitWords(value);
  if (patterns.length !== 1 || hasGlob(patterns[0]!)) return false;
  const expansion = expandIncludePath(patterns[0]!);
  if ('warning' in expansion) return false;
  const expanded = expansion.pattern;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
  return pathsEqual(await comparablePath(resolved), await comparablePath(managedConfigPath));
}

function formatIncludePath(managedConfigPath: string): string {
  const absolute = path.resolve(managedConfigPath);
  const defaultPath = path.resolve(defaultManagedSshConfigPath());
  const value = pathsEqual(absolute, defaultPath) ? '~/.ssh/cindy.conf' : absolute;
  return formatSshArgument(value);
}

function serializeSshValue(value: string): { value: string; quoted: boolean } {
  assertSafeSshValue(value);
  const quoted = value === '' || value.startsWith('#') || /[\s"\\]/.test(value);
  return {
    value: quoted
      ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      : value,
    quoted,
  };
}

function formatSshArgument(value: string): string {
  const serialized = serializeSshValue(value);
  return serialized.quoted ? `"${serialized.value}"` : serialized.value;
}

function assertSafeSshValue(value: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('SSH config values must not contain NUL or line breaks');
  }
}

function assertManagedAlias(alias: string): void {
  assertSafeSshValue(alias);
  if (!alias
    || /\s/.test(alias)
    || alias.includes('*')
    || alias.includes('?')
    || alias.includes('[')
    || alias.startsWith('!')) {
    throw new Error(`invalid managed SSH alias: ${alias}`);
  }
}

function splitLinesKeepingEndings(value: string): string[] {
  if (!value) return [];
  return value.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function stripLineEnding(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

/** Return an OpenSSH inline comment; token-internal `#` is ordinary text. */
function extractInlineComment(line: string): string | null {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') index += 1;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) {
      return line.slice(index).trimEnd();
    }
  }
  return null;
}

async function readRawConfig(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function readRawConfigBytes(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

function managedConfigToken(bytes: Uint8Array): ManagedConfigWriteToken {
  return createHash('sha256').update(bytes).digest('hex') as ManagedConfigWriteToken;
}

function assertManagedWriteToken(
  token: ManagedConfigWriteToken | undefined,
): asserts token is ManagedConfigWriteToken {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) return;
  const error = new Error('managed SSH config write token is required') as Error & { code?: string };
  error.code = MANAGED_CONFIG_WRITE_TOKEN_REQUIRED_CODE;
  throw error;
}

function assertManagedConfigUnchanged(
  currentBytes: Uint8Array,
  expectedToken: ManagedConfigWriteToken,
): void {
  if (managedConfigToken(currentBytes) === expectedToken) return;
  const conflict = new Error(
    'SSH config changed after Cindy validated it; reload before retrying.',
  ) as Error & { code?: string };
  conflict.code = MANAGED_CONFIG_CONCURRENT_MODIFICATION_CODE;
  throw conflict;
}

async function writeAtomicPreservingTarget(
  filePath: string,
  content: string,
  expectedContent: string,
): Promise<void> {
  const requested = path.resolve(filePath);
  let target = requested;
  let existingMode: number | undefined;
  try {
    const lstat = await fs.lstat(requested);
    if (lstat.isSymbolicLink()) target = await fs.realpath(requested);
    const stat = await fs.stat(target);
    existingMode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let requestedIsSymlink = false;
    try {
      const lstat = await fs.lstat(requested);
      requestedIsSymlink = lstat.isSymbolicLink();
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') throw lstatError;
    }
    if (requestedIsSymlink) throw error;
  }

  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.cindy-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    await fs.writeFile(tempPath, content, { flag: 'wx', mode: existingMode ?? 0o600 });
    if (existingMode !== undefined) await fs.chmod(tempPath, existingMode);
    if (await readRawConfig(target) !== expectedContent) {
      const conflict = new Error(
        'SSH config changed while Cindy was preparing an update; retry the operation.',
      ) as Error & { code?: string };
      conflict.code = MANAGED_CONFIG_CONCURRENT_MODIFICATION_CODE;
      throw conflict;
    }
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function restoreManagedConfigIfUnchanged(
  managedConfigPath: string,
  publishedContent: string,
  previousContent: string,
): Promise<boolean> {
  if (await readRawConfig(managedConfigPath) !== publishedContent) return false;
  try {
    await writeAtomicPreservingTarget(managedConfigPath, previousContent, publishedContent);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === MANAGED_CONFIG_CONCURRENT_MODIFICATION_CODE) return false;
    throw error;
  }
}

async function comparablePath(value: string): Promise<string> {
  const absolute = path.resolve(expandHome(value));
  let comparable = absolute;
  try {
    comparable = await fs.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  comparable = path.normalize(comparable);
  return process.platform === 'win32' ? comparable.toLowerCase() : comparable;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function limitError(pathName: string, message: string): Error & { code: string; path: string } {
  const error = new Error(message) as Error & { code: string; path: string };
  error.code = 'SSH_CONFIG_LIMIT';
  error.path = pathName;
  return error;
}

function toConfigDiagnostic(filePath: string, error: unknown): SshConfigDiagnostic {
  const code = (error as { code?: string }).code;
  const kind: SshConfigDiagnostic['kind'] = code === 'SSH_CONFIG_LIMIT'
    ? 'limit'
    : code === 'SSH_CONFIG_SYNTAX'
      ? 'syntax'
      : 'io';
  return {
    path: typeof (error as { path?: unknown }).path === 'string'
      ? (error as { path: string }).path
      : filePath,
    kind,
    message: error instanceof Error ? error.message : String(error),
    recoveryHint: kind === 'syntax'
      ? 'Fix the SSH config syntax, then refresh.'
      : kind === 'limit'
        ? 'Reduce Include nesting, file count, or config size, then refresh.'
        : 'Check SSH config permissions and Include paths, then refresh.',
  };
}
