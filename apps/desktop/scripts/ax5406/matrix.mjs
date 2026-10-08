/** Explicit, bounded integration experiment, excluded from unit CI. No account/profile access. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cases = [
  ['repro-5406', '--seed=5406', '--seconds=15'],
  ['repro-5407', '--seed=5407', '--seconds=15'],
  ['repro-5408', '--seed=5408', '--seconds=15'],
  ['no-containment', '--seed=5406', '--seconds=120', '--containment=off'],
  ['no-accessibility', '--seed=5406', '--seconds=120', '--ax=off'],
  ['no-query', '--seed=5406', '--seconds=120', '--query=none'],
];
for (const [name, ...args] of cases) {
  console.log(`AX5406_CASE=${name}`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)),
    '--scenario=minimal', '--scroll=off', '--rows=12', '--batch=1', ...args], { stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  console.log(`AX5406_CASE_EXIT=${name}:${code}`);
  if (code !== 0 && code !== 10) process.exitCode = 2;
}
