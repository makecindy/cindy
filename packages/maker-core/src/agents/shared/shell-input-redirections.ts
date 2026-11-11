export type ParsedShellInputRedirections = {
  command: string;
  targets: string[];
  targetPrefixes: string[];
  targetMayExpand: boolean[];
  hasUnresolvedTarget: boolean;
};

export function readShellRedirectionTarget(
  command: string,
  start: number,
): { target: string; end: number; unresolved: boolean; mayExpand: boolean } {
  let target = '';
  let quote: "'" | '"' | null = null;
  let unresolved = false;
  let mayExpand = false;
  let cursor = start;
  while (cursor < command.length) {
    const char = command[cursor];
    if (quote) {
      if (char === quote) {
        quote = null;
        cursor += 1;
        continue;
      }
      if (char === '\\' && quote === '"' && cursor + 1 < command.length) {
        const escaped = command[cursor + 1];
        if (escaped !== '\n') {
          if (escaped === '$' || escaped.charCodeAt(0) === 96 || escaped === '"' || escaped === '\\') {
            target += escaped;
          } else {
            target += '\\' + escaped;
          }
        }
        cursor += 2;
        continue;
      }
      if (quote === '"' && (char === '$' || char.charCodeAt(0) === 96)) unresolved = true;
      target += char;
      cursor += 1;
      continue;
    }
    if (char === '$' || char.charCodeAt(0) === 96) unresolved = true;
    if (char === '*' || char === '?' || char === '[' || char === '{'
      || (char === '~' && target.length === 0)) mayExpand = true;
    if (char === "'" || char === '"') {
      quote = char;
      cursor += 1;
      continue;
    }
    if (char === '\\' && cursor + 1 < command.length) {
      if (command[cursor + 1] !== '\n') target += command[cursor + 1];
      cursor += 2;
      continue;
    }
    if (/\s/.test(char) || /[;&|()<>]/.test(char)) break;
    target += char;
    cursor += 1;
  }
  return { target, end: cursor, unresolved, mayExpand };
}

export function parseShellInputRedirections(
  command: string,
  stripReadWriteTargets = false,
): ParsedShellInputRedirections {
  const targets: string[] = [];
  const targetPrefixes: string[] = [];
  const targetMayExpand: boolean[] = [];
  let stripped = '';
  let quote: "'" | '"' | null = null;
  let hasUnresolvedTarget = false;

  for (let index = 0; index < command.length;) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        if (command[index + 1] !== '\n') stripped += char + command[index + 1];
        index += 2;
        continue;
      }
      stripped += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '\\' && index + 1 < command.length) {
      if (command[index + 1] !== '\n') stripped += char + command[index + 1];
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      stripped += char;
      index += 1;
      continue;
    }
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(command[index - 1] ?? ''))) {
      const newline = command.indexOf('\n', index);
      if (newline < 0) break;
      stripped += '\n';
      index = newline + 1;
      continue;
    }
    if (char !== '<') {
      stripped += char;
      index += 1;
      continue;
    }

    const next = command[index + 1];
    if (next === '<') {
      let end = index + 2;
      while (command[end] === '<') end += 1;
      stripped += command.slice(index, end);
      index = end;
      continue;
    }
    if (next === '>') {
      let cursor = index + 2;
      while (/\s/.test(command[cursor] ?? '')) cursor += 1;
      const parsedTarget = readShellRedirectionTarget(command, cursor);
      if (!parsedTarget.target || parsedTarget.unresolved) {
        hasUnresolvedTarget = true;
      } else {
        targets.push(parsedTarget.target);
        targetPrefixes.push(stripped);
        targetMayExpand.push(parsedTarget.mayExpand);
      }
      if (stripReadWriteTargets && parsedTarget.target && !parsedTarget.unresolved) {
        stripped = stripped.replace(/(^|[\s;&|(){}])\d+$/, '$1') + ' ';
      } else {
        stripped += command.slice(index, parsedTarget.end);
      }
      index = parsedTarget.end;
      continue;
    }
    if (next === '&' || next === '(') {
      stripped += char + next;
      index += 2;
      continue;
    }

    let cursor = index + 1;
    while (/\s/.test(command[cursor] ?? '')) cursor += 1;
    const parsedTarget = readShellRedirectionTarget(command, cursor);
    if (!parsedTarget.target || parsedTarget.unresolved) {
      hasUnresolvedTarget = true;
      stripped += command.slice(index, parsedTarget.end);
    } else {
      targets.push(parsedTarget.target);
      targetPrefixes.push(stripped);
      targetMayExpand.push(parsedTarget.mayExpand);
      stripped += ' ';
    }
    index = parsedTarget.end;
  }

  return { command: stripped, targets, targetPrefixes, targetMayExpand, hasUnresolvedTarget };
}

export function shellInputRedirectionParserSource(): string {
  const helperName = readShellRedirectionTarget.name;
  const parserName = parseShellInputRedirections.name;
  if (!helperName || !parserName) throw new Error('Shell input redirection parser names are unavailable');
  const aliases = [
    helperName === 'readShellRedirectionTarget'
      ? ''
      : `const readShellRedirectionTarget = ${helperName};`,
    parserName === 'parseShellInputRedirections'
      ? ''
      : `const parseShellInputRedirections = ${parserName};`,
  ].filter(Boolean);
  return [
    readShellRedirectionTarget.toString(),
    parseShellInputRedirections.toString(),
    ...aliases,
  ].join('\n');
}
