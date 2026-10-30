/** Compare two recorded component builds on one machine, sequentially.
 * AX is off in BOTH cases so the unfixed control can finish. This measures the
 * fixture, not production session-switch latency or accessibility performance.
 * node benchmark-component.mjs <baseline-build-root> <fixed-build-root>
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [baseline, fixed] = process.argv.slice(2);
if (!baseline || !fixed) throw new Error('Expected baseline and fixed build roots');
for (const root of [baseline, fixed]) await fs.access(path.join(root, 'component/component.html'));
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ax5406-benchmark-'));
const results = [];
for (let iteration = 0; iteration < 3; iteration++) {
  for (const [label, root] of [['baseline', baseline], ['fixed', fixed]]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--scenario=component', `--component-build=${root}`, '--seconds=15', '--ax=off', '--query=none',
      '--rows=200', '--batch=1', '--target=tail', '--scroll=off', '--seed=5407'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    const runRoot = /^AX5406_ARTIFACTS=(.+)$/m.exec(stdout)?.[1]?.trim();
    if (!runRoot) throw new Error(`No artifact root for ${label}: ${stdout}`);
    const report = JSON.parse(await fs.readFile(path.join(runRoot, 'report.json'), 'utf8'));
    const row = { label, iteration, code, status: report.status, report: path.join(runRoot, 'report.json'),
      firstContentfulPaintMs: report.performance?.['first-contentful-paint'],
      commits: report.stats?.commits, mutations: report.stats?.mutations,
      mountedRows: report.stats?.renderedRows, containment: report.stats?.containment };
    results.push(row);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(row));
    if (code !== 0 || report.status !== 'completed-no-crash') throw new Error(`Benchmark case failed: ${label}`);
  }
}
console.log(`AX5406_BENCHMARK=${output}`);
