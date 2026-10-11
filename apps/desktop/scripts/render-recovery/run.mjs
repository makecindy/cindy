import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const outputDir = process.env.RENDER_PROBE_OUTPUT
  ? path.resolve(process.env.RENDER_PROBE_OUTPUT)
  : await mkdtemp(path.join(os.tmpdir(), 'cindy-render-results-'));
const installDir = process.env.RENDER_PROBE_ELECTRON_DIR;
const require = createRequire(
  installDir ? path.join(path.resolve(installDir), 'package.json') : import.meta.url,
);
const electron = require('electron');
const env = {
  ...process.env,
  RENDER_PROBE_OUTPUT: outputDir,
  RENDER_PROBE_IDLE_SECONDS: process.env.RENDER_PROBE_IDLE_SECONDS ?? '900',
  RENDER_PROBE_HIDDEN_SECONDS: process.env.RENDER_PROBE_HIDDEN_SECONDS ?? '3',
  RENDER_PROBE_SCENARIO: process.env.RENDER_PROBE_SCENARIO ?? 'minimize',
  RENDER_PROBE_SURFACE: process.env.RENDER_PROBE_SURFACE ?? 'window',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const idleSeconds = Number(env.RENDER_PROBE_IDLE_SECONDS);
const hiddenSeconds = Number(env.RENDER_PROBE_HIDDEN_SECONDS);
if (
  !Number.isInteger(idleSeconds) ||
  idleSeconds < 1 ||
  idleSeconds > 1800 ||
  !Number.isInteger(hiddenSeconds) ||
  hiddenSeconds < 1 ||
  hiddenSeconds > 8100
) {
  throw new Error('Invalid probe durations: idle 1..1800, hidden 1..8100 seconds');
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'cindy-render-probe-'));
env.RENDER_PROBE_PROFILE = profile;
await mkdir(outputDir, { recursive: true });
// A reused local output directory must not supply evidence from an earlier run.
for (const file of ['report.json', 'events.jsonl', 'baseline.png', 'after-idle.png']) {
  await rm(path.join(outputDir, file), { force: true });
}
process.stdout.write(`Render probe output: ${outputDir}\n`);
const child = spawn(electron, [fileURLToPath(new URL('./main.cjs', import.meta.url))], {
  env,
  stdio: 'inherit',
});
const timeout = setTimeout(() => child.kill(), (idleSeconds + hiddenSeconds + 90) * 1000);
const exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(2));
  child.once('close', (code) => resolve(code ?? 2));
});
clearTimeout(timeout);
let resultExitCode = exitCode;
try {
  const report = JSON.parse(await readFile(path.join(outputDir, 'report.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed' && resultExitCode === 0) resultExitCode = 2;
  if (process.env.GITHUB_STEP_SUMMARY) {
    const final = report.samples?.at(-1);
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `Electron ${report.electron}: **${report.status}**`,
        '',
        `Scenario: ${report.scenario}; surface: ${report.surface}; idle: ${idleSeconds}s; hidden: ${hiddenSeconds}s.`,
        '',
        `Final pixels: ${final?.pixelsMatch ?? 'unknown'}; input: ${final?.inputResponded ?? 'unknown'}; rAF: ${final?.frame?.arrived ?? 'unknown'}.`,
        '',
        'Synthetic Electron fixture only. A pass does not prove Cindy #5627 is fixed.',
        '',
      ].join('\n'),
    ).catch((error) => {
      // A CI summary failure must not overwrite the original diagnostic report.
      process.stderr.write(`Could not write step summary: ${error.message}\n`);
    });
  }
} catch {
  resultExitCode = 2;
  process.stderr.write('Electron probe exited without a report; result is inconclusive.\n');
  await writeFile(
    path.join(outputDir, 'report.json'),
    JSON.stringify(
      {
        status: 'inconclusive',
        error: 'Electron probe exited without a report',
        exitCode,
      },
      null,
      2,
    ),
  );
}
try {
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* Runner teardown also removes its temporary profile. */
}
process.exitCode = resultExitCode;
