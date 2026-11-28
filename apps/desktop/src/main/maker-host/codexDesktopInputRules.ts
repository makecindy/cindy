import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPUTER_TOOL_NAMES } from '@cindy/mcps/computer';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

// Codex evaluates native prefix rules before spawning shell commands, including
// in Full Access. Match driver entry points, never text in search arguments.
const verbs = new Set(['call', 'mcp', 'run_steps', 'end_session', ...COMPUTER_TOOL_NAMES]);
verbs.delete('status');
verbs.delete('check_permissions');
const aliases = [...new Set([...verbs].flatMap(verb => [verb, verb.replaceAll('_', '-')]))];
const rule = '# Managed by Cindy.\n' + ['cua-driver', 'cua-driver.exe'].map(program =>
  `prefix_rule(pattern=[${JSON.stringify(program)}, ${JSON.stringify(aliases)}], decision="forbidden", justification="SHELL_DESKTOP_INPUT_NOT_ALLOWED: Use cindy_computer for desktop operations.")\n`
).join('');

async function ensureManagedDirectory(root: string, directory: string): Promise<void> {
  let parent = await fs.realpath(root);
  const relative = path.relative(root, directory);
  try {
    if (await fs.realpath(directory) !== path.join(parent, relative)) throw new Error('Unexpected Codex rules directory');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Check each existing ancestor before creating a missing account directory.
  for (const component of relative.split(path.sep)) {
    parent = path.join(parent, component);
    try {
      await fs.mkdir(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await fs.lstat(parent)).isDirectory()) throw new Error('Unexpected Codex desktop rule directory');
    }
  }
}

/** Install only into a Cindy-owned runtime home. The default subscription may
 * use the person's standalone ~/.codex, and resumed tasks can have an external
 * history home. Never add a persistent command restriction to those locations. */
export async function prepareCodexDesktopInputRules(runtimeHome: string, appHome: string): Promise<void> {
  const profile = path.relative(os.homedir(), runtimeHome);
  const account = path.relative(path.join(path.dirname(appHome), 'codex-accounts'), runtimeHome).split(path.sep);
  const legacyAccount = account.length === 2 && /^[a-f0-9]{64}$/.test(account[0]!) && /^[a-z0-9_-]{1,40}$/.test(account[1]!);
  const poolAccount = /^\.codex-cindy-[a-f0-9]{12}-[a-f0-9-]{36}$/.test(profile);
  if (runtimeHome !== appHome && !legacyAccount && !poolAccount) return;

  // Anchor the resolved home under the same trusted parent; do not follow a
  // redirected account, rules directory, or rule file into an external profile.
  const root = poolAccount ? os.homedir() : path.dirname(appHome);
  const directory = path.join(runtimeHome, 'rules');
  await ensureManagedDirectory(root, directory);
  const file = path.join(directory, 'cindy-computer-use.rules');
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('Unexpected Codex desktop input rule file');
    const current = await fs.readFile(file, 'utf8');
    if (current === rule) return;
    if (!current.startsWith('# Managed by Cindy.\n')) throw new Error('Codex desktop input rule filename is already in use');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  atomicWriteFileSync(file, rule);
}
