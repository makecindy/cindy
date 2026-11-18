/** Reference syntax only; callers retain their existing URL/path allowlists. */
export type MarkdownReferenceDefinitions = ReadonlyMap<string, string>;

export function normalizeMarkdownReference(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase().toUpperCase();
}

function bracket(input: string, start: number, nested = false): { text: string; end: number } | null {
  if (input[start] !== '[') return null;
  let depth = 0;
  for (let at = start + 1; at < input.length && at - start <= 1000; at++) {
    const char = input[at];
    if (char === '\\') { at++; continue; }
    if (char === '[') {
      if (!nested) return null;
      if (++depth > 32) return null;
    } else if (char === ']') {
      if (depth === 0) return { text: input.slice(start + 1, at), end: at + 1 };
      depth--;
    }
  }
  return null;
}

function unescapeDestination(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, (entity) => {
      const name = entity.slice(1, -1).toLowerCase();
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (!name.startsWith('#')) return named[name] ?? entity;
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '\ufffd';
    });
}

/** Root-level definitions, including a next-line destination and optional multiline title. */
export function readMarkdownReferenceDefinition(lines: readonly string[], start: number): {
  label: string; url: string; endLine: number;
} | null {
  const line = lines[start];
  const indent = /^ {0,3}(?=\[)/.exec(line)?.[0].length;
  if (indent === undefined) return null;
  const label = bracket(line, indent);
  if (!label || line[label.end] !== ':' || !label.text.trim()) return null;
  let endLine = start;
  let rest = line.slice(label.end + 1).trimStart();
  if (!rest && lines[start + 1]?.trim()) {
    rest = lines[++endLine].trimStart();
  }
  if (!rest) return null;
  let at = 0;
  let destination = '';
  if (rest[0] === '<') {
    at = 1;
    for (; at < rest.length; at++) {
      if (rest[at] === '\\') { at++; continue; }
      if (rest[at] === '<') return null;
      if (rest[at] === '>') break;
    }
    if (rest[at] !== '>') return null;
    destination = rest.slice(1, at++);
  } else {
    let depth = 0;
    for (; at < rest.length && !/\s/.test(rest[at]); at++) {
      if (rest[at] === '\\') { at++; continue; }
      if (rest[at] === '(') depth++;
      if (rest[at] === ')' && --depth < 0) return null;
      if (depth > 32) return null;
    }
    if (!at || depth !== 0) return null;
    destination = rest.slice(0, at);
  }
  // A title requires whitespace after the destination. Its text is not needed
  // by the native inline renderer, but consume it so it never leaks into chat.
  if (at < rest.length && !/\s/.test(rest[at])) return null;
  let title = rest.slice(at).trimStart();
  const destinationEnd = endLine;
  let titleOnNextLine = false;
  if (!title && /^\s*["'(]/.test(lines[endLine + 1] ?? '')) {
    title = lines[++endLine].trimStart();
    titleOnNextLine = true;
  }
  if (title) {
    const close = title[0] === '(' ? ')' : title[0];
    if (!['"', "'", '('].includes(title[0])) return null;
    let closed = false;
    for (let index = 1; index <= 10_000; index++) {
      if (index >= title.length) {
        if (!lines[endLine + 1]?.trim()) break;
        title += '\n' + lines[++endLine];
      }
      if (title[index] === '\\') { index++; continue; }
      if (title[index] === close) {
        closed = !title.slice(index + 1).trim();
        break;
      }
    }
    if (!closed) {
      if (!titleOnNextLine) return null;
      endLine = destinationEnd;
    }
  }
  return { label: normalizeMarkdownReference(label.text), url: unescapeDestination(destination), endLine };
}

export function nextMarkdownReference(
  input: string, from: number, definitions: MarkdownReferenceDefinitions,
  exec: (regex: RegExp) => RegExpExecArray | null,
): {
  index: number; end: number; image: boolean; text: string; url: string;
} | null {
  if (!definitions.size) return null;
  const opening = /!?\[/g;
  opening.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = exec(opening))) {
    const image = match[0][0] === '!';
    const label = bracket(input, match.index + (image ? 1 : 0), true);
    if (!label || input[label.end] === '(' || !label.text.trim()) continue;
    const explicit = input[label.end] === '[' ? bracket(input, label.end) : null;
    const name = explicit?.text || label.text;
    const url = definitions.get(normalizeMarkdownReference(name));
    if (url === undefined) continue;
    return { index: match.index, end: explicit?.end ?? label.end, image, text: label.text, url };
  }
  return null;
}
