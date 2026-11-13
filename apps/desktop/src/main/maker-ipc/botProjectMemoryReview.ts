import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

export const LEGACY_MEMORY_REVIEW_HOOK_COMMAND = 'xdt-node "../.memory-review-check-v1.cjs"';
export const MEMORY_REVIEW_HOOK_COMMAND = 'cindy-node-script "../.memory-review-check-v1.cjs"';

/** The bundled check lives beside the workspace, not in its Git history: its database path is
 * local account data. Memory itself remains ordinary portable project files. No model or new
 * scheduler setting is needed to decide whether yesterday had anything to review. */
export async function ensureMemoryReviewHook(input: {
  workingDir: string;
  botId: string;
  databasePath: string;
  previousCommand?: string;
}): Promise<{ command: string; timeoutMs: number }> {
  const filename = '.memory-review-check-v1.cjs';
  const check = String.raw`
(async () => {
const { DatabaseSync } = require('node:sqlite');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.event !== 'schedule-pre-run' || !Number.isFinite(event.firedAt)) {
  throw new Error('Missing schedule pre-run event');
}
const db = new DatabaseSync(source.databasePath, { readOnly: true });
try {
  function messageText(content) {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === 'string' ? parsed
        : typeof parsed?.text === 'string' ? parsed.text : '';
    } catch { return content; }
  }
  function humanInput(row) {
    let meta;
    try { meta = JSON.parse(row.agent_meta || '{}'); } catch { return false; }
    if (meta?.sourcePlugin || meta?.autoResume === true) return false;
    const origin = meta?.origin;
    // Host-attested owner group messages retain the hidden dispatch prefix. Count the
    // actual owner text before rejecting synthetic envelopes (including attachments).
    if (typeof meta?.autoReviewUserText === 'string' && meta.autoReviewUserText.trim()) return true;
    if (origin?.groupThread || origin?.groupRequest) return true;
    if (messageText(row.content).startsWith(source.syntheticPrefix)) return false;
    return !origin?.kind || (origin.kind === 'scheduler'
      && typeof origin.scheduleId === 'string' && origin.scheduleId.startsWith('hook:'));
  }
  // Stop once the bundled minimum is met; synthetic messages never contribute.
  const rows = db.prepare(
    "SELECT m.content, m.agent_meta FROM bot_session_links l JOIN messages m ON m.session_id = l.session_id " +
    "WHERE l.bot_id = ? AND m.role = 'user' AND m.rewind_at IS NULL " +
    "AND m.created_at > ? AND m.created_at <= ?"
  ).iterate(source.botId, event.firedAt - 24 * 60 * 60 * 1000, event.firedAt);
  const minimumHumanMessages = 20;
  let humanMessages = 0;
  for (const row of rows) {
    if (humanInput(row) && ++humanMessages >= minimumHumanMessages) break;
  }
  if (humanMessages < minimumHumanMessages) {
    console.log('Only ' + humanMessages + '/' + minimumHumanMessages + ' human messages in the last day; memory and skills review skipped.');
    process.exitCode = 2;
  }
} finally {
  db.close();
}
process.stdout.write('', () => process.exit(process.exitCode || 0));
})().catch(error => { console.error(error); process.stderr.write('', () => process.exit(1)); });
`;
  const source = `const source = ${JSON.stringify({ databasePath: input.databasePath, botId: input.botId, syntheticPrefix: UI_ACTION_TRIGGER_PREFIX })};\n` + check;
  // Preserve an owner's edits to the supplied check. A missing database or broken check fails
  // closed through the existing preRunHook protocol; it never silently starts the model.
  const file = path.join(input.workingDir, '..', filename);
  try {
    await fs.writeFile(file, source, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await fs.lstat(file)).isFile()) throw new Error('Memory review check must be a regular file');
    const old = await fs.readFile(file, 'utf8');
    // On another computer the supplied script needs that computer's database location. Only
    // refresh our untouched script; never replace a check the owner has edited.
    // Git/editor line-ending conversion does not make a bundled check owner-customized.
    const oldCheck = old.slice(old.indexOf('\n') + 1).replace(/\r\n/g, '\n');
    // Exact prior bundled bodies; owner-edited checks stay untouched.
    const previousBundled = createHash('sha256').update(oldCheck).digest('hex')
      === '32dd10c0fb4c51e5fde92f0e57b80d6a4391c35d7fc134f847ac6496c76ef47c'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '4765ed7d8092d3c2a594e965966db40a88336ddb0b858309b4b19febba64097f'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '8d85213bf0d533c2cf1bf9376a21f5994aa2fe73a1257f9e49096fa1fb8418cb'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '8e97ec8f8733954427efb43d81b9cd58d5940baa2d4f238737727a3903e6dd65';
    if (oldCheck !== check && !previousBundled && input.previousCommand) {
      return { command: input.previousCommand, timeoutMs: 10_000 };
    }
    if (old !== source && old.startsWith('const source = {') && (oldCheck === check || previousBundled)) {
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, source, { flag: 'wx' });
      await fs.rename(temp, file);
    }
  }
  return { command: MEMORY_REVIEW_HOOK_COMMAND, timeoutMs: 10_000 };
}
