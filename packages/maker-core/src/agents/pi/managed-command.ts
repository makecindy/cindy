/** Pi 0.84.4/0.85.1 CLI management grammar. No shell evaluation or slash dispatch. */
export type PiNativeManagementCommand =
  | { kind: 'self'; force: boolean }
  | { kind: 'all'; force: boolean }
  | { kind: 'extensions' }
  | { kind: 'models' }
  | { kind: 'list' }
  | { kind: 'version' }
  | { kind: 'help'; topic?: 'install' | 'remove' | 'update' | 'list' | 'config' };

export type PiManagementCommand =
  | { action: 'install' | 'update' | 'remove'; source: string }
  | { action: 'command'; command: PiNativeManagementCommand };
export type PiManagementParseResult = PiManagementCommand | { error: string };

export function parsePiManagementArgs(args: readonly string[]): PiManagementParseResult {
  const bad = (error: string): PiManagementParseResult => ({ error });
  if (args.length > 32) return bad('Too many Pi command arguments.');
  if (args.some(arg => !arg || arg.length > 4096 || /[\r\n\0]/.test(arg))) return bad('Invalid Pi command argument.');
  let [verb, ...rest] = args;
  if (verb === 'uninstall') verb = 'remove';
  if ((verb === '--version' || verb === '-v') && !rest.length) return { action: 'command', command: { kind: 'version' } };
  if ((verb === '--help' || verb === '-h') && !rest.length) return { action: 'command', command: { kind: 'help' } };
  if (verb !== 'install' && verb !== 'remove' && verb !== 'update' && verb !== 'list' && verb !== 'config') return bad('Unsupported Pi management command. Use pi --help.');
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0])) return { action: 'command', command: { kind: 'help', topic: verb } };
  if (rest.some(arg => ['-l', '--local', '-a', '--approve'].includes(arg))) return bad('Project-local Pi management is not supported by this entry. Existing project trust is unchanged.');
  rest = rest.filter(arg => !['--no-approve', '-na'].includes(arg));
  if (verb === 'config') return bad('pi config requires an interactive terminal. Use Cindy Settings → Pi packages to manage installed resources.');
  if (verb === 'list') return rest.length ? bad('pi list does not accept these arguments.') : { action: 'command', command: { kind: 'list' } };
  if (verb === 'install' || verb === 'remove') return rest.length === 1 && !rest[0].startsWith('-')
    ? { action: verb, source: rest[0] } : bad('Pi install/remove requires exactly one package source.');
  const force = rest.includes('--force');
  rest = rest.filter(arg => arg !== '--force');
  if (!rest.length || (rest.length === 1 && ['--self', 'self', 'pi'].includes(rest[0]))) return { action: 'command', command: { kind: 'self', force } };
  if (rest.length === 1 && rest[0] === '--all') return { action: 'command', command: { kind: 'all', force } };
  if (rest.length === 2 && rest.includes('--extensions') && rest.some(arg => ['--self', 'self', 'pi'].includes(arg))) return { action: 'command', command: { kind: 'all', force } };
  if (force) return bad('--force is supported only for Pi core updates.');
  if (rest.length === 1 && rest[0] === '--extensions') return { action: 'command', command: { kind: 'extensions' } };
  if (rest.length === 1 && rest[0] === '--models') return bad('pi update --models is not yet supported for Cindy-managed provider catalogs. Use the existing provider model refresh entry.');
  if (rest.length === 2 && rest[0] === '--extension' && !rest[1].startsWith('-')) return { action: 'update', source: rest[1] };
  if (rest.length === 1 && !rest[0].startsWith('-')) return { action: 'update', source: rest[0] };
  return bad('Unknown or conflicting Pi update arguments. Use pi update --help.');
}

/** Accept one complete command, with quoted literal arguments; never execute shell syntax. */
export function parsePiManagementText(text: string): PiManagementParseResult | undefined {
  const match = /^\/?pi(?:\s+|$)(.*)$/s.exec(text.trim());
  if (!match) return undefined;
  if (/[\r\n\0]/.test(text.trim())) return { error: 'Pi management requires a single command.' };
  const words: string[] = [];
  const input = match[1];
  let word = '', quote = '', started = false;
  for (const ch of input) {
    if (/[\r\n\0]/.test(ch)) return { error: 'Pi management requires a single command.' };
    if (quote === '"' && /[$`]/.test(ch)) return { error: 'Shell expansion is not supported in Pi management commands.' };
    if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) words.push(word); word = ''; started = false; }
    else if (/[;&|<>`$]/.test(ch)) return { error: 'Shell expressions are not supported in Pi management commands.' };
    else { word += ch; started = true; }
  }
  if (quote) return { error: 'Unclosed quote in Pi command.' };
  if (started) words.push(word);
  return parsePiManagementArgs(words);
}
