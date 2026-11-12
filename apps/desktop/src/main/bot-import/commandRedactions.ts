import { headerCredentialValues, importedContentRedactions, isImportedCredentialField } from './connectionCatalog.js';

/** Shared by readable import copies and execution output; originals stay intact. */
export function commandLiteralRedactions(literals: string[], environmentValues: string[] = [], maskLiterals = true): Record<string, string> {
  const candidates = literals.flatMap(value => [value, /^--?[\w-]+=(.+)$/s.exec(value)?.[1]])
    .filter((value): value is string => !!value);
  const literalSet = new Set(candidates);
  const values = maskLiterals ? [...candidates] : [];
  const structured: { id: string; format: string; value: unknown }[] = [];
  for (const value of new Set([...candidates, ...environmentValues])) {
    // curl accepts a separate -H/--header value, --header=value or -Hvalue.
    // Share credential-header and cookie parsing with MCP: commands may echo
    // just one private value. Public header values/scheme names are not masks.
    const header = /^(?:-H)?[\t ]*([\w-]+)[\t ]*:[\t ]*(.+?)[\t ]*$/i.exec(value);
    if (header) values.push(...headerCredentialValues(header[1]!, header[2]!));
    // Form bodies can echo one field independently of the original scalar.
    // Keep both wire and decoded values, including repeated/encoded field names;
    // ordinary form settings are not credentials. Do not interpret URLs or JSON
    // as form bodies (they have their own traversal below).
    if (/^[\w.%+-]+=/.test(value)) for (const match of value.matchAll(/(?:^|&)([^=&]+)=([^&]*)/g)) {
      const pair = `${match[1]}=${match[2]}`;
      const [field] = new URLSearchParams(pair);
      if (field && /^[\w.-]+$/.test(field[0]) && isImportedCredentialField(field[0]) && field[1]) {
        values.push(match[2]!, field[1]);
      }
    }
    // command-env applies both the credential-field rules and URL component
    // traversal, including URLs beneath ordinary structured keys like endpoint.
    structured.push({ id: `command_${structured.length}`, format: 'command-env', value });
    try {
      const parsed: unknown = JSON.parse(value);
      if (maskLiterals && typeof parsed === 'string' && literalSet.has(value)) values.push(parsed);
      if ((parsed && typeof parsed === 'object') || typeof parsed === 'string') {
        structured.push({ id: `command_${structured.length}`, format: 'command-env', value: parsed });
      }
    } catch { /* Requested exact literal masks need no JSON parser. */ }
  }
  values.push(...Object.values(importedContentRedactions({ env: {}, mcp: [], credentials: structured })));
  const secrets: Record<string, string> = {};
  for (const [index, value] of [...new Set(values)].entries()) {
    secrets[`command_literal_${index}`] = value;
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) secrets[`command_literal_${index}_json`] = escaped;
  }
  return secrets;
}

/** curl -u/-U and long forms carry a password after the first colon. */
export function curlUserinfoPasswords(argv: string[]): string[] {
  if (!/^(?:.*[/\\])?curl(?:\.exe)?$/i.test(argv[0] ?? '')) return [];
  const passwords: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') break;
    const userinfo = ['-u', '-U', '--user', '--proxy-user'].includes(arg) ? argv[++index]
      : /^--(?:proxy-)?user=([\s\S]*)$/.exec(arg)?.[1] ?? /^-[uU]([\s\S]+)$/.exec(arg)?.[1];
    const colon = userinfo?.indexOf(':') ?? -1;
    if (userinfo && colon >= 0 && colon < userinfo.length - 1) passwords.push(userinfo.slice(colon + 1));
  }
  return passwords;
}

/** Public copies retain ordinary CLI syntax/settings, not a blanket argv mask. */
export function commandArgumentRedactions(argv: string[]): Record<string, string> {
  const values = Object.values(commandLiteralRedactions(curlUserinfoPasswords(argv)));
  let credentialArgument = false;
  for (const arg of argv.slice(1)) {
    const option = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    const privateValue = option ? isImportedCredentialField(option[1]) && option[2] !== undefined : credentialArgument;
    values.push(...Object.values(commandLiteralRedactions([arg], [], privateValue)));
    credentialArgument = !!option && option[2] === undefined && isImportedCredentialField(option[1]);
  }
  return Object.fromEntries([...new Set(values)].map((value, index) => [`command_argument_${index}`, value]));
}
