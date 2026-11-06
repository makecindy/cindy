/**
 * Shell commands that synthesize desktop keyboard / mouse input outside the
 * Cindy Computer Use driver.
 *
 * Why this exists: when the driver refuses an input (Electron text fields,
 * simulator windows, a focused system sheet), models have fallen back to
 * `osascript … keystroke`, clipboard paste via ⌘V, `cliclick`, or hand-written
 * CGEvent scripts. Those bypass every guard in `cindy_computer` (target window,
 * secure fields, remote-input yield, user-activity yield) and in practice typed
 * into the wrong window (2026-10-31 audit, CU-014). The one desktop input entry
 * is `cindy_computer`; a refusal there is a result to report, not to work around.
 *
 * Only input synthesis is listed. Read-only desktop queries (`screencapture`,
 * `osascript … get name of …`, `lsappinfo`) stay untouched.
 */

const SHELL_DESKTOP_INPUT_PATTERNS: readonly RegExp[] = [
  // AppleScript / JXA keyboard and mouse synthesis. Only System Events (or the
  // osascript wrapper) combined with an input verb; reading window titles via
  // System Events is not input.
  // Mutating verbs only: keyboard / pointer events and writes through the accessibility
  // tree (`set value of`, `perform action`, `set selected`, `increment`, `decrement`).
  // `get value of …` and process / window queries stay readable.
  /\b(?:System Events|com\.apple\.systemevents)\b[\s\S]*?\b(?:keystroke|key code|key down|key up|click|set\s+(?:the\s+)?value|perform\s+action|set\s+selected|increment|decrement)\b/i,
  /\bosascript\b[\s\S]*?\b(?:keystroke|key code|key down|key up)\b/i,
  // macOS third-party click / key CLIs.
  // Optionally path-qualified (/opt/homebrew/bin/cliclick); the name must end the
  // token so a file such as docs/cliclick-notes.md is not a command.
  /(?:^|[\s|&;(`$'"=])(?:\S*\/)?cliclick(?=[\s'"]|$)/i,
  // CoreGraphics event synthesis from inline Swift / Python / JXA.
  /\bCGEventPost\b|\bCGEventCreate(?:Mouse|Keyboard|ScrollWheel)Event\b|\bCGEvent\s*\(\s*(?:mouseEventSource|keyboardEventSource|scrollWheelEvent2Source)/i,
  // Linux / Windows equivalents.
  /(?:^|[\s|&;(`$'"=])(?:\S*\/)?(?:xdotool|ydotool|xte)\s+(?:key|type|click|mousemove|mousedown|mouseup)\b/i,
  /\bSendKeys\b|\bSendInput\b|\bmouse_event\b|\bkeybd_event\b/i,
  // Library and executable entry points, one inventory so the list is complete by
  // construction rather than by review rounds: Python (pyautogui, pynput,
  // pydirectinput), Node (robotjs, nut-js), Wayland / X11 (wtype, dotool, xvkbd),
  // Windows (AutoHotkey, nircmd).
  /\b(?:pyautogui|pynput|pydirectinput|robotjs|nut-js|autohotkey)\b|@nut-tree\b/i,
  /(?:^|[\s|&;(`$'"=])(?:\S*\/)?(?:wtype|dotoolc?|xvkbd|nircmdc?)(?:\.exe)?(?=[\s'"]|$)/i,
  // The driver binary itself: same engine, but the native CLI / MCP skips the
  // Cindy session, guards and result verification.
  /(?:^|[\s|&;(`$/'"=])cua-driver\s+(?!--version\b|version\b|status\b|health\b)[a-z]/i,
];

const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "ag",
  "ack",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "wc",
  // Pure readers and formatters: their arguments are patterns or file names.
  "nl",
  "cut",
  "sort",
  "uniq",
  "diff",
  "jq",
  "ls",
  "stat",
  "file",
  "xxd",
  "od",
  "strings",
]);
/** Package managers only fetch or list code; installing `pyautogui` synthesizes nothing. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "pip",
  "pip3",
  "pipx",
  "uv",
  "brew",
  "npm",
  "pnpm",
  "yarn",
]);
const EXECUTING_FLAGS =
  /^--(?:pre|pre-glob|hostname-bin|pager|ext-diff|textconv|compress-program|exec-path|exec|upload-pack|receive-pack)(?:=|$)/;
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "grep",
  "log",
  "show",
  "diff",
  "blame",
  "commit",
  "tag",
]);
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "command",
  "env",
  "time",
  "nohup",
  "nice",
  "exec",
]);

/**
 * A top-level pipeline segment whose command only reads or searches text, so the
 * names inside its arguments (`rg CGEventPost src`, `git commit -m "… SendKeys"`)
 * are data, not input being synthesized. `cat` counts only without a redirect or
 * heredoc: `cat > click.swift <<EOF` writes the script that would be run next.
 */
function isReadOnlySegment(segment: string): boolean {
  const tokens = segment
    .trim()
    .replace(/^[({\s]+/, "")
    .split(/\s+/);
  let index = 0;
  let hasEnvAssignment = false;
  while (
    index < tokens.length &&
    (/^\w+=\S*$/.test(tokens[index]!) || COMMAND_WRAPPERS.has(tokens[index]!))
  ) {
    // LESSOPEN, PAGER, GIT_EXTERNAL_DIFF … run programs: a prefixed assignment is never read-only.
    if (/^\w+=/.test(tokens[index]!)) hasEnvAssignment = true;
    index += 1;
  }
  if (hasEnvAssignment) return false;
  const head = (tokens[index] ?? "").split("/").pop() ?? "";
  // A read-only head that is told to run another program (`rg --pre cliclick`, `git -c
  // core.pager=…`, `sort --compress-program=…`) executes that program.
  if (
    tokens
      .slice(index + 1)
      .some(
        (token) =>
          EXECUTING_FLAGS.test(token) ||
          (head === "git" && /^-c(?:$|\S)/.test(token) && token !== "-C"),
      )
  )
    return false;
  if (READ_ONLY_HEADS.has(head)) return true;
  if (head === "cat") return !/>|<</.test(segment);
  // sed is read-only only in one strict shape: `-n`, no `-i` / `-e` / `-f` / `-s` /
  // `--sandbox` surprises, and a script made of nothing but print-style commands
  // (`p P d D q Q n N =`) with line numbers, ranges and /regex/ addresses. Anything
  // else (`1e cmd`, `w file`, `r file`, `s///e`, `y`, `a` `i` `c`) is not read-only,
  // so GNU sed's command-executing forms never need to be recognised one by one.
  if (head === "sed") return isPrintOnlySed(shellWords(segment).slice(1));
  if (PACKAGE_MANAGERS.has(head)) {
    const sub =
      tokens.slice(index + 1).find((token) => !token.startsWith("-")) ?? "";
    return /^(?:install|add|i|info|show|view|search|list|ls|uninstall|remove|outdated)$/.test(
      sub,
    );
  }
  if (head === "git") {
    const sub =
      tokens
        .slice(index + 1)
        .find((token) => !token.startsWith("-") && !token.includes("/")) ?? "";
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

/**
 * Split a shell command at top-level `&&`, `||`, `;`, `|`, `&` and newlines: separators
 * inside single or double quotes, backslash escapes, `$(…)`, parentheses and
 * backticks belong to one argument (`rg 'foo|CGEventPost' .` is one segment). A
 * newline is a separator too, so `rg x⏎osascript …` cannot hide its second command
 * behind a read-only head. Unbalanced quoting keeps the rest as a single segment.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let backtick = false;
  const flush = () => {
    if (current.trim().length > 0) segments.push(current);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    const next = command[index + 1];
    if (ch === "\\" && quote !== "'") {
      current += ch + (next ?? "");
      index += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      // $(…) still runs inside double quotes; track it so its own separators stay inside.
      else if (quote === '"' && ch === "$" && next === "(") {
        depth += 1;
        current += "$(";
        index += 1;
        continue;
      } else if (quote === '"' && ch === ")" && depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`") {
      backtick = !backtick;
      current += ch;
      continue;
    }
    if (ch === "(" || (ch === "$" && next === "(")) {
      depth += 1;
      current += ch === "$" ? "$(" : "(";
      if (ch === "$") index += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      current += ch;
      continue;
    }
    if (
      depth === 0 &&
      !backtick &&
      (ch === ";" || ch === "|" || ch === "&" || ch === "\n")
    ) {
      // `||` and `&&` are one separator; a lone `|` / `&` is another.
      if ((ch === "|" || ch === "&") && next === ch) index += 1;
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return segments;
}

/** Quote-aware words of one segment (quotes removed); enough to read a sed invocation. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const ch = segment[index]!;
    if (ch === "\\" && quote !== "'") {
      current += segment[index + 1] ?? "";
      index += 1;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/** `sed -n '<print-only script>' file…` — see the note at the sed branch. */
function isPrintOnlySed(args: string[]): boolean {
  const options = args.filter(
    (word) => word.startsWith("-") && word.length > 1,
  );
  // Only short, letter-only option clusters containing n; -e / -f / -i / -s / -z etc. and
  // every long option (--expression, --in-place, --sandbox, --file …) disqualify.
  if (
    options.length === 0 ||
    !options.every(
      (word) =>
        (/^-[nEr]+$/.test(word) && /n/.test(word)) ||
        word === "-E" ||
        word === "-r",
    )
  )
    return false;
  const operands = args.filter(
    (word) => !(word.startsWith("-") && word.length > 1),
  );
  const script = operands[0];
  if (script === undefined) return false;
  const withoutRegex = script.replace(/\/(?:\\.|[^/\\])*\//g, "");
  return /^[\s0-9,;$!{}pPdDqQnN=~+\-^]*$/.test(withoutRegex);
}

const SUBSTITUTION_RE =
  /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`|[<>]\(([^()]*)\)/g;

/** Bodies of `$(…)`, backtick and process substitutions in a segment (one nesting level). */
function substitutionBodies(segment: string): string[] {
  const bodies: string[] = [];
  for (const match of segment.matchAll(SUBSTITUTION_RE)) {
    bodies.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  // An unbalanced `$(` that the pattern could not extract: keep the segment rather than trust it.
  if (bodies.length === 0 && /\$\(|`|[<>]\(/.test(segment))
    bodies.push(segment);
  return bodies;
}

/** True when a shell command synthesizes desktop keyboard or mouse input. */
export function isShellDesktopInputCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  // Shell semantics: an unquoted backslash-newline is deleted before parsing, so
  // `xdotool \⏎click 1` is `xdotool click 1`.
  command = command.replace(/\\\r?\n/g, "");
  // Drop read-only segments, then scan what remains as one text: AppleScript and
  // JXA payloads span `;` and `|` inside their quotes, so remaining segments are
  // rejoined rather than judged one by one.
  // A read-only segment still runs the command substitutions in its arguments
  // (`rg "$(osascript -e '… keystroke …')" .`), so those bodies are scanned too.
  const executedParts: string[] = [];
  for (const segment of splitShellSegments(command)) {
    if (!isReadOnlySegment(segment)) executedParts.push(segment);
    else executedParts.push(...substitutionBodies(segment));
  }
  const executed = executedParts.join(" ; ");
  return SHELL_DESKTOP_INPUT_PATTERNS.some((pattern) => pattern.test(executed));
}

export const SHELL_DESKTOP_INPUT_DENIAL_CODE =
  "SHELL_DESKTOP_INPUT_NOT_ALLOWED";

/** Model-facing refusal; English like the other guard reasons. */
export const SHELL_DESKTOP_INPUT_DENIAL_REASON =
  `${SHELL_DESKTOP_INPUT_DENIAL_CODE}: desktop keyboard and mouse input goes only through the ` +
  "cindy_computer tools (set_value, type_text, click, press_key, hotkey). Shell-synthesized " +
  "input (osascript System Events keystroke/click, clipboard paste via keystroke, cliclick, " +
  "CGEvent scripts, the cua-driver CLI) is not an alternative: it ignores the target window, " +
  "secure fields and the person using this computer. If cindy_computer refused or could not " +
  "deliver the input, report that result and stop instead of simulating keys.";
