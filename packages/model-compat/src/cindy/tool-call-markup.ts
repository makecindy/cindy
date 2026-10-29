function isEscaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Conservative Markdown protection; an unfinished code span is kept verbatim too. */
function literalMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let fence: { char: string; length: number } | undefined;
  let quote = false;
  for (const match of text.matchAll(/[^\n]+(?:\n|$)|\n/g)) {
    const line = match[0];
    const at = match.index;
    if (fence) {
      const fenceChar = fence.char;
      mask.fill(1, at, at + line.length);
      const closing = /^ {0,3}([`~]+)[ \t]*\r?\n?$/.exec(line)?.[1];
      if (closing && closing.length >= fence.length
        && [...closing].every((char) => char === fenceChar)) fence = undefined;
      continue;
    }
    if (/^\s*$/.test(line)) quote = false;
    if (/^ {0,3}>/.test(line)) quote = true;
    // Markdown permits paragraph continuation without another '>' marker.
    if (quote) {
      mask.fill(1, at, at + line.length);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) {
      fence = { char: opening[0]!, length: opening.length };
      mask.fill(1, at, at + line.length);
    } else if (/^(?: {0,3}>| {4}| *\t)/.test(line)) {
      mask.fill(1, at, at + line.length);
    }
  }
  let inline: { at: number; length: number } | undefined;
  for (const match of text.matchAll(/`+/g)) {
    const at = match.index;
    if (mask[at] || (!inline && isEscaped(text, at))) continue;
    if (!inline) inline = { at, length: match[0].length };
    else if (inline.length === match[0].length) {
      mask.fill(1, inline.at, at + match[0].length);
      inline = undefined;
    }
  }
  if (inline) mask.fill(1, inline.at);
  return mask;
}


/** No execution is authorized by this parser. It only projects model output. */
export interface StructuredToolCall { name: string; input?: string; arguments?: unknown; aliases?: readonly string[] }
export interface ToolMarkupBlock { start: number; end: number; calls: StructuredToolCall[]; grammar: string }
const OPENERS = ['<tool_call>', '<｜DSML｜', '<｜｜DSML｜｜', '<invoke ', '<tool_calls>'];
const MAX_CONTEXT = 64 * 1024;
const MAX_TRAILING = 8 * 1024;
const MAX_CALLS = 128;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function json(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function parameters(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = Object.create(null);
  let rest = text;
  const pattern = /<(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?parameter\s+([^>]+)>([\s\S]*?)<\/(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?parameter>/g;
  for (const match of text.matchAll(pattern)) {
    const name = /\bname=["']([^"']+)["']/.exec(match[1]!)?.[1];
    if (!name || Object.hasOwn(result, name)) return undefined;
    const isString = /\bstring=["']true["']/.test(match[1]!);
    const raw = match[2]!;
    const parsed = json(raw);
    const value = isString ? raw : /\bstring=["']false["']/.test(match[1]!) ? parsed : (parsed ?? raw);
    if (value === undefined) return undefined;
    result[name] = value;
    rest = rest.replace(match[0], '');
  }
  return rest.trim() ? undefined : result;
}
function parseToolCall(text: string): StructuredToolCall[] | undefined {
  const freeform = /^\s*<function=([^<>\s]+)>([\s\S]*)$/.exec(text);
  if (freeform) {
    const rawBody = freeform[2]!.trim();
    const body = rawBody.includes('<parameter ')
      ? rawBody.replace(/<\/function>\s*$/, '').trim()
      : rawBody.replace(/(?:\s*<\/(?:function|parameter)>)+\s*$/, '').trim();
    if (body.includes('<parameter ')) {
      const args = parameters(body);
      return args ? [{ name: freeform[1]!, arguments: args }] : undefined;
    }
    return [{ name: freeform[1]!, input: body }];
  }
  const object = json(text.trim());
  if (record(object) && typeof object.name === 'string' && Object.hasOwn(object, 'arguments')) {
    const args = typeof object.arguments === 'string' ? json(object.arguments) : object.arguments;
    return args === undefined ? undefined : [{ name: object.name, arguments: args }];
  }
  const glm = /^\s*([^\s<>]+)\s*((?:<arg_key>[\s\S]*)?)$/.exec(text);
  if (!glm || !glm[2]) return undefined;
  const args: Record<string, unknown> = Object.create(null);
  let remaining = glm[2];
  const glmPattern = glm[2].includes('</arg_key>')
    ? /<arg_key>([^<>]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
    : /<arg_key>([^<>]+)<arg_value>([\s\S]*?)(?=<arg_key>|$)/g;
  for (const match of glm[2].matchAll(glmPattern)) {
    const key = match[1]!.trim();
    if (!key || Object.hasOwn(args, key)) return undefined;
    args[key] = match[2]!.trim();
    remaining = remaining.replace(match[0], '');
  }
  return remaining.trim() || !Object.keys(args).length ? undefined : [{ name: glm[1]!, arguments: args }];
}
function parseInvokes(raw: string): StructuredToolCall[] | undefined {
  const text = raw;
  const calls: StructuredToolCall[] = [];
  let remaining = text.replace(/^\s*<(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?(?:tool_calls|function_calls|calls)>/, '')
    .replace(/<\/(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?(?:tool_calls|function_calls|calls)>\s*$/, '');
  for (const match of text.matchAll(/<(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:｜DSML｜\s*|｜｜DSML｜｜\s*)?invoke>/g)) {
    const args = parameters(match[2]!);
    if (!args) return undefined;
    calls.push({ name: match[1]!, arguments: args });
    remaining = remaining.replace(match[0], '');
    if (calls.length > MAX_CALLS) return undefined;
  }
  return calls.length && !remaining.trim() ? calls : undefined;
}
const grammars = [
  { id: 'tool-call', pattern: /<tool_call>([\s\S]*?)<\/tool_call>/g, parse: (s: string) => parseToolCall(s.slice(11, -12)) },
  { id: 'deepseek', pattern: /<｜DSML｜(tool_calls|function_calls|invoke)\b[^>]*>[\s\S]*?<\/｜DSML｜\1>/g, parse: parseInvokes },
  { id: 'codebuddy', pattern: /<｜｜DSML｜｜\s*(calls|tool_calls|invoke)\b[^>]*>[\s\S]*?<\/｜｜DSML｜｜\s*\1>/g, parse: parseInvokes },
  { id: 'invoke', pattern: /<(tool_calls|invoke)\b[^>]*>[\s\S]*?<\/\1>/g, parse: parseInvokes },
];
export function scanToolCallMarkup(text: string): ToolMarkupBlock[] {
  if (text.length > 128 * 1024 || !OPENERS.some(s => text.includes(s))) return [];
  const mask = literalMask(text);
  const blocks: ToolMarkupBlock[] = [];
  for (const grammar of grammars) {
    const pattern = new RegExp(grammar.pattern.source, 'g');
    for (let match; (match = pattern.exec(text));) {
      if (mask[match.index] || isEscaped(text, match.index)) continue;
      const calls = grammar.parse(match[0]);
      if (!calls) pattern.lastIndex = match.index + 1;
      if (calls?.length) blocks.push({ start: match.index, end: match.index + match[0].length, calls, grammar: grammar.id });
      if (blocks.length >= MAX_CALLS) break;
    }
  }
  // Wrapper grammars own their nested invoke blocks; never reconcile a child twice.
  return blocks.sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((block, i, all) => !all.slice(0, i).some(other => other.start <= block.start && other.end >= block.end));
}
function canonical(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function matches(block: StructuredToolCall, actual: StructuredToolCall): boolean {
  if (block.name !== actual.name && !actual.aliases?.includes(block.name)) return false;
  if (block.input !== undefined) return actual.input !== undefined && block.input.trim() === actual.input.trim();
  const args = typeof actual.arguments === 'string' ? json(actual.arguments) : actual.arguments;
  try { return block.arguments !== undefined && args !== undefined && canonical(block.arguments) === canonical(args); }
  catch { return false; }
}
export function reconcileToolCallMarkup(text: string, calls: readonly StructuredToolCall[], suppressUnexecuted = false): { text: string; unexecuted: boolean } {
  const blocks = scanToolCallMarkup(text);
  let out = '', offset = 0, unexecuted = false;
  for (const block of blocks) {
    out += text.slice(offset, block.start);
    // One real invocation cannot prove two invocations inside the same batch.
    // Matching is local to the block: separate content/reasoning echoes may
    // still describe the same response-owned call. Augmenting paths also handle
    // overlapping authorized aliases without depending on their order.
    const owners = new Map<number, number>();
    const assign = (index: number, visited: Set<number>): boolean => {
      for (let actual = 0; actual < calls.length; actual++) {
        if (visited.has(actual) || !matches(block.calls[index], calls[actual])) continue;
        visited.add(actual);
        const owner = owners.get(actual);
        if (owner === undefined || assign(owner, visited)) { owners.set(actual, index); return true; }
      }
      return false;
    };
    let duplicate = true, shortfall = false;
    for (let index = 0; index < block.calls.length; index++) {
      if (!assign(index, new Set())) {
        duplicate = false;
        shortfall ||= calls.some(actual => matches(block.calls[index], actual));
      }
    }
    // A different real call is not proof this unmatched block was intended to run.
    const missing = calls.length === 0 || shortfall;
    unexecuted ||= missing;
    if (!duplicate && !(missing && suppressUnexecuted)) out += text.slice(block.start, block.end);
    offset = block.end;
  }
  return { text: out + text.slice(offset), unexecuted };
}
export function reconcileSerializedToolCalls(text: string, calls: readonly StructuredToolCall[]): string {
  return reconcileToolCallMarkup(text, calls).text;
}

/** Per-response, per-channel bounded hold; normal deltas are not delayed. */
export class SerializedToolCallEcho {
  private prefix = '';
  private held = '';
  private carry = '';
  private resolved = false;
  private holding = false;
  private closedAt = -1;
  private closeScan = 0;
  get isHolding(): boolean { return this.holding; }
  get hasPending(): boolean { return !!(this.held || this.carry); }
  push(text: string): string {
    if (this.resolved) return text;
    let pending = this.carry + text;
    this.carry = '';
    let visible = '';
    let rescans = 0;
    while (true) {
      if (!this.holding) {
        const starts = OPENERS.map(s => pending.indexOf(s)).filter(n => n >= 0);
        const at = starts.length ? Math.min(...starts) : -1;
        if (at >= 0) { visible += pending.slice(0, at); this.held = pending.slice(at); this.holding = true; }
        else {
          let keep = 0;
          for (const opener of OPENERS) for (let k = 1; k < opener.length; k++) {
            if (pending.endsWith(opener.slice(0, k))) keep = Math.max(keep, k);
          }
          visible += pending.slice(0, pending.length - keep);
          this.carry = pending.slice(pending.length - keep);
        }
      } else this.held += pending;
      if (this.held.startsWith('<tool_call>') && /^[A-Za-z0-9_.:-]+\s+[^<\s]/.test(this.held.slice(11).trimStart())) {
        // Only the explanatory opener is known to be prose. A later real block
        // (or split opener) must still enter the normal bounded hold.
        if (++rescans > MAX_CALLS) { this.prefix += visible; return visible + this.drain(); }
        visible += this.held.slice(0, 11);
        pending = this.held.slice(11);
        this.held = ''; this.holding = false; this.closedAt = -1; this.closeScan = 0;
        continue;
      }
      break;
    }
    this.prefix += visible;
    if (this.closedAt < 0) {
      const closing = /<\/(?:tool_call|invoke|tool_calls|(?:｜DSML｜|｜｜DSML｜｜)\s*(?:tool_calls|function_calls|calls|invoke))>/.exec(this.held.slice(this.closeScan));
      if (closing) this.closedAt = this.closeScan + closing.index + closing[0].length;
      this.closeScan = Math.max(0, this.held.length - 64);
    }
    if (this.prefix.length > MAX_CONTEXT || this.held.length > MAX_CONTEXT
      || (this.closedAt >= 0 && this.held.length - this.closedAt > MAX_TRAILING)) return visible + this.drain();
    return visible;
  }
  resolveReport(calls: readonly StructuredToolCall[], suppressUnexecuted = false): { text: string; unexecuted: boolean } {
    if (this.resolved) return { text: '', unexecuted: false };
    const prefix = this.prefix;
    const result = reconcileToolCallMarkup(prefix + this.held + this.carry, calls, suppressUnexecuted);
    this.drain();
    return { text: result.text.slice(prefix.length), unexecuted: result.unexecuted };
  }
  resolve(calls: readonly StructuredToolCall[]): string { return this.resolveReport(calls).text; }
  drain(): string {
    const text = this.held + this.carry;
    this.prefix = this.held = this.carry = '';
    this.holding = false; this.resolved = true;
    return text;
  }
}
export const UNEXECUTED_TOOL_MARKUP_REASON = 'unexecuted-tool-markup';
export const UNEXECUTED_TOOL_MARKUP_MESSAGE = '模型把工具调用写成了文本，无法确认执行结果，本轮未完成。';
