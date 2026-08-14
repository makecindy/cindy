#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmInvocation } from "./shared/pnpm-invocation.mjs";
import {
	acquireTestGateLock,
	shouldUseTestGateLock,
} from "./test-gate-lock.mjs";
import { createRelatedUnitPlan } from "./test-related.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const IGNORED_PARTS = new Set([
	"node_modules",
	"dist",
	"build",
	"release",
	"coverage",
	".git",
	".cache",
]);
const NESTED_NON_WORKSPACES = ["apps/desktop/cindy-updater", "tools"];
const VALID_STATUSES = new Set([
	"required",
	"notApplicable",
	"manual",
	"external",
	"deferred",
]);
const VALID_COVERAGE_MODES = new Set(["workspace", "allowlist"]);
const VALID_EXECUTION_MODES = new Set(["normal", "exclusive"]);
const MAX_DEFAULT_WORKSPACE_CONCURRENCY = 4;
const DEFAULT_CAPTURED_OUTPUT_LIMIT = 2 * 1024 * 1024;

export function normalizeRelPath(value) {
	return value.replace(/\\/g, "/");
}

export function parseWorkspacePatterns(text) {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim().match(/^-\s+["']?([^"']+)["']?$/)?.[1])
		.filter(Boolean);
}

export function parseCliOptions(args) {
	const options = {
		all: false,
		tier: "unit",
		workspaces: [],
		excludeWorkspaces: [],
		workspaceConcurrency: undefined,
		noLock: false,
		related: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") continue;
		if (arg === "--all") {
			options.all = true;
			continue;
		}
		if (arg === "--no-lock") {
			options.noLock = true;
			continue;
		}
		if (arg === "--related") {
			options.related = true;
			continue;
		}
		if (arg === "--tier") {
			const value = args[index + 1];
			if (!value || value.startsWith("--"))
				throw new Error("--tier requires a value");
			options.tier = value;
			index += 1;
			continue;
		}
		if (arg === "--workspace" || arg === "--exclude-workspace") {
			const value = args[index + 1];
			if (!value || value.startsWith("--"))
				throw new Error(`${arg} requires a value`);
			const selectors = parseWorkspaceSelectorValue(value);
			if (selectors.length === 0) throw new Error(`${arg} requires a value`);
			if (arg === "--workspace") options.workspaces.push(...selectors);
			else options.excludeWorkspaces.push(...selectors);
			index += 1;
			continue;
		}
		if (
			arg === "--workspace-concurrency" ||
			arg.startsWith("--workspace-concurrency=")
		) {
			const inlineValue = arg.startsWith("--workspace-concurrency=")
				? arg.slice("--workspace-concurrency=".length)
				: undefined;
			const value = inlineValue ?? args[index + 1];
			if (!value || (!inlineValue && value.startsWith("--")))
				throw new Error("--workspace-concurrency requires a positive integer");
			options.workspaceConcurrency = parseWorkspaceConcurrency(value);
			if (inlineValue === undefined) index += 1;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	if (options.related && options.all) {
		throw new Error("--related cannot be combined with --all");
	}
	return options;
}

export function parseWorkspaceConcurrency(value) {
	if (!/^[1-9]\d*$/.test(String(value)))
		throw new Error("--workspace-concurrency requires a positive integer");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error("--workspace-concurrency requires a positive integer");
	return parsed;
}

export function defaultWorkspaceConcurrency(
	availableParallelism = os.availableParallelism(),
) {
	const available = Number.isFinite(availableParallelism)
		? Math.floor(availableParallelism)
		: 1;
	return Math.max(1, Math.min(MAX_DEFAULT_WORKSPACE_CONCURRENCY, available));
}

export function parseWorkspaceSelectorValue(value) {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function expandWorkspacePatterns(root = ROOT, patterns) {
	const workspaces = [];
	for (const pattern of patterns) {
		const normalizedPattern = normalizeRelPath(pattern);
		if (!normalizedPattern.endsWith("/*") || normalizedPattern.slice(0, -2).includes("*"))
			throw new Error(`Unsupported workspace pattern: ${pattern}`);
		const base = normalizedPattern.slice(0, -2);
		const absBase = path.join(root, ...base.split("/"));
		if (!fs.existsSync(absBase)) continue;
		for (const entry of fs.readdirSync(absBase, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const cwd = normalizeRelPath(path.join(base, entry.name));
			if (fs.existsSync(path.join(root, cwd, "package.json")))
				workspaces.push(cwd);
		}
	}
	return workspaces.sort();
}

export function isIgnoredFile(file) {
	const normalized = normalizeRelPath(file);
	if (
		NESTED_NON_WORKSPACES.some(
			(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
		)
	)
		return true;
	const parts = normalized.split("/");
	const directoryParts = parts.slice(0, -1);
	return (
		parts.some((part) => IGNORED_PARTS.has(part)) ||
		directoryParts.some((part) => /^generated$/i.test(part))
	);
}

export function discoverTestFiles(files) {
	return files
		.map(normalizeRelPath)
		.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))
		.filter((file) => !isIgnoredFile(file));
}

function escapeRegExp(value) {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob) {
	const normalized = normalizeRelPath(glob);
	let source = "";
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index];
		if (char === "*" && normalized[index + 1] === "*") {
			if (normalized[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index += 1;
			}
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		if (char === "{") {
			const end = normalized.indexOf("}", index);
			if (end > index) {
				const options = normalized
					.slice(index + 1, end)
					.split(",")
					.map((part) => escapeRegExp(part.trim()));
				source += `(?:${options.join("|")})`;
				index = end;
				continue;
			}
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

export function matchesAny(file, patterns = []) {
	return patterns.some((pattern) =>
		globToRegExp(normalizeRelPath(pattern)).test(file),
	);
}

export function selectFilesForTier(workspace, tierConfig, allFiles) {
	const prefix = `${normalizeRelPath(workspace.cwd)}/`;
	const workspaceFiles = discoverTestFiles(allFiles).filter((file) =>
		file.startsWith(prefix),
	);
	return workspaceFiles.filter((file) => {
		const rel = file.slice(prefix.length);
		const include = tierConfig?.include?.length
			? matchesAny(rel, tierConfig.include)
			: true;
		const exclude = tierConfig?.exclude?.length
			? matchesAny(rel, tierConfig.exclude)
			: false;
		return include && !exclude;
	});
}

export function checkTestFiles(workspace, tier, tierConfig, allFiles) {
	if (workspace.status !== "required")
		return { status: "skipped", reason: workspace.reason };
	if (!isRunnableTier(tierConfig))
		return {
			status: "skipped",
			reason: tierConfig?.reason ?? "tier not required",
		};
	const selected = selectFilesForTier(workspace, tierConfig, allFiles);
	if (selected.length === 0)
		throw new Error(
			`No tests selected for runnable tier ${workspace.cwd} ${tier}`,
		);
	return { status: "ok", selected };
}

export function checkIncludeCoverage(workspace, tier, tierConfig, allFiles) {
	if (!isRunnableTier(tierConfig)) return;
	const prefix = `${normalizeRelPath(workspace.cwd)}/`;
	if (tierConfig.coverage === "allowlist") {
		const selected = selectFilesForTier(workspace, tierConfig, allFiles);
		for (const pattern of tierConfig.include ?? []) {
			if (
				!selected.some((file) =>
					matchesAny(file.slice(prefix.length), [pattern]),
				)
			) {
				throw new Error(
					`${workspace.cwd} ${tier} allowlist include matched no tests: ${pattern}`,
				);
			}
		}
		return;
	}
	const workspaceFiles = discoverTestFiles(allFiles).filter((file) =>
		file.startsWith(prefix),
	);
	const selected = new Set(selectFilesForTier(workspace, tierConfig, allFiles));
	for (const file of workspaceFiles) {
		const rel = file.slice(prefix.length);
		if (!selected.has(file) && !matchesAny(rel, tierConfig.exclude ?? [])) {
			throw new Error(
				`${file} is not covered by manifest include/exclude for ${workspace.cwd} ${tier}`,
			);
		}
	}
}

function isRunnableTier(config) {
	return config?.status === "required" || config?.status === "manual";
}

export function validateManifestCoverage(workspaceCwds, manifestWorkspaces) {
	const actual = new Set(workspaceCwds.map(normalizeRelPath));
	const declared = new Set(
		manifestWorkspaces.map((item) => normalizeRelPath(item.cwd)),
	);
	for (const cwd of actual) {
		if (!declared.has(cwd))
			throw new Error(`Manifest is missing pnpm workspace: ${cwd}`);
	}
	for (const cwd of declared) {
		if (!actual.has(cwd))
			throw new Error(`Manifest declares non-pnpm workspace: ${cwd}`);
	}
}

export function validateManifest(manifestWorkspaces) {
	for (const workspace of manifestWorkspaces) {
		if (!VALID_STATUSES.has(workspace.status))
			throw new Error(`${workspace.cwd} has invalid status`);
		if (workspace.status !== "required" && !workspace.reason)
			throw new Error(`${workspace.cwd} requires reason`);
		for (const [tier, config] of Object.entries(workspace.tiers ?? {})) {
			if (!VALID_STATUSES.has(config.status))
				throw new Error(`${workspace.cwd} ${tier} has invalid status`);
			if (
				config.coverage &&
				!VALID_COVERAGE_MODES.has(config.coverage)
			)
				throw new Error(`${workspace.cwd} ${tier} has invalid coverage mode`);
			if (
				isRunnableTier(config) &&
				config.coverage === "allowlist" &&
				!config.include?.length
			)
				throw new Error(
					`${workspace.cwd} ${tier} allowlist coverage requires include patterns`,
				);
			if (workspace.status !== "required" && isRunnableTier(config))
				throw new Error(
					`${workspace.cwd} ${tier} cannot be runnable when workspace status is ${workspace.status}`,
				);
			if (config.status !== "required" && !config.reason)
				throw new Error(`${workspace.cwd} ${tier} requires reason`);
			if (isRunnableTier(config) && !config.command)
				throw new Error(`${workspace.cwd} ${tier} requires command`);
			if (
				config.execution !== undefined &&
				!VALID_EXECUTION_MODES.has(config.execution)
			)
				throw new Error(
					`${workspace.cwd} ${tier} has invalid execution mode`,
				);
		}
	}
}

export function planRuns(manifestWorkspaces, options) {
	const tier = options.tier ?? "unit";
	const includeManual = options.explicit !== false;
	const runs = [];
	for (const workspace of manifestWorkspaces) {
		const tierConfig = workspace.tiers?.[tier];
		if (
			tierConfig?.status !== "required" &&
			!(includeManual && tierConfig?.status === "manual")
		)
			continue;
		if (
			// desktop 的 package test 包含 DB/Electron 相关用例；unit tier 需要走显式 vitest exclude，避免 root unit 入口拖入重型测试。
			workspace.cwd === "apps/desktop" &&
			tier === "unit" &&
			tierConfig.command?.type === "packageScript" &&
			tierConfig.command.script === "test"
		) {
			throw new Error("desktop unit cannot use package test script");
		}
		runs.push({ workspace, tier, tierConfig });
	}
	return runs;
}

function workspaceMatchesSelector(workspace, selector) {
	const normalizedSelector = normalizeRelPath(selector);
	return (
		workspace.name === selector ||
		normalizeRelPath(workspace.cwd) === normalizedSelector
	);
}

export function validateWorkspaceSelectors(
	manifestWorkspaces,
	selectors,
	flag,
) {
	for (const selector of selectors ?? []) {
		if (
			!manifestWorkspaces.some((workspace) =>
				workspaceMatchesSelector(workspace, selector),
			)
		) {
			throw new Error(`${flag} matched no workspace: ${selector}`);
		}
	}
}

export function filterRunsByWorkspace(runs, options = {}) {
	const workspaces = options.workspaces ?? [];
	const excludeWorkspaces = options.excludeWorkspaces ?? [];
	return runs.filter((run) => {
		const included =
			workspaces.length === 0 ||
			workspaces.some((selector) =>
				workspaceMatchesSelector(run.workspace, selector),
			);
		const excluded = excludeWorkspaces.some((selector) =>
			workspaceMatchesSelector(run.workspace, selector),
		);
		return included && !excluded;
	});
}

export function listConfiguredTiers(manifestWorkspaces) {
	return [
		...new Set(
			manifestWorkspaces.flatMap((workspace) =>
				Object.keys(workspace.tiers ?? {}),
			),
		),
	];
}

function describeTierStatus(manifestWorkspaces, tier) {
	const entries = manifestWorkspaces.flatMap((workspace) => {
		const tierConfig = workspace.tiers?.[tier];
		if (!tierConfig) return [];
		const existingScript = tierConfig.existingScript
			? ` existing script: pnpm --dir ${workspace.cwd} run ${tierConfig.existingScript}.`
			: "";
		return [
			`${workspace.cwd} ${tierConfig.status}.${existingScript} ${tierConfig.reason ?? ""}`.trim(),
		];
	});
	return entries.length ? entries.join(" ") : "Tier is not declared in manifest.";
}

export function classifyFailure({ stage, exitCode, output }) {
	if (stage === "preflight") return "PREFLIGHT_FAILED";
	if (exitCode === 0) return null;
	if (/No test files found/i.test(output)) return "NO_TESTS_REQUIRED";
	if (/Failed Suites|Cannot find module|Error: Failed to load/i.test(output))
		return "TEST_COLLECT_FAILED";
	if (/FAIL|AssertionError|expected /i.test(output))
		return "TEST_ASSERTION_FAILED";
	if (/Test timed out/i.test(output)) return "TEST_TIMEOUT";
	return "COMMAND_FAILED";
}

function undersizedVitestShardArgs(commandSpec, selectedFiles) {
	if (commandSpec.type !== "packageBin" || commandSpec.bin !== "vitest")
		return [];
	const shardArg = (commandSpec.args ?? []).find((arg) =>
		arg.startsWith("--shard="),
	);
	const match = /^--shard=(\d+)\/(\d+)$/.exec(shardArg ?? "");
	if (!match) return [];
	const index = Number(match[1]);
	const count = Number(match[2]);
	if (
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(count) ||
		index < 1 ||
		count < 1 ||
		index > count
	)
		return [];

	// Vitest rejects every shard when there are fewer files than shards, before
	// it assigns the files. Limit the compatibility flag to that known case.
	return selectedFiles.length < count ? ["--passWithNoTests"] : [];
}

function toWorkspaceRelativeFile(workspace, file) {
	const workspacePrefix = `${normalizeRelPath(workspace.cwd)}/`;
	const normalized = normalizeRelPath(file);
	if (!normalized.startsWith(workspacePrefix)) {
		throw new Error(
			`Selected test file is outside workspace ${workspace.cwd}: ${file}`,
		);
	}
	return normalized.slice(workspacePrefix.length);
}

function vitestRelatedArgs(commandSpec) {
	const rest = (commandSpec.args ?? []).filter((arg) => arg !== "run");
	return ["related", "--run", ...rest];
}

export function buildPnpmArgs(
	root,
	workspace,
	commandSpec,
	tierConfig = {},
	selectedFiles = [],
	relatedFiles,
) {
	const workspaceAbs = path.join(root, workspace.cwd);
	if (commandSpec.type === "packageScript")
		return ["--dir", workspaceAbs, "run", commandSpec.script];
	if (commandSpec.type === "packageBin") {
		const useRelated =
			commandSpec.bin === "vitest" && Array.isArray(relatedFiles);
		const selectedArgs = useRelated
			? relatedFiles.map((file) => toWorkspaceRelativeFile(workspace, file))
			: tierConfig.include?.length
				? selectedFiles.map((file) => toWorkspaceRelativeFile(workspace, file))
				: [];
		const binArgs = useRelated
			? vitestRelatedArgs(commandSpec)
			: (commandSpec.args ?? []);
		const args = [
			"--dir",
			workspaceAbs,
			"exec",
			commandSpec.bin,
			...binArgs,
			...undersizedVitestShardArgs(commandSpec, selectedFiles),
			...(useRelated ? ["--passWithNoTests"] : []),
			...selectedArgs,
		];
		for (const pattern of tierConfig.exclude ?? []) {
			args.push("--exclude", pattern);
		}
		return args;
	}
	throw new Error(`Unsupported command type: ${commandSpec.type}`);
}

export function buildPreflightArgs(root, workspace, preflight) {
	const workspaceAbs = path.join(root, workspace.cwd);
	if (preflight.type === "packageScript")
		return ["--dir", workspaceAbs, "run", preflight.script];
	throw new Error(`Unsupported preflight type: ${preflight.type}`);
}

export function createOutputForwarder(stream) {
	let writable = Boolean(stream);
	let unexpectedError = null;
	const onError = (error) => {
		writable = false;
		if (error?.code !== "EPIPE") unexpectedError = error;
	};
	stream?.on?.("error", onError);
	return {
		write(chunk) {
			if (!writable) return;
			try {
				stream.write(chunk);
			} catch (error) {
				onError(error);
			}
		},
		finish() {
			stream?.off?.("error", onError);
			return unexpectedError;
		},
	};
}

export function resolveOutputStream(configured, fallback) {
	return configured === undefined ? fallback : configured;
}

export function createBoundedOutputBuffer(
	maxChars = DEFAULT_CAPTURED_OUTPUT_LIMIT,
) {
	const limit =
		Number.isFinite(maxChars) && maxChars > 0
			? Math.floor(maxChars)
			: DEFAULT_CAPTURED_OUTPUT_LIMIT;
	const headLimit = Math.floor(limit / 4);
	const tailLimit = limit - headLimit;
	let head = "";
	let tail = "";
	let totalChars = 0;
	return {
		append(value) {
			let text = String(value);
			totalChars += text.length;
			if (head.length < headLimit) {
				const headRemaining = headLimit - head.length;
				head += text.slice(0, headRemaining);
				text = text.slice(headRemaining);
			}
			if (text.length > 0) {
				const tailInput =
					text.length > tailLimit ? text.slice(-tailLimit) : text;
				tail = `${tail}${tailInput}`.slice(-tailLimit);
			}
		},
		toString() {
			if (totalChars <= limit) return `${head}${tail}`;
			const omitted = totalChars - head.length - tail.length;
			return (
				`${head}\n... ${omitted} output characters omitted ...\n${tail}`
			);
		},
	};
}

export function runCommand(command, args, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: options.shell,
			windowsVerbatimArguments: options.windowsVerbatimArguments,
			windowsHide: true,
		});
		const output = createBoundedOutputBuffer(options.maxOutputChars);
		let settled = false;
		const stdout = createOutputForwarder(resolveOutputStream(options.stdout, process.stdout));
		const stderr = createOutputForwarder(resolveOutputStream(options.stderr, process.stderr));
		const finish = (result) => {
			if (settled) return;
			settled = true;
			const stdoutError = stdout.finish();
			const stderrError = stderr.finish();
			const forwardingError = stdoutError ?? stderrError;
			if (forwardingError) {
				output.append(
					`\nOutput forwarding failed: ${forwardingError.message ?? String(forwardingError)}`,
				);
				resolve({ exitCode: 1, output: output.toString() });
				return;
			}
			resolve({ ...result, output: output.toString() });
		};
		child.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			output.append(text);
			stdout.write(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString();
			output.append(text);
			stderr.write(chunk);
		});
		child.on("error", (error) => {
			output.append(error.message);
			finish({ exitCode: 1 });
		});
		child.on("close", (code) => {
			finish({ exitCode: code ?? 1 });
		});
	});
}

/**
 * Runs independent tasks with a fixed upper bound while preserving result order.
 * Workers pull the next task as soon as they finish, so one slow workspace does
 * not hold an entire batch open.
 */
export async function mapWithConcurrency(items, concurrency, runItem) {
	const limit = parseWorkspaceConcurrency(concurrency);
	const results = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				results[index] = await runItem(items[index], index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/**
 * Exclusive runs form barriers around normal runs. This keeps a heavyweight
 * workspace such as Desktop from multiplying its internal worker pool with the
 * outer workspace concurrency.
 */
export async function runWithExclusiveBarriers(
	runs,
	concurrency,
	runItem,
) {
	const results = [];
	let normalSegment = [];
	const flushNormalSegment = async () => {
		if (normalSegment.length === 0) return;
		results.push(
			...(await mapWithConcurrency(normalSegment, concurrency, runItem)),
		);
		normalSegment = [];
	};
	for (const run of runs) {
		if (run.tierConfig.execution !== "exclusive") {
			normalSegment.push(run);
			continue;
		}
		await flushNormalSegment();
		results.push(await runItem(run));
	}
	await flushNormalSegment();
	return results;
}

function formatElapsed(durationMs) {
	if (durationMs < 1_000) return `${durationMs}ms`;
	return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Buffers each child command and flushes it as one block on completion. Parallel
 * workspaces remain observable without interleaving Vitest output line-by-line.
 */
export function createWorkspaceRunReporter({
	stdout = process.stdout,
	now = Date.now,
} = {}) {
	const startedAt = new Map();
	return {
		onRunStart(run) {
			const key = `${run.workspace.cwd}\0${run.tier}`;
			startedAt.set(key, now());
			stdout.write(`START ${run.workspace.cwd} ${run.tier}\n`);
		},
		onCommandComplete({ run, stage, commandResult }) {
			// Successful Vitest workspaces can contain thousands of per-file lines.
			// The elapsed PASS line is sufficient; retain full output only when a
			// command fails so diagnostics stay available without flooding CI logs.
			if (commandResult.exitCode === 0 || !commandResult.output) return;
			const output = commandResult.output.endsWith("\n")
				? commandResult.output
				: `${commandResult.output}\n`;
			stdout.write(
				`\n[${run.workspace.cwd} ${run.tier} ${stage}]\n${output}`,
			);
		},
		onRunComplete(run, result) {
			const key = `${run.workspace.cwd}\0${run.tier}`;
			const started = startedAt.get(key);
			const fallbackDurationMs =
				started === undefined ? 0 : Math.max(0, now() - started);
			const durationMs = Number.isFinite(result.durationMs)
				? Math.max(0, result.durationMs)
				: fallbackDurationMs;
			startedAt.delete(key);
			const status = result.exitCode === 0 ? "PASS" : `FAIL ${result.failure}`;
			stdout.write(
				`${status} ${run.workspace.cwd} ${run.tier} (${formatElapsed(durationMs)})\n`,
			);
		},
	};
}

export function readAllFiles(root) {
	const files = [];
	function visit(absDir) {
		for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
			const abs = path.join(absDir, entry.name);
			const rel = normalizeRelPath(path.relative(root, abs));
			if (isIgnoredFile(rel)) continue;
			if (entry.isDirectory()) {
				visit(abs);
				continue;
			}
			if (entry.isFile()) files.push(rel);
		}
	}
	visit(root);
	return files;
}

export async function runPlannedTests({
	root = ROOT,
	manifest,
	tier = "unit",
	all = false,
	workspaces = [],
	excludeWorkspaces = [],
	workspaceCwds,
	allFiles,
	runCommandImpl = runCommand,
	workspaceConcurrency,
	relatedFilesByWorkspace,
	reporter,
	now = Date.now,
}) {
	const manifestWorkspaces = manifest.workspaces;
	const actualWorkspaceCwds =
		workspaceCwds ??
		expandWorkspacePatterns(
			root,
			parseWorkspacePatterns(
				fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
			),
		);
	validateManifest(manifestWorkspaces);
	validateManifestCoverage(actualWorkspaceCwds, manifestWorkspaces);
	validateWorkspaceSelectors(manifestWorkspaces, workspaces, "--workspace");
	validateWorkspaceSelectors(
		manifestWorkspaces,
		excludeWorkspaces,
		"--exclude-workspace",
	);
	const discoveredFiles = allFiles ?? discoverTestFiles(readAllFiles(root));
	const tiers = all ? listConfiguredTiers(manifestWorkspaces) : [tier];
	const results = [];
	const concurrency =
		workspaceConcurrency ?? defaultWorkspaceConcurrency();
	for (const currentTier of tiers) {
		const runs = filterRunsByWorkspace(
			planRuns(manifestWorkspaces, {
				tier: currentTier,
				explicit: !all,
			}),
			{ workspaces, excludeWorkspaces },
		);
		if (!all && runs.length === 0) {
			throw new Error(
				`No runnable test runs configured for tier ${currentTier}. ${describeTierStatus(manifestWorkspaces, currentTier)}`,
			);
		}
		const tierResults = await runWithExclusiveBarriers(
			runs,
			concurrency,
			async (run) => {
			const startedAt = now();
			reporter?.onRunStart?.(run);
			const fileCheck = checkTestFiles(
				run.workspace,
				currentTier,
				run.tierConfig,
				discoveredFiles,
			);
			checkIncludeCoverage(
				run.workspace,
				currentTier,
				run.tierConfig,
				discoveredFiles,
			);
			const cwd = path.join(root, run.workspace.cwd);
			for (const preflight of run.tierConfig.preflight ?? []) {
				const pnpmArgs = buildPreflightArgs(root, run.workspace, preflight);
				const invocation = resolvePnpmInvocation(pnpmArgs);
				const commandResult = await runCommandImpl(
					invocation.command,
					invocation.args,
					{
						cwd,
						env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
						shell: invocation.shell,
						windowsVerbatimArguments: invocation.windowsVerbatimArguments,
						stdout: reporter ? null : undefined,
						stderr: reporter ? null : undefined,
					},
				);
				reporter?.onCommandComplete?.({
					run,
					stage: "preflight",
					commandResult,
				});
				if (commandResult.exitCode !== 0) {
					const result = {
						workspace: run.workspace.cwd,
						tier: currentTier,
						stage: "preflight",
						command: invocation.command,
						args: invocation.args,
						exitCode: commandResult.exitCode,
						output: commandResult.output,
						failure: classifyFailure({
							stage: "preflight",
							exitCode: commandResult.exitCode,
							output: commandResult.output,
						}),
						durationMs: Math.max(0, now() - startedAt),
					};
					reporter?.onRunComplete?.(run, result);
					return result;
				}
			}
			const relatedFiles =
				relatedFilesByWorkspace?.[normalizeRelPath(run.workspace.cwd)];
			const pnpmArgs = buildPnpmArgs(
				root,
				run.workspace,
				run.tierConfig.command,
				run.tierConfig,
				fileCheck.selected,
				Array.isArray(relatedFiles) ? relatedFiles : undefined,
			);
			const invocation = resolvePnpmInvocation(pnpmArgs);
			const commandResult = await runCommandImpl(
				invocation.command,
				invocation.args,
				{
					cwd,
					env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
					shell: invocation.shell,
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
					stdout: reporter ? null : undefined,
					stderr: reporter ? null : undefined,
				},
			);
			reporter?.onCommandComplete?.({
				run,
				stage: "test",
				commandResult,
			});
			const result = {
				workspace: run.workspace.cwd,
				tier: currentTier,
				stage: "test",
				command: invocation.command,
				args: invocation.args,
				exitCode: commandResult.exitCode,
				output: commandResult.output,
				failure: classifyFailure({
					stage: "test",
					exitCode: commandResult.exitCode,
					output: commandResult.output,
				}),
				durationMs: Math.max(0, now() - startedAt),
			};
			reporter?.onRunComplete?.(run, result);
			return result;
			},
		);
		results.push(...tierResults.filter(Boolean));
	}
	return results;
}

export function printSummary(results, manifest) {
	console.log("\nTest workspace summary\n");
	for (const result of results) {
		const status = result.exitCode === 0 ? "PASS" : `FAIL ${result.failure}`;
		const workspaceCwd = result.workspace?.cwd ?? result.workspace;
		const elapsed =
			Number.isFinite(result.durationMs)
				? ` (${formatElapsed(result.durationMs)})`
				: "";
		console.log(`${status} ${workspaceCwd} ${result.tier}${elapsed}`);
		if (result.command)
			console.log(`  command: ${[result.command, ...(result.args ?? [])].join(" ")}`);
	}
	for (const workspace of manifest.workspaces) {
		if (workspace.status !== "required")
			console.log(`SKIP ${workspace.cwd} ${workspace.status}: ${workspace.reason}`);
		for (const [tier, tierConfig] of Object.entries(workspace.tiers ?? {})) {
			if (tierConfig.status === "deferred")
				console.log(`DEFER ${workspace.cwd} ${tier}: ${tierConfig.reason}`);
		}
	}
}

export function createRepoGitRunner(root = ROOT) {
	return (args) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
}

export async function runRootTestRunner({
	root = ROOT,
	runCommandImpl = runCommand,
	now = Date.now,
} = {}) {
	console.log("START test:runner");
	const startedAt = now();
	const invocation = resolvePnpmInvocation(["run", "test:runner"]);
	const commandResult = await runCommandImpl(
		invocation.command,
		invocation.args,
		{
			cwd: root,
			env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
			shell: invocation.shell,
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		},
	);
	const status = commandResult.exitCode === 0 ? "PASS" : "FAIL";
	console.log(
		`${status} test:runner (${formatElapsed(Math.max(0, now() - startedAt))})`,
	);
	return commandResult;
}

function intersectRelatedRuns(runs, requested, manifestWorkspaces) {
	if (requested.length === 0) return runs;
	return runs.filter((run) => {
		const workspace = manifestWorkspaces.find(
			(item) => normalizeRelPath(item.cwd) === normalizeRelPath(run.cwd),
		);
		return (
			workspace &&
			requested.some((selector) => workspaceMatchesSelector(workspace, selector))
		);
	});
}

async function main() {
	const options = parseCliOptions(process.argv.slice(2));
	const {
		all,
		tier,
		excludeWorkspaces,
		workspaceConcurrency,
		noLock,
		related,
	} = options;
	let workspaces = options.workspaces;
	let relatedFilesByWorkspace;
	let relatedPlan;

	if (related) {
		const manifest = (await import("./test-workspaces.config.mjs")).default;
		relatedPlan = createRelatedUnitPlan({
			root: ROOT,
			manifest,
			runGit: createRepoGitRunner(ROOT),
		});
		console.log(`RELATED ${relatedPlan.mode}: ${relatedPlan.reason}`);
		if (relatedPlan.mode === "skip") return;
		if (relatedPlan.mode === "related") {
			const selectedRuns = intersectRelatedRuns(
				relatedPlan.runs,
				workspaces,
				manifest.workspaces,
			);
			workspaces = selectedRuns.map((run) => run.cwd);
			relatedFilesByWorkspace = Object.fromEntries(
				selectedRuns.map((run) => [run.cwd, run.relatedFiles]),
			);
		}
	}

	const willRunWorkspaces =
		!related ||
		relatedPlan?.mode === "full" ||
		workspaces.length > 0;
	const willRunTestRunner =
		related &&
		(relatedPlan?.mode === "full" || relatedPlan?.runTestRunner);
	if (related && !willRunWorkspaces && !willRunTestRunner) return;

	const lock = shouldUseTestGateLock({ all, tier, noLock })
		? await acquireTestGateLock({
				repoRoot: ROOT,
				owner: {
					pid: process.pid,
					tier: all ? "all" : tier,
					cwd: ROOT,
					startedAt: new Date().toISOString(),
				},
			})
		: null;
	try {
		if (willRunTestRunner) {
			const runnerResult = await runRootTestRunner();
			if (runnerResult.exitCode !== 0) {
				process.exitCode = 1;
				return;
			}
		}
		if (!willRunWorkspaces) return;

		const manifest = (await import("./test-workspaces.config.mjs")).default;
		const results = await runPlannedTests({
			root: ROOT,
			manifest,
			tier,
			all,
			workspaces,
			excludeWorkspaces,
			workspaceConcurrency,
			relatedFilesByWorkspace,
			reporter: createWorkspaceRunReporter(),
		});
		printSummary(results, manifest);
		if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
	} finally {
		await lock?.release();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// A supervising terminal/tool may close its output pipe while the workspace
	// child keeps running. Keep later summary writes from crashing on EPIPE;
	// unexpected stream failures remain fatal.
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", (error) => {
			if (error?.code !== "EPIPE") throw error;
		});
	}
	main().catch((error) => {
		console.error(error);
		process.exitCode = error?.exitCode ?? 1;
	});
}
