/**
 * Product-owned shell command policy for the embedded iOS Simulator.
 *
 * Agent skills may contain legacy `simctl` / `open -a Simulator` recipes. Those
 * commands bypass Cindy's ownership, admission, viewer, and cleanup contracts,
 * so prompt guidance alone is not a sufficient boundary. This module detects
 * literal executable shell segments and denies only the bypass paths; Cindy's
 * own main process still uses simctl through the runtime adapter and is
 * unaffected. This is defense in depth for command text, not an OS process
 * sandbox: scripts whose contents are absent from the command cannot be proven
 * safe here and remain subject to the normal shell permission boundary.
 */

export interface ShellCommandPolicyDenial {
  decision: 'deny';
  reason: string;
}

const SAFE_SIMCTL_COMMANDS = new Set([
  'help',
  'list',
  'listapps',
  'getenv',
  'get_app_container',
  'diagnose',
]);

const IOS_SIMULATOR_SHELL_DENIAL =
  'Cindy blocked a shell command that would bypass the embedded iOS Simulator. ' +
  'Use cindy_ios_simulator for device lifecycle, app install/launch, interaction, screenshots, and diagnostics. External Simulator.app automation is unavailable until Cindy can issue an explicit host authorization.';

/** Split command lists without treating separators inside quotes as executable boundaries. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Lightweight argv tokenizer. Quotes group tokens but are not retained. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
      token += segment[index + 1]!;
      started = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

function executableName(token: string | undefined): string {
  return (token ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function stripShellControlTokens(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 0 && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(out[0]!)) {
    out.shift();
  }
  if (out[0]) out[0] = out[0].replace(/^[({]+/, '');
  while (out[0] === '') out.shift();
  const last = out.length - 1;
  if (last >= 0) {
    out[last] = out[last]!.replace(/[)}]+$/, '');
    if (out[last] === '') out.pop();
  }
  return out;
}

function shellRedirectionSuffix(token: string): string | null {
  const match = /^(?:\d+)?(?:<<<|<<-?|<>|<|>>?|>&|<&|>\|)(.*)$/s.exec(token);
  return match ? (match[1] ?? '') : null;
}

function stripShellRedirections(input: string[]): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const suffix = shellRedirectionSuffix(input[index]!);
    if (suffix === null) {
      tokens.push(input[index]!);
      continue;
    }
    if (suffix === '' && index + 1 < input.length) index += 1;
  }
  return tokens;
}

/** Remove leading assignments/redirections so the next token is the command word. */
function stripLeadingShellPreamble(input: string[]): string[] {
  const tokens = [...input];
  while (tokens.length > 0) {
    const token = tokens[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      tokens.shift();
      continue;
    }
    const redirectionSuffix = shellRedirectionSuffix(token);
    if (redirectionSuffix === null) break;
    tokens.shift();
    if (redirectionSuffix === '' && tokens.length > 0) tokens.shift();
  }
  return tokens;
}

interface UnwrappedCommand {
  tokens: string[];
  nestedShell: string | null;
  inspectionOnly: boolean;
  unresolvedWrapper: boolean;
}

const MAX_WRAPPER_UNWRAP_DEPTH = 16;
const SHELL_EXECUTABLES = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);
const NON_EXECUTING_REFERENCE_COMMANDS = new Set([
  'cat',
  'echo',
  'egrep',
  'fgrep',
  'file',
  'grep',
  'head',
  'less',
  'ls',
  'more',
  'printf',
  'rg',
  'stat',
  'tail',
  'wc',
]);
const OPAQUE_EXECUTION_WRAPPERS = new Set([
  'coproc',
  'doas',
  'gtimeout',
  'launchctl',
  'parallel',
  'repeat',
  'sandbox-exec',
  'script',
  'sudo',
  'timeout',
  'watch',
  'xargs',
]);
const SHELL_POSITIONAL_REFERENCE = /\$(?:[0-9]+|[@*#-]|\{(?:[0-9]+|[@*#-])\})/;
const PROGRAMMABLE_INTERPRETER =
  /^(?:python(?:\d+(?:\.\d+)*)?|pypy(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|ruby(?:\d+(?:\.\d+)*)?|perl(?:\d+(?:\.\d+)*)?|php(?:\d+(?:\.\d+)*)?|lua(?:\d+(?:\.\d+)*)?|luajit|swift|expect(?:\d+(?:\.\d+)*)?|tclsh(?:\d+(?:\.\d+)*)?|wish(?:\d+(?:\.\d+)*)?|(?:g|m|n)?awk)$/;

/** Peel only wrappers whose argv shape is fully understood; unknown options fail closed. */
function unwrapCommand(input: string[]): UnwrappedCommand {
  let tokens = stripLeadingShellPreamble(stripShellControlTokens(input));
  for (let depth = 0; depth < MAX_WRAPPER_UNWRAP_DEPTH; depth += 1) {
    tokens = stripLeadingShellPreamble(tokens);
    if (tokens.length === 0) {
      return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: false };
    }
    const head = executableName(tokens[0]);
    if (head === 'env') {
      let index = 1;
      let unresolved = false;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (
          token === '-' ||
          token === '-i' ||
          token === '--ignore-environment' ||
          token === '-0' ||
          token === '--null'
        ) {
          index += 1;
          continue;
        }
        if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir') {
          if (index + 1 >= tokens.length) unresolved = true;
          index += 2;
          continue;
        }
        if (
          /^--(?:unset|chdir)=/.test(token) ||
          /^-(?:u|C).+/.test(token) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
        ) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) unresolved = true;
        break;
      }
      tokens = tokens.slice(index);
      if (unresolved) {
        return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: true };
      }
      continue;
    }
    if (head === 'command') {
      let index = 1;
      let inspectionOnly = false;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (/^-[pVv]+$/.test(token)) {
          inspectionOnly ||= /[Vv]/.test(token);
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      if (inspectionOnly) {
        return { tokens: [], nestedShell: null, inspectionOnly: true, unresolvedWrapper: false };
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'exec') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-a') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-a.+/.test(token) || /^-[cl]+$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'time') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (/^-[alhp]+$/.test(token)) {
          index += 1;
          continue;
        }
        if (token === '-o') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-o.+/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'builtin' || head === 'nocorrect' || head === 'noglob' || head === 'nohup') {
      let index = 1;
      if (tokens[index] === '--') index += 1;
      else if (tokens[index]?.startsWith('-')) {
        return {
          tokens: tokens.slice(index),
          nestedShell: null,
          inspectionOnly: false,
          unresolvedWrapper: true,
        };
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'nice') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-n' || token === '--adjustment') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^(?:--adjustment=.+|-\d+)$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'arch') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-arch' || token === '--arch' || token === '-d' || token === '-e') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-(?:arm64e?|x86_64|i386|32|64|c)$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'caffeinate') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-t' || token === '-w') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-[dimsur]+$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'eval') {
      return {
        tokens: [],
        nestedShell: tokens.slice(1).join(' '),
        inspectionOnly: false,
        unresolvedWrapper: false,
      };
    }
    if (SHELL_EXECUTABLES.has(head)) {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '-o' || token === '-O') {
          index += 2;
          continue;
        }
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
          const nestedShell = tokens[index + 1] ?? '';
          const positionalArgs = tokens.slice(index + 2);
          return {
            tokens: positionalArgs,
            nestedShell,
            inspectionOnly: false,
            unresolvedWrapper:
              index + 1 >= tokens.length ||
              (SHELL_POSITIONAL_REFERENCE.test(nestedShell) &&
                containsSimulatorExecutor(positionalArgs)),
          };
        }
        if (token === '--') break;
        if (!token.startsWith('-')) break;
        index += 1;
      }
    }
    return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: false };
  }
  return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: true };
}

function isExternalSimulatorLaunch(tokens: string[]): boolean {
  const head = executableName(tokens[0]);
  if (head === 'open') {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const next = tokens[index + 1];
      if (/^-[^-]*a[^-]*$/i.test(token) && /^Simulator(?:\.app)?$/i.test(next ?? '')) return true;
      if (/^-aSimulator(?:\.app)?$/i.test(token)) return true;
      if (/^-[^-]*b[^-]*$/i.test(token) && /^com\.apple\.iphonesimulator$/i.test(next ?? '')) {
        return true;
      }
      if (/^-bcom\.apple\.iphonesimulator$/i.test(token)) return true;
      if (/\/Simulator\.app(?:\/Contents\/MacOS\/Simulator)?$/i.test(token)) return true;
    }
  }
  return (
    head === 'simulator' && /Simulator\.app\/Contents\/MacOS\/Simulator$/i.test(tokens[0] ?? '')
  );
}

function simctlSubcommand(tokens: string[]): string | null {
  let index = 0;
  if (executableName(tokens[index]) === 'xcrun') {
    index += 1;
    while (index < tokens.length && tokens[index]!.startsWith('-')) {
      const option = tokens[index]!;
      if (
        option === '--sdk' ||
        option === '-sdk' ||
        option === '--toolchain' ||
        option === '-toolchain'
      ) {
        index += 2;
      } else {
        index += 1;
      }
    }
  }
  if (executableName(tokens[index]) !== 'simctl') return null;
  index += 1;
  if (tokens[index] === '--set') index += 2;
  return tokens[index]?.toLowerCase() ?? null;
}

function isSimulatorMutation(tokens: string[]): boolean {
  const subcommand = simctlSubcommand(tokens);
  return subcommand !== null && !SAFE_SIMCTL_COMMANDS.has(subcommand);
}

function containsSimulatorExecutor(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      /(?:^|\/)simctl$/i.test(token) ||
      /Simulator(?:\.app)?/i.test(token) ||
      /\bxcrun\b[\s\S]*\bsimctl\b/i.test(token),
  );
}

function containsLiteralSimulatorExecutor(value: string): boolean {
  const argvLike = value.replace(/[^A-Za-z0-9_./-]+/g, ' ').trim();
  return (
    /\b(?:xcrun|simctl)\b/i.test(value) ||
    /\bSimulator\.app\b/i.test(value) ||
    /\bcom\.apple\.iphonesimulator\b/i.test(value) ||
    /(?:^|\s)(?:\S*\/)?open(?:\s+-[A-Za-z]+)*\s+Simulator(?:\.app)?(?:\s|$)/i.test(argvLike)
  );
}

/**
 * General-purpose interpreters can spawn simctl without making it the shell
 * executable. Treat a literal Simulator executor in their payload/argv as a
 * mutation-capable wrapper; command-text policy cannot safely inspect the
 * language semantics beneath this point.
 */
function containsInterpreterSimulatorPayload(tokens: string[]): boolean {
  const interpreter = executableName(tokens[0]);
  const payload = tokens.slice(1).join('\n');
  if (PROGRAMMABLE_INTERPRETER.test(interpreter)) {
    return containsLiteralSimulatorExecutor(payload);
  }
  if (interpreter === 'osascript') {
    // AppleScript can execute through `do shell script`, while JavaScript for
    // Automation can reach NSTask/NSProcessInfo directly. Once an osascript
    // payload contains a literal Simulator executor, command-text policy cannot
    // safely distinguish an inert reference from executable code.
    return containsLiteralSimulatorExecutor(payload);
  }
  return false;
}

/**
 * Fail closed when a command passes a literal Simulator executor to an opaque
 * execution wrapper (for example xargs or find -exec). Commands whose only
 * purpose is displaying/searching text remain outside this boundary.
 */
function containsOpaqueSimulatorExecution(tokens: string[]): boolean {
  const head = executableName(tokens[0]);
  if (!head || NON_EXECUTING_REFERENCE_COMMANDS.has(head) || head === 'osascript') return false;
  const findExec =
    head === 'find' && tokens.some((token) => /^-(?:exec|execdir|ok|okdir)$/.test(token));
  if (!findExec && !OPAQUE_EXECUTION_WRAPPERS.has(head)) return false;
  // Direct simctl commands have already been classified above, including the
  // explicitly read-only allowlist.
  if (simctlSubcommand(tokens) !== null) return false;
  return containsLiteralSimulatorExecutor(tokens.slice(1).join(' '));
}

/** Extract command/process substitutions because they execute even inside an otherwise safe command. */
function shellSubcommands(command: string): string[] {
  const subcommands: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'") {
      if (quote === "'") quote = null;
      else if (quote === null) quote = "'";
      continue;
    }
    if (char === '"') {
      if (quote === '"') quote = null;
      else if (quote === null) quote = '"';
      continue;
    }
    if (quote === "'") continue;
    if (char === '`') {
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === '\\') end += 1;
        else if (command[end] === '`') break;
      }
      if (end < command.length) {
        subcommands.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if ((char === '$' || char === '<' || char === '>') && command[index + 1] === '(') {
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let end = index + 2;
      for (; end < command.length && depth > 0; end += 1) {
        const inner = command[end]!;
        if (inner === '\\' && innerQuote !== "'") {
          end += 1;
          continue;
        }
        if (inner === "'" || inner === '"') {
          if (innerQuote === inner) innerQuote = null;
          else if (innerQuote === null) innerQuote = inner;
          continue;
        }
        if (innerQuote) continue;
        if (inner === '(') depth += 1;
        else if (inner === ')') depth -= 1;
      }
      if (depth === 0) {
        subcommands.push(command.slice(index + 2, end - 1));
        index = end - 1;
      }
    }
  }
  return subcommands;
}

/** Split independent command clauses while retaining pipeline boundaries. */
function shellClauses(command: string): string[] {
  const clauses: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === '|' && command[index + 1] === '|') {
      if (current.trim()) clauses.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    if (char === '&' && current.trimEnd().endsWith('|')) {
      current += char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '&') {
      if (current.trim()) clauses.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

function isLiteralSimulatorBypass(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const unwrapped = unwrapCommand(tokenizeShellSegment(segment));
    if (unwrapped.inspectionOnly || unwrapped.unresolvedWrapper) continue;
    if (isExternalSimulatorLaunch(unwrapped.tokens) || isSimulatorMutation(unwrapped.tokens)) {
      return true;
    }
  }
  return false;
}

function isSimulatorExecutorValue(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/');
  return /(?:^|\/)(?:xcrun|simctl)$/i.test(normalized) || /Simulator(?:\.app)?/i.test(normalized);
}

/** Dynamic command names can resolve to a Simulator bypass, so execution must fail closed. */
function hasDynamicShellExpansion(token: string): boolean {
  return /[$`*?[\]{}()^~]/.test(token) || token.indexOf('#') > 0;
}

function hasUnresolvedExecutableExpansion(tokens: string[]): boolean {
  const executableTokens = stripShellControlTokens(tokens);
  while (executableTokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(executableTokens[0])) {
    executableTokens.shift();
  }
  const executable = executableTokens[0] ?? '';
  // `[` and `[[` are literal shell condition builtins, not glob-expanded
  // executable names. Other expansion syntax in command position is unsafe.
  if (executable === '[' || executable === '[[') return false;
  return hasDynamicShellExpansion(executable);
}

/** Arithmetic compound commands contain expressions, not an executable argv. */
function isArithmeticCompoundCommand(tokens: string[]): boolean {
  let index = 0;
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  while (tokens[index] && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(tokens[index]!)) {
    index += 1;
  }
  return tokens[index] === '((' || tokens[index]?.startsWith('((') === true;
}

/**
 * Shell arithmetic recursively resolves bare variables and array subscripts,
 * which can execute command substitutions stored in their values. Only
 * expressions made entirely from decimal literals and operators are safe to
 * classify without evaluating the shell environment.
 */
function hasDynamicArithmeticEvaluation(segment: string): boolean {
  const start = segment.indexOf('((');
  const end = segment.lastIndexOf('))');
  if (start < 0 || end < start + 2) return true;
  const expression = segment.slice(start + 2, end);
  return !/^[\s0-9()+\-*/%<>=!&|^~?:,]*$/.test(expression);
}

/** Unknown wrapper option shapes cannot prove which expanded token becomes the command. */
function hasUnresolvedWrapperExpansion(unwrapped: UnwrappedCommand): boolean {
  return (
    unwrapped.unresolvedWrapper && unwrapped.tokens.some((token) => hasDynamicShellExpansion(token))
  );
}

type OpaqueOptionShape = 'flag' | 'value' | 'command' | 'unknown';

function opaqueOptionShape(head: string, token: string): OpaqueOptionShape {
  const option = token.replace(/=.*/s, '=');
  if (head === 'sudo') {
    if (
      /^(?:-[CDghpRrTtUu]|--(?:chdir|close-from|group|host|prompt|role|command-timeout|type|other-user|user))$/.test(
        token,
      )
    )
      return 'value';
    if (
      /^(?:-[ABbEeHhKklnPSsVv]|--(?:askpass|bell|background|edit|preserve-env|set-home|help|remove-timestamp|reset-timestamp|list|non-interactive|stdin|shell|validate|version))$/.test(
        token,
      )
    )
      return 'flag';
    if (/^(?:-[CDghpRrTtUu].+|--[^=]+=)/.test(token)) return 'flag';
  }
  if (head === 'doas') {
    if (/^-(?:a|C|u)$/.test(token)) return 'value';
    if (/^-(?:L|n|s)$/.test(token) || /^-(?:a|C|u).+/.test(token)) return 'flag';
  }
  if (head === 'xargs') {
    if (
      /^(?:-[EILnPRSs]|--(?:eof|replace|max-lines|max-args|max-procs|right|max-chars))$/.test(token)
    )
      return 'value';
    if (/^(?:-[0oprtx]|--(?:null|open-tty|interactive|no-run-if-empty|verbose|exit))$/.test(token))
      return 'flag';
    if (/^(?:-[EILnPRSs].+|--[^=]+=)/.test(token)) return 'flag';
  }
  if (head === 'sandbox-exec') {
    if (/^-(?:D|f|n|p)$/.test(token)) return 'value';
    if (/^-(?:D|f|n|p).+/.test(token)) return 'flag';
  }
  if (head === 'launchctl') {
    if (token === '-p') return 'command';
    if (/^-(?:l|o|e)$/.test(token)) return 'value';
    if (/^-(?:l|o|e).+/.test(token)) return 'flag';
  }
  if (head === 'timeout' || head === 'gtimeout') {
    if (/^(?:-k|-s|--kill-after|--signal)$/.test(token)) return 'value';
    if (/^(?:-v|--foreground|--preserve-status|--verbose)$/.test(token)) return 'flag';
    if (/^(?:-[ks].+|--[^=]+=)/.test(token)) return 'flag';
  }
  if (head === 'watch') {
    if (/^(?:-n|--interval)$/.test(token)) return 'value';
    if (
      /^(?:-[bcegpqrtwx]+|-d(?:=permanent)?|--(?:beep|color|differences(?:=permanent)?|chgexit|errexit|equexit|no-rerun|no-title|no-wrap|precise|exec))$/.test(
        token,
      )
    )
      return 'flag';
    if (/^(?:-n.+|--interval=)/.test(option)) return 'flag';
  }
  if (head === 'script') {
    if (/^(?:-c|--command)$/.test(token)) return 'command';
    if (/^(?:-t|-T|--timing)$/.test(token)) return 'value';
    if (/^-[adeFkpqr]+$/.test(token)) return 'flag';
  }
  return 'unknown';
}

function hasDynamicWrappedCommand(tokens: string[], depth: number): boolean {
  if (tokens.length === 0) return false;
  if (depth > MAX_WRAPPER_UNWRAP_DEPTH) {
    return tokens.some((token) => hasDynamicShellExpansion(token));
  }
  const unwrapped = unwrapCommand(tokens);
  if (unwrapped.inspectionOnly) return false;
  if (hasUnresolvedWrapperExpansion(unwrapped)) return true;
  if (unwrapped.nestedShell !== null) {
    if (containsSimulatorBypass(unwrapped.nestedShell, depth + 1)) return true;
    return unwrapped.tokens.some((token) => hasDynamicShellExpansion(token));
  }
  if (hasUnresolvedExecutableExpansion(unwrapped.tokens)) return true;
  return hasOpaqueWrapperExpansion(tokens, depth + 1);
}

/** Locate the command operand conservatively without mistaking later data argv for executables. */
function hasOpaqueWrapperExpansion(tokens: string[], depth = 0): boolean {
  tokens = stripShellRedirections(tokens);
  const head = executableName(tokens[0]);
  if (head === 'find') {
    for (let index = 1; index < tokens.length; index += 1) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(tokens[index]!)) continue;
      const terminator = tokens.findIndex(
        (token, candidateIndex) =>
          candidateIndex > index && (token === ';' || token === '+' || token === '\\;'),
      );
      const commandEnd = terminator < 0 ? tokens.length : terminator;
      return hasDynamicWrappedCommand(tokens.slice(index + 1, commandEnd), depth + 1);
    }
    return false;
  }
  if (!OPAQUE_EXECUTION_WRAPPERS.has(head)) return false;
  if (head === 'coproc') {
    // Bash/zsh allow an optional coprocess name, so command position is
    // ambiguous. Any expansion in this execution form must fail closed.
    return tokens.slice(1).some((token) => hasDynamicShellExpansion(token));
  }
  if (head === 'repeat') {
    // zsh evaluates the count arithmetically before executing argv.
    if (!/^\d+$/.test(tokens[1] ?? '')) return true;
    return hasDynamicWrappedCommand(tokens.slice(2), depth + 1);
  }

  let index = 1;
  if (head === 'launchctl') {
    if (tokens[1] === 'submit') index = 2;
    else if (tokens[1] === 'asuser' || tokens[1] === 'bsexec') index = 3;
  }
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) break;
    const shape = opaqueOptionShape(head, token);
    const possibleValue = tokens[index + 1];
    if (shape === 'command') {
      const commandValue = token.includes('=')
        ? token.slice(token.indexOf('=') + 1)
        : possibleValue;
      if (hasDynamicShellExpansion(commandValue ?? '')) return true;
      index += token.includes('=') ? 1 : 2;
      continue;
    }
    if (shape === 'value') {
      index += 2;
      continue;
    }
    if (shape === 'flag') {
      index += 1;
      continue;
    }
    // Unknown option arity makes every later dynamic token ambiguous: it may
    // be either an option value or the actual command. Fail closed instead of
    // guessing and accidentally stepping past the executable.
    return tokens.slice(index).some((value) => hasDynamicShellExpansion(value));
  }
  if (head === 'sudo') {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  }
  // timeout consumes a duration before its command; macOS script consumes an
  // output file before an optional command.
  if (head === 'timeout' || head === 'gtimeout' || head === 'script') index += 1;
  return hasDynamicWrappedCommand(tokens.slice(index), depth + 1);
}

function referencesVariable(command: string, variable: string): boolean {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\$(?:${escaped}\\b|\\{${escaped}\\})`).test(command);
}

const SHELL_ASSIGNMENT_BUILTINS = new Set(['declare', 'export', 'local', 'readonly', 'typeset']);

function collectShellAssignments(tokens: string[]): Array<{ name: string; value: string }> {
  const assignments: Array<{ name: string; value: string }> = [];
  let index = 0;
  const head = executableName(tokens[0]);
  if (SHELL_ASSIGNMENT_BUILTINS.has(head)) {
    index = 1;
    while (tokens[index]?.startsWith('-')) index += 1;
  }
  for (; index < tokens.length; index += 1) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tokens[index]!);
    if (!assignment) {
      if (!SHELL_ASSIGNMENT_BUILTINS.has(head)) break;
      continue;
    }
    assignments.push({ name: assignment[1]!, value: assignment[2] ?? '' });
  }
  return assignments;
}

/** Track simple shell assignments so a later eval/sh -c/$VAR cannot hide a bypass. */
function containsTaintedVariableExecution(command: string): boolean {
  const tainted = new Set<string>();
  const tokenizedSegments = shellSegments(command).map((segment) => ({
    segment,
    tokens: tokenizeShellSegment(segment),
  }));
  const assignments = tokenizedSegments.flatMap(({ tokens }) => collectShellAssignments(tokens));
  for (const { segment } of tokenizedSegments) {
    for (const match of segment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=\$\(([^)]*)\)/g)) {
      if (containsLiteralSimulatorExecutor(match[2] ?? '')) tainted.add(match[1]!);
    }
  }
  for (const assignment of assignments) {
    if (isLiteralSimulatorBypass(assignment.value) || isSimulatorExecutorValue(assignment.value)) {
      tainted.add(assignment.name);
    }
  }
  if (tainted.size === 0) return false;

  for (const { segment, tokens } of tokenizedSegments) {
    const unwrapped = unwrapCommand(tokens);
    for (const variable of tainted) {
      if (unwrapped.nestedShell !== null && referencesVariable(unwrapped.nestedShell, variable)) {
        return true;
      }
      if (referencesVariable(unwrapped.tokens[0] ?? '', variable)) return true;
      if (
        executableName(unwrapped.tokens[0]) === 'xcrun' &&
        unwrapped.tokens.some((token) => referencesVariable(token, variable))
      ) {
        return true;
      }
      // Unknown wrappers are unsafe when they consume a tainted command value.
      if (unwrapped.unresolvedWrapper && referencesVariable(segment, variable)) return true;
    }
  }
  return false;
}

function nestedShellConsumesStdinAsProgram(command: string): boolean {
  return (
    /(?:^|[;&|]\s*)(?:source|\.)\s+(?:\/dev\/stdin|\/dev\/fd\/0|-)(?:\s|$)/i.test(command) ||
    /\beval\b[\s\S]*\$\(\s*cat(?:\s+(?:-|\/dev\/stdin|\/dev\/fd\/0))?\s*\)/i.test(command)
  );
}

function consumesStdinAsProgram(tokens: string[]): boolean {
  const unwrapped = unwrapCommand(tokens);
  if (unwrapped.nestedShell !== null) {
    return !unwrapped.unresolvedWrapper && nestedShellConsumesStdinAsProgram(unwrapped.nestedShell);
  }
  if (unwrapped.unresolvedWrapper) return false;
  const executable = executableName(unwrapped.tokens[0]);
  const args = unwrapped.tokens.slice(1);
  if (SHELL_EXECUTABLES.has(executable)) {
    if (args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return false;
    if (args.some((arg) => /^-[A-Za-z]*s[A-Za-z]*$/.test(arg))) return true;
  } else if (executable === 'osascript') {
    if (args.some((arg) => arg === '-e' || arg.startsWith('-e'))) return false;
  } else if (PROGRAMMABLE_INTERPRETER.test(executable)) {
    if (/^(?:(?:g|m|n)?awk)$/.test(executable)) return false;
    if (args.some((arg) => /^(?:-c|-e|-p|-m|--eval|--print|--input-type|--module)$/.test(arg))) {
      return false;
    }
  } else {
    return false;
  }
  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional === undefined || positional === '-';
}

function containsInterpreterHeredocBypass(command: string): boolean {
  const lines = command.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!marker) continue;
    if (
      !shellSegments(line.slice(0, marker.index)).some((segment) =>
        consumesStdinAsProgram(tokenizeShellSegment(segment)),
      )
    ) {
      continue;
    }
    const delimiter = marker[2]!;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      if ((lines[index] ?? '').replace(/^\t+/, '').trim() === delimiter) break;
      body.push(lines[index] ?? '');
    }
    if (containsLiteralSimulatorExecutor(body.join('\n'))) return true;
  }
  return false;
}

/** A here-string is executable stdin just like a heredoc or producer pipeline. */
function containsInterpreterHereStringBypass(command: string): boolean {
  for (const clause of shellClauses(command)) {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let index = 0; index < clause.length - 2; index += 1) {
      const char = clause[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && quote !== "'") {
        escaped = true;
        continue;
      }
      if (char === "'" || char === '"') {
        if (quote === char) quote = null;
        else if (quote === null) quote = char;
        continue;
      }
      if (quote || clause.slice(index, index + 3) !== '<<<') continue;
      const consumer = clause.slice(0, index).trim();
      const payload = clause.slice(index + 3);
      if (
        shellSegments(consumer).some((segment) =>
          consumesStdinAsProgram(tokenizeShellSegment(segment)),
        ) &&
        containsLiteralSimulatorExecutor(payload)
      ) {
        return true;
      }
      break;
    }
  }
  return false;
}

/** A literal command piped to a code-reading interpreter becomes executable input. */
function containsShellConsumedLiteralBypass(command: string): boolean {
  if (containsInterpreterHeredocBypass(command) || containsInterpreterHereStringBypass(command)) {
    return true;
  }
  for (const clause of shellClauses(command)) {
    if (!clause.includes('|')) continue;
    const segments = shellSegments(clause);
    if (
      segments.some((segment) => consumesStdinAsProgram(tokenizeShellSegment(segment))) &&
      containsLiteralSimulatorExecutor(clause)
    ) {
      return true;
    }
  }
  return false;
}

function isLiteralXcrunBoundaryToken(token: string): boolean {
  return /^[A-Za-z0-9_./:+-]+$/.test(token);
}

function hasUnresolvedXcrunTool(tokens: string[]): boolean {
  if (executableName(tokens[0]) !== 'xcrun') return false;
  let index = 1;
  while (index < tokens.length && tokens[index]!.startsWith('-')) {
    const option = tokens[index]!;
    if (/^(?:--sdk|-sdk|--toolchain|-toolchain)=/.test(option)) {
      const value = option.slice(option.indexOf('=') + 1);
      if (!isLiteralXcrunBoundaryToken(value)) return true;
      index += 1;
      continue;
    }
    if (
      option === '--sdk' ||
      option === '-sdk' ||
      option === '--toolchain' ||
      option === '-toolchain'
    ) {
      const value = tokens[index + 1];
      if (!value || !isLiteralXcrunBoundaryToken(value)) return true;
      index += 2;
      continue;
    }
    index += 1;
  }
  const firstToolToken = tokens[index] ?? '';
  return firstToolToken !== '' && !isLiteralXcrunBoundaryToken(firstToolToken);
}

const SHELL_FUNCTION_HEADER_SOURCE =
  '(?:(?:function\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*\\(\\s*\\)|function\\s+[A-Za-z_][A-Za-z0-9_]*)';
const SHELL_FUNCTION_DEFINITION_PREFIX = new RegExp(`^${SHELL_FUNCTION_HEADER_SOURCE}\\s*[({]`);

function shellCompoundBodyEnd(command: string, openingIndex: number): number | null {
  const opening = command[openingIndex];
  if (opening !== '{' && opening !== '(') return null;
  const closing = opening === '{' ? '}' : ')';
  let nesting = 1;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = openingIndex + 1; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === opening) nesting += 1;
    else if (char === closing) {
      nesting -= 1;
      if (nesting === 0) return index;
    }
  }
  return null;
}

/** Function bodies are executable later, so reject unsafe bodies at definition time. */
function containsSimulatorFunctionBody(command: string, depth: number): boolean {
  const functionPattern = new RegExp(
    `(?:^|[;\\n]\\s*)${SHELL_FUNCTION_HEADER_SOURCE}\\s*([({])`,
    'g',
  );
  while (functionPattern.exec(command) !== null) {
    const openingIndex = functionPattern.lastIndex - 1;
    const closingIndex = shellCompoundBodyEnd(command, openingIndex);
    if (closingIndex === null) continue;
    if (containsSimulatorBypass(command.slice(openingIndex + 1, closingIndex), depth + 1)) {
      return true;
    }
    functionPattern.lastIndex = closingIndex + 1;
  }
  return false;
}

/** Alias bodies are executable later, so reject unsafe definitions up front. */
function containsSimulatorAliasDefinition(tokens: string[], depth: number): boolean {
  if (executableName(tokens[0]) !== 'alias') return false;
  let index = tokens[1] === '--' ? 2 : 1;
  for (; index < tokens.length; index += 1) {
    const definition = tokens[index]!;
    const separator = definition.indexOf('=');
    // `alias` and `alias name` only inspect the current shell state.
    if (separator <= 0) continue;
    const body = definition.slice(separator + 1);
    if (containsLiteralSimulatorExecutor(body) || containsSimulatorBypass(body, depth + 1)) {
      return true;
    }
  }
  return false;
}

function containsSimulatorBypass(command: string, depth = 0): boolean {
  if (depth > 8) return /\b(?:simctl|Simulator(?:\.app)?)\b/i.test(command);
  if (
    containsTaintedVariableExecution(command) ||
    containsShellConsumedLiteralBypass(command) ||
    containsSimulatorFunctionBody(command, depth)
  ) {
    return true;
  }
  for (const nested of shellSubcommands(command)) {
    if (containsSimulatorBypass(nested, depth + 1)) return true;
  }
  for (const segment of shellSegments(command)) {
    // Function bodies were classified recursively above. The leading
    // `name(){` token is not an execution wrapper in its own right.
    if (SHELL_FUNCTION_DEFINITION_PREFIX.test(segment)) {
      continue;
    }
    const tokens = tokenizeShellSegment(segment);
    const arithmeticCompound = isArithmeticCompoundCommand(tokens);
    if (arithmeticCompound && hasDynamicArithmeticEvaluation(segment)) return true;
    const unwrapped = unwrapCommand(tokens);
    if (unwrapped.inspectionOnly) continue;
    // Known wrappers are peeled first so `env "$TOOL"` and `exec "$TOOL"`
    // cannot hide a dynamically constructed executable. Shell `-c`
    // positional arguments are not executables by themselves; its nested
    // program is classified recursively below instead.
    if (
      !arithmeticCompound &&
      unwrapped.nestedShell === null &&
      hasUnresolvedExecutableExpansion(unwrapped.tokens)
    ) {
      return true;
    }
    if (hasUnresolvedWrapperExpansion(unwrapped) || hasOpaqueWrapperExpansion(tokens)) {
      return true;
    }
    if (containsSimulatorAliasDefinition(unwrapped.tokens, depth)) return true;
    if (unwrapped.nestedShell !== null) {
      if (unwrapped.unresolvedWrapper)
        return containsSimulatorExecutor(tokenizeShellSegment(segment));
      if (containsSimulatorBypass(unwrapped.nestedShell, depth + 1)) return true;
      continue;
    }
    if (unwrapped.unresolvedWrapper && containsSimulatorExecutor(unwrapped.tokens)) return true;
    if (
      hasUnresolvedXcrunTool(unwrapped.tokens) ||
      containsInterpreterSimulatorPayload(unwrapped.tokens) ||
      isExternalSimulatorLaunch(unwrapped.tokens) ||
      isSimulatorMutation(unwrapped.tokens) ||
      containsOpaqueSimulatorExecution(unwrapped.tokens)
    ) {
      return true;
    }
  }
  return false;
}

/** Undefined means the normal shell permission flow remains unchanged. */
export function getDesktopShellCommandPolicy(
  command: string,
): ShellCommandPolicyDenial | undefined {
  if (process.platform !== 'darwin') return undefined;
  // POSIX shells remove an unquoted backslash-newline before tokenization.
  // Mirror that expansion so the policy cannot be bypassed with continuations.
  const expandedCommand = command.replace(/\\\r?\n/g, '');
  if (containsSimulatorBypass(expandedCommand)) {
    return { decision: 'deny', reason: IOS_SIMULATOR_SHELL_DENIAL };
  }
  return undefined;
}

export const iosSimulatorShellDenialReason = IOS_SIMULATOR_SHELL_DENIAL;
