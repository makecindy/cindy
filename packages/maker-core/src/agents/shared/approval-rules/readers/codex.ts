import { literalCommandArgv } from '../evaluate.js';
import { normalizeRuleGroup } from '../normalize.js';
import type { RuleClause, RuleDecision } from '../types.js';
import { qualifyNativeSource, type NativeReadResult, type NativeSourceRegistration } from './registration.js';

/** Literal-only subset of Codex exec policy. Never evaluate source expressions. */
class LiteralCall {
  private cursor = 0;
  constructor(private readonly source: string) {}
  private space(): void { while (/\s/.test(this.source[this.cursor] ?? '') && this.cursor < this.source.length) this.cursor++; }
  private take(symbol: string): void {
    this.space();
    if (!this.source.startsWith(symbol, this.cursor)) throw new Error('Unknown policy syntax');
    this.cursor += symbol.length;
  }
  private peek(symbol: string): boolean { this.space(); return this.source.startsWith(symbol, this.cursor); }
  private identifier(): string {
    this.space();
    const name = /^[a-z_]+/.exec(this.source.slice(this.cursor))?.[0];
    if (!name) throw new Error('Unknown policy keyword');
    this.cursor += name.length;
    return name;
  }
  private literal(): unknown {
    this.space();
    const quote = this.source[this.cursor];
    if (quote === '"' || quote === "'") {
      this.cursor++;
      let value = '';
      while (this.cursor < this.source.length) {
        const character = this.source[this.cursor++]!;
        if (character === quote) return value;
        if (character !== '\\') { value += character; continue; }
        const escaped = this.source[this.cursor++]!;
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
        if (!Object.hasOwn(escapes, escaped)) throw new Error('Unknown string escape');
        value += escapes[escaped];
      }
      throw new Error('Unclosed literal');
    }
    if (quote === '[') {
      this.take('[');
      const values: unknown[] = [];
      while (!this.peek(']')) {
        values.push(this.literal());
        if (!this.peek(']')) this.take(',');
      }
      this.take(']');
      return values;
    }
    throw new Error('Nonliteral policy expression');
  }
  parse(): Record<string, unknown> {
    this.take('prefix_rule');
    this.take('(');
    const args: Record<string, unknown> = Object.create(null);
    while (!this.peek(')')) {
      const key = this.identifier();
      if (Object.hasOwn(args, key)) throw new Error('Duplicate policy keyword');
      this.take('=');
      args[key] = this.literal();
      if (!this.peek(')')) this.take(',');
    }
    this.take(')');
    this.space();
    if (this.cursor !== this.source.length) throw new Error('Trailing policy expression');
    return args;
  }
}

function withoutComment(line: string): string {
  let quote = '', escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (char === quote) { quote = ''; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    if (!quote && char === '#') return line.slice(0, index);
  }
  return line;
}
function statementDepth(line: string): number {
  let quote = '', escaped = false, depth = 0;
  for (const char of line) {
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (char === quote) { quote = ''; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    if (!quote && char === '(') depth++;
    if (!quote && char === ')') depth--;
  }
  return depth;
}
function statements(source: string): string[] {
  const records: string[] = [];
  let current = '', depth = 0;
  for (const line of source.split(/\r?\n/)) {
    const code = withoutComment(line);
    if (!code.trim() && !current) continue;
    current += (current ? '\n' : '') + code;
    depth += statementDepth(code);
    if (depth <= 0) {
      if (current.trim()) records.push(current.trim());
      current = '';
      depth = 0;
    }
  }
  if (current.trim()) records.push(current.trim());
  return records;
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function parseClause(original: string, index: number): RuleClause {
  const residual = (reason: string): RuleClause => ({ id: 'clause:' + index, original,
    decision: 'ask', reason });
  try {
    const args = new LiteralCall(original).parse();
    if (Object.keys(args).some(key => !['pattern', 'decision', 'justification', 'match', 'not_match'].includes(key)))
      return residual('Unknown policy keyword');
    const tokens = args.pattern;
    if (!Array.isArray(tokens) || !tokens.length || typeof tokens[0] !== 'string'
      || tokens.some(token => !(typeof token === 'string' && token.length > 0)
        && !(Array.isArray(token) && token.length > 0 && token.every(item => typeof item === 'string' && item.length > 0))))
      return residual('Invalid literal prefix');
    const decisions: Record<string, RuleDecision> = { allow: 'allow', prompt: 'ask', forbidden: 'deny' };
    if (typeof args.decision !== 'string' || !Object.hasOwn(decisions, args.decision))
      return residual('Unknown decision');
    if (args.justification !== undefined && typeof args.justification !== 'string')
      return residual('Unknown justification');
    if ((args.match !== undefined && !stringList(args.match))
      || (args.not_match !== undefined && !stringList(args.not_match)))
      return residual('Unknown policy examples');
    // Native examples are part of the source contract. A contradicted example
    // prevents a misleading program matcher until a wider adapter exists.
    for (const example of (args.match ?? []) as string[]) {
      const argv = literalCommandArgv(example);
      if (!argv || !tokens.every((token, position) =>
        typeof token === 'string' ? token === argv[position] : token.includes(argv[position]!)))
        return residual('Native match example contradicts prefix');
    }
    for (const example of (args.not_match ?? []) as string[]) {
      const argv = literalCommandArgv(example);
      if (argv && tokens.every((token, position) =>
        typeof token === 'string' ? token === argv[position] : token.includes(argv[position]!)))
        return residual('Native not_match example contradicts prefix');
    }
    return { id: 'clause:' + index, original, decision: decisions[args.decision]!,
      matcher: { kind: 'argv-prefix', tokens: tokens as Array<string | string[]> },
      ...(args.justification !== undefined ? { justification: args.justification as string } : {}),
      ...(args.match !== undefined || args.not_match !== undefined ? { examples: {
        match: (args.match ?? []) as string[], notMatch: (args.not_match ?? []) as string[],
      } } : {}),
    };
  } catch { return residual('Unknown or nonliteral native policy syntax'); }
}

/** Parse content only. This never proves registration, native acceptance or
 * aggregate policy loading; unknown syntax stays verbatim residual. */
export function parseCodexUserRuleContent(source: unknown):
  { kind: 'parsed'; clauses: RuleClause[] } | { kind: 'unavailable'; reason: 'source-invalid' } {
  if (typeof source !== 'string' || source.length > 1_000_000)
    return { kind: 'unavailable', reason: 'source-invalid' };
  return { kind: 'parsed', clauses: statements(source).map(parseClause) };
}

export function readCodexPersonalRules(
  source: unknown, registration?: NativeSourceRegistration,
): NativeReadResult {
  const qualified = qualifyNativeSource(registration, 'codex');
  if (qualified.kind !== 'qualified') return qualified;
  const result = parseCodexUserRuleContent(source);
  if (result.kind !== 'parsed') return result;
  return { kind: 'available', group: normalizeRuleGroup(qualified.origin, qualified.scope, result.clauses) };
}
