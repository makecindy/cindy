import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

export const MEMORY_REVIEW_HOOK_COMMAND = 'xdt-node "../.memory-review-check-v1.cjs"';

/** The bundled check lives beside the workspace, not in its Git history: its database path is
 * local account data. Memory itself remains ordinary portable project files. No model or new
 * scheduler setting is needed to decide whether yesterday had anything to review. */
export async function ensureMemoryReviewHook(input: {
  workingDir: string;
  botId: string;
  databasePath: string;
}): Promise<{ command: string; timeoutMs: number }> {
  const filename = '.memory-review-check-v1.cjs';
  const check = String.raw`
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const event = JSON.parse(fs.readFileSync(0, 'utf8'));
if (event.event !== 'schedule-pre-run' || !Number.isFinite(event.firedAt)) {
  throw new Error('Missing schedule pre-run event');
}
const db = new DatabaseSync(source.databasePath, { readOnly: true });
try {
  // Session/history links include the teammate's chat and IM lanes. Automated user-role
  // messages must not make the nightly review keep waking itself or other idle teammates.
  const activity = db.prepare(
    "SELECT 1 FROM bot_session_links l JOIN messages m ON m.session_id = l.session_id " +
    "WHERE l.bot_id = ? AND m.role = 'user' AND m.rewind_at IS NULL " +
    "AND m.created_at > ? AND m.created_at <= ? " +
    "AND substr(m.content, 1, ?) <> ? AND substr(m.content, 1, ?) <> ? " +
    "AND (m.agent_meta IS NULL OR (json_valid(m.agent_meta) AND " +
    "json_extract(m.agent_meta, '$.sourcePlugin') IS NULL AND (" +
    "json_extract(m.agent_meta, '$.origin.kind') IS NULL OR " +
    "json_extract(m.agent_meta, '$.origin.groupThread') IS NOT NULL OR " +
    "json_extract(m.agent_meta, '$.origin.groupRequest') IS NOT NULL OR " +
    "(json_extract(m.agent_meta, '$.origin.kind') = 'scheduler' AND " +
    "json_extract(m.agent_meta, '$.origin.scheduleId') LIKE 'hook:%')))) LIMIT 1"
  ).get(source.botId, event.firedAt - 24 * 60 * 60 * 1000, event.firedAt,
    source.syntheticPrefix.length, source.syntheticPrefix,
    source.syntheticPrefix.length + 1, '"' + source.syntheticPrefix);
  if (!activity) {
    console.log('No human messages in the last day; memory and skills review skipped.');
    process.exitCode = 2;
  }
} finally {
  db.close();
}
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
    if (old !== source && old.startsWith('const source = {') && old.slice(old.indexOf('\n') + 1) === check) {
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, source, { flag: 'wx' });
      await fs.rename(temp, file);
    }
  }
  return { command: MEMORY_REVIEW_HOOK_COMMAND, timeoutMs: 10_000 };
}
