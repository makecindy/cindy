import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restorePerformanceFiles } from '../src/main/performance-trace/restore';

async function main() {
  const [input, reportId, output, attemptId] = process.argv.slice(2);
  if (!input || !reportId || !output)
    throw new Error(
      'Usage: pnpm --dir apps/desktop exec tsx scripts/restore-performance-report.ts <SLS-export.json|jsonl> <report-id> <new-output-directory> [attempt-id]',
    );
  const text = await readFile(input, 'utf8');
  const parsed: unknown = text.trimStart().startsWith('[')
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error('Expected an array of exported SLS rows or JSONL');
  const result = restorePerformanceFiles(parsed, reportId, attemptId);
  // Verify everything before writing, and never overwrite an existing folder/file.
  const destination = path.resolve(output);
  await mkdir(destination, { mode: 0o700 });
  for (const [name, bytes] of result.files)
    await writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(
    path.join(destination, 'upload-manifest.json'),
    JSON.stringify(
      {
        reportId,
        attemptId: result.attemptId,
        ...result.manifest,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `Restored ${result.files.size} files for ${reportId} (${result.attemptId}) to ${destination}`,
  );
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
