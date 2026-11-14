#!/usr/bin/env node
// Refresh apps/desktop/src/test/vitest/fileTimings.json, which the Desktop
// timing sequencer uses to balance CI unit shards.
//
//   pnpm update:desktop-test-timings --run <run id>[,<run id>...]
//   pnpm update:desktop-test-timings --dir <downloaded artifact directory>
//
// Use green client-ci runs; the Windows shards are the critical path, so their
// per-file worker time is the weight. Hosted Windows runners differ in speed by
// up to ~2x, and every file is measured on whichever runner its shard got, so
// each report is first divided by that runner's speed factor (its mean fixed
// per-file cost: environment + prepare + setup, relative to all reports).
// Several runs are averaged. Files missing from the data fall back to the
// median, so a stale file only costs balance, never coverage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = path.join(ROOT, 'apps/desktop/src/test/vitest/fileTimings.json');
const ARTIFACT_PATTERN = 'desktop-file-timings-windows-shard-*';

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--run' || arg === '--dir') options[arg.slice(2)] = argv[++index];
		else if (arg !== '--') throw new Error(`unknown argument: ${arg}`);
	}
	if (!options.run === !options.dir) throw new Error('pass exactly one of --run <id>[,<id>...] or --dir <path>');
	if (options.run) {
		options.runs = options.run.split(',').map((id) => id.trim()).filter(Boolean);
		if (options.runs.length === 0 || options.runs.some((id) => !/^\d+$/.test(id))) throw new Error('--run takes numeric run ids separated by commas');
	}
	return options;
}

function listJson(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return listJson(full);
		return entry.name.endsWith('.json') ? [full] : [];
	});
}

const fixedCost = (timing) => timing.environmentMs + timing.prepareMs + timing.setupMs;

/** Machine-normalized mean worker time per file across all shard reports. */
export function mergeShardTimings(reports) {
	const perReport = reports.map((report) => {
		if (report?.version !== 1 || typeof report.files !== 'object') throw new Error('unexpected timing report format');
		const timings = Object.values(report.files);
		return { report, fixed: timings.reduce((sum, timing) => sum + fixedCost(timing), 0) / Math.max(1, timings.length) };
	});
	const meanFixed = perReport.reduce((sum, entry) => sum + entry.fixed, 0) / Math.max(1, perReport.length);
	const samples = new Map();
	for (const { report, fixed } of perReport) {
		const speed = meanFixed > 0 && fixed > 0 ? fixed / meanFixed : 1;
		for (const [file, timing] of Object.entries(report.files)) {
			if (!samples.has(file)) samples.set(file, []);
			samples.get(file).push(timing.totalMs / speed);
		}
	}
	const entries = [...samples].map(([file, values]) =>
		[file, Math.max(1, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))]);
	entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return Object.fromEntries(entries);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const downloadDir = options.runs ? fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-timings-')) : null;
	try {
		for (const run of options.runs ?? []) {
			execFileSync('gh', ['run', 'download', run, '--pattern', ARTIFACT_PATTERN, '--dir', path.join(downloadDir, run)], { cwd: ROOT, stdio: 'inherit' });
		}
		const sourceDir = downloadDir ?? path.resolve(options.dir);
		const reports = listJson(sourceDir).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
		if (reports.length === 0) throw new Error(`no timing reports under ${sourceDir}`);
		const files = mergeShardTimings(reports);
		const source = options.runs ? `client-ci runs ${options.runs.join(' ')}` : 'local artifact directory';
		fs.writeFileSync(OUTPUT, `${JSON.stringify({
			version: 1,
			source: `${source}; Windows shard reports normalized by runner speed`,
			unit: 'ms',
			files,
		}, null, 1)}\n`);
		console.log(`wrote ${Object.keys(files).length} file timings from ${reports.length} reports to ${path.relative(ROOT, OUTPUT)}`);
	} finally {
		if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
