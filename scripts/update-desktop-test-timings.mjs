#!/usr/bin/env node
// Refresh apps/desktop/src/test/vitest/fileTimings.json, which the Desktop
// timing sequencer uses to balance CI unit shards.
//
//   pnpm update:desktop-test-timings --run <client-ci run id>
//   pnpm update:desktop-test-timings --dir <downloaded artifact directory>
//
// Use a green run: the Windows shards are the CI critical path, so their
// per-file worker time is the weight. Files missing from the data fall back to
// the median, so a stale file only costs balance, never coverage.
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
	if (!options.run === !options.dir) throw new Error('pass exactly one of --run <id> or --dir <path>');
	if (options.run && !/^\d+$/.test(options.run)) throw new Error('--run must be a numeric run id');
	return options;
}

function listJson(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return listJson(full);
		return entry.name.endsWith('.json') ? [full] : [];
	});
}

export function mergeShardTimings(reports) {
	const files = {};
	const shards = new Set();
	for (const report of reports) {
		if (report?.version !== 1 || typeof report.files !== 'object') throw new Error('unexpected timing report format');
		if (report.shard) shards.add(report.shard);
		for (const [file, timing] of Object.entries(report.files)) {
			const total = Math.max(1, Math.round(timing.totalMs));
			files[file] = Math.max(files[file] ?? 0, total);
		}
	}
	const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
	return { shards: [...shards].sort(), files: sorted };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const downloadDir = options.run ? fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-timings-')) : null;
	try {
		if (downloadDir) {
			execFileSync('gh', ['run', 'download', options.run, '--pattern', ARTIFACT_PATTERN, '--dir', downloadDir], { cwd: ROOT, stdio: 'inherit' });
		}
		const sourceDir = downloadDir ?? path.resolve(options.dir);
		const reports = listJson(sourceDir).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
		if (reports.length === 0) throw new Error(`no timing reports under ${sourceDir}`);
		const merged = mergeShardTimings(reports);
		const source = options.run ? `client-ci run ${options.run}` : 'local artifact directory';
		fs.writeFileSync(OUTPUT, `${JSON.stringify({
			version: 1,
			source: `${source}, windows, shards ${merged.shards.join(' ') || 'unknown'}`,
			unit: 'ms',
			files: merged.files,
		}, null, 1)}\n`);
		console.log(`wrote ${Object.keys(merged.files).length} file timings from ${reports.length} reports to ${path.relative(ROOT, OUTPUT)}`);
	} finally {
		if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
