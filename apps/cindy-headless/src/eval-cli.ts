#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import {
  createEvaluationReport,
  expandPairedPlan,
  expandPlan,
  expandScheduledPlan,
  freezeHard30,
  summarizePairedResults,
  validateManifest,
  validateOracleGate,
  validatePairedManifest,
} from './benchmark.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function requireFlag(name: string): string { const value = flag(name); if (!value) throw new Error(`${name} is required`); return value; }

async function main(): Promise<void> {
  if (command === 'plan') {
    const outputPath = requireFlag('--output');
    const manifest = validateManifest(JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')));
    const plan = args.includes('--paired')
      ? expandPairedPlan(validatePairedManifest(manifest))
      : args.includes('--scheduled') ? expandScheduledPlan(manifest) : expandPlan(manifest);
    await writeFile(outputPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ ok: true, output: outputPath }));
    return;
  }
  if (command === 'paired-summary') {
    console.log(JSON.stringify(summarizePairedResults(JSON.parse(await readFile(requireFlag('--results'), 'utf8'))), null, 2));
    return;
  }
  if (command === 'report') {
    const manifest = validateManifest(JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')));
    console.log(JSON.stringify(createEvaluationReport(manifest, JSON.parse(await readFile(requireFlag('--results'), 'utf8'))), null, 2));
    return;
  }
  if (command === 'freeze-hard-30') {
    const historical = JSON.parse(await readFile(requireFlag('--historical'), 'utf8')) as Array<{ taskId: string; solveRate: number }>;
    console.log(JSON.stringify(freezeHard30(historical), null, 2));
    return;
  }
  if (command === 'oracle-gate') {
    const manifest = validateManifest(JSON.parse(await readFile(requireFlag('--manifest'), 'utf8')));
    const results = JSON.parse(await readFile(requireFlag('--results'), 'utf8')) as Array<{ taskId: string; reward: number }>;
    console.log(JSON.stringify(validateOracleGate(manifest.dataset.taskIds, results), null, 2));
    return;
  }
  console.error('cindy-headless-eval commands: plan [--paired|--scheduled], paired-summary, report, freeze-hard-30, oracle-gate');
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
