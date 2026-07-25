import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import manifest from "../test-workspaces.config.mjs";
import {
	buildPnpmArgs,
	checkIncludeCoverage,
	checkTestFiles,
	classifyFailure,
	createOutputForwarder,
	discoverTestFiles,
	expandWorkspacePatterns,
	filterRunsByWorkspace,
	normalizeRelPath,
	parseWorkspacePatterns,
	parseCliOptions,
	parseWorkspaceSelectorValue,
	planRuns,
	printSummary,
	resolvePnpmInvocation,
	resolveOutputStream,
	runCommand,
	runPlannedTests,
	selectFilesForTier,
	validateManifest,
	validateManifestCoverage,
} from "../test-workspaces.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readRootScripts() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
		.scripts;
}

function readWorkspacePackageJson(cwd) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, cwd, "package.json"), "utf8"));
}

test("parseWorkspacePatterns reads pnpm-workspace.yaml package globs", () => {
	assert.deepEqual(
		parseWorkspacePatterns('packages:\n  - "apps/*"\n  - "packages/*"\n'),
		["apps/*", "packages/*"],
	);
});

test("root unit and all scripts run runner self-tests before workspace sweep", () => {
	const scripts = readRootScripts();
	assert.match(
		scripts["test:unit"],
		/^pnpm test:runner && node scripts\/test-workspaces\.mjs --tier unit$/,
	);
	assert.match(
		scripts["test:all"],
		/^pnpm test:runner && node scripts\/test-workspaces\.mjs --all$/,
	);
});

test("root db and guard delegate to the workspace runner", () => {
	const scripts = readRootScripts();
	assert.equal(
		scripts["test:db"],
		"pnpm test:runner && node scripts/test-workspaces.mjs --tier db",
	);
	assert.equal(scripts["test:guard"], "node scripts/test-workspaces.mjs --tier guard");
});

test("help groups copyable desktop, binary, and Mobile workflows", async () => {
	const { printHelp } = await import("../help.mjs");
	const lines = [];
	printHelp((line = "") => lines.push(line));
	const output = lines.join("\n");
	const rootScripts = Object.keys(readRootScripts());
	const documentedWorkflowScripts = rootScripts.filter((name) =>
		/^(mobile:xcode|mobile:sim:|mobile:build:(ios|android))/.test(name) ||
		/^(install:(agent-binaries|claude|codex|ripgrep)|update:(vendors|claude|codex|ripgrep))$/.test(name) ||
		/^release:(claude-code|codex|ripgrep)(:arm64|:x64|:win)?$/.test(name),
	);
	assert.deepEqual(
		documentedWorkflowScripts.filter((name) => !output.includes(`pnpm ${name}`)),
		[],
		"pnpm h must include every user-facing Mobile and binary workflow",
	);

	for (const command of [
		"pnpm dev:desktop:remote --region=global",
		"pnpm install:agent-binaries",
		"pnpm mobile:build:ios -- --region cn --execute",
		"pnpm mobile:build:android -- --region cn --execute",
	]) {
		assert.match(output, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(output, /pnpm test:guard/);
});

test("orca workflow unit tier uses its own declared test runner", () => {
	const orcaPackage = readWorkspacePackageJson("packages/orca-workflow");
	const orcaWorkspace = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/orca-workflow",
	);
	assert.equal(orcaPackage.scripts.test, "vitest run");
	assert.equal(orcaPackage.devDependencies.vitest, "^3.2.4");
	assert.deepEqual(orcaWorkspace.tiers.unit.command, {
		type: "packageScript",
		script: "test",
	});
});

test("normalizeRelPath makes path matching independent of host path separators", () => {
	assert.equal(
		normalizeRelPath("apps\\desktop\\src\\main\\foo.test.ts"),
		"apps/desktop/src/main/foo.test.ts",
	);
});

test("validateManifestCoverage fails when a pnpm workspace is missing", () => {
	assert.throws(
		() =>
			validateManifestCoverage(
				["apps/desktop", "apps/server"],
				[{ cwd: "apps/desktop" }],
			),
		/Manifest is missing pnpm workspace: apps\/server/,
	);
});

test("discoverTestFiles ignores generated and nested non-workspace directories", () => {
	const files = [
		"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		"packages/orca-workflow/node_modules/@cindy/maker-core/src/session.test.ts",
		"apps/server/release/src/__tests__/ignored.test.ts",
		"apps/desktop/cindy-updater/src/__tests__/ignored.test.ts",
		"apps/server/src/__tests__/services/oss.spec.ts",
		"packages/generated/src/__tests__/ignored.test.ts",
		"apps/desktop/src/renderer/__tests__/automationGeneratedSessions.test.ts",
	];
	assert.deepEqual(discoverTestFiles(files), [
		"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		"apps/server/src/__tests__/services/oss.spec.ts",
		"apps/desktop/src/renderer/__tests__/automationGeneratedSessions.test.ts",
	]);
});

test("checkTestFiles fails runnable tiers with no selected tests", () => {
	const workspace = { cwd: "packages/orca-workflow", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.throws(
		() => checkTestFiles(workspace, "unit", tier, []),
		/No tests selected for runnable tier packages\/orca-workflow unit/,
	);
});

test("checkTestFiles skips notApplicable workspace with reason", () => {
	const workspace = {
		cwd: "apps/heartbeat-server",
		status: "notApplicable",
		reason: "No tests yet",
		tiers: {},
	};
	assert.deepEqual(checkTestFiles(workspace, "unit", undefined, []), {
		status: "skipped",
		reason: "No tests yet",
	});
});

test("checkIncludeCoverage catches spec files missed by include patterns", () => {
	const workspace = { cwd: "apps/server", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.throws(
		() =>
			checkIncludeCoverage(workspace, "unit", tier, [
				"apps/server/src/__tests__/services/oss.spec.ts",
			]),
		/not covered by manifest include\/exclude/,
	);
});

test("checkIncludeCoverage allows explicit allowlist tiers", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		coverage: "allowlist",
		include: ["src/main/__tests__/directSessionSendGuard.test.ts"],
	};
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "guard", tier, [
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		]),
	);
});

test("checkIncludeCoverage catches allowlist include patterns that match no tests", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		coverage: "allowlist",
		include: [
			"src/main/__tests__/directSessionSendGuard.test.ts",
			"src/main/__tests__/makerSendToSessionOrdering.test.ts",
		],
	};
	assert.throws(
		() =>
			checkIncludeCoverage(workspace, "guard", tier, [
				"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			]),
		/apps\/desktop guard allowlist include matched no tests: src\/main\/__tests__\/makerSendToSessionOrdering\.test\.ts/,
	);
});

test("include patterns match direct and nested test files", () => {
	const workspace = { cwd: "apps/server", status: "required" };
	const tier = {
		status: "required",
		include: ["src/__tests__/**/*.{test,spec}.ts"],
	};
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "unit", tier, [
			"apps/server/src/__tests__/sessions.test.ts",
			"apps/server/src/__tests__/services/oss.spec.ts",
		]),
	);
});

test("single-level include pattern matches orca workflow test file", () => {
	const workspace = { cwd: "packages/orca-workflow", status: "required" };
	const tier = { status: "required", include: ["src/__tests__/**/*.test.ts"] };
	assert.doesNotThrow(() =>
		checkIncludeCoverage(workspace, "unit", tier, [
			"packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts",
		]),
	);
});

test("desktop unit excludes migration, direct db-tier, and source-contract guard tests while keeping normal unit tests", () => {
	const workspace = { cwd: "apps/desktop", status: "required" };
	const tier = {
		status: "required",
		exclude: [
			"src/main/localDb/**",
			"src/main/__tests__/*Migration.test.ts",
			"src/main/__tests__/schemaDriftRepair.test.ts",
			"src/main/__tests__/betterSqliteFactory.test.ts",
			"src/main/__tests__/*LocalSessions.test.ts",
			"src/main/__tests__/codexHistoryPromptInit.test.ts",
			"src/main/__tests__/orcaStaleIndexCleanup.test.ts",
			"src/main/scheduler-host/__tests__/*.db.test.ts",
			"src/main/__tests__/directSessionSendGuard.test.ts",
			"src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"**/*.bench.ts",
		],
	};
	assert.deepEqual(
		selectFilesForTier(workspace, tier, [
			"apps/desktop/src/main/localDb/ipc/messages.test.ts",
			"apps/desktop/src/main/__tests__/sessionWorkspaceKindMigration.test.ts",
			"apps/desktop/src/main/__tests__/codexProjectlessMigration.test.ts",
			"apps/desktop/src/main/__tests__/schemaDriftRepair.test.ts",
			"apps/desktop/src/main/__tests__/betterSqliteFactory.test.ts",
			"apps/desktop/src/main/__tests__/codexLocalSessions.test.ts",
			"apps/desktop/src/main/__tests__/claudeLocalSessions.test.ts",
			"apps/desktop/src/main/__tests__/codexHistoryPromptInit.test.ts",
			"apps/desktop/src/main/__tests__/orcaStaleIndexCleanup.test.ts",
			"apps/desktop/src/main/scheduler-host/__tests__/storage.db.test.ts",
			"apps/desktop/src/main/scheduler-host/__tests__/storage.test.ts",
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		]),
		[
			"apps/desktop/src/main/scheduler-host/__tests__/storage.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
		],
	);
});

test("desktop guard selects source-contract tests only", () => {
	const workspace = manifest.workspaces.find(
		(candidate) => candidate.cwd === "apps/desktop",
	);
	const tier = workspace.tiers.guard;
	assert.equal(tier.status, "required");
	assert.equal(tier.coverage, "allowlist");
	assert.deepEqual(
		selectFilesForTier(workspace, tier, [
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
			"apps/desktop/src/main/localDb/ipc/messages.test.ts",
		]),
		[
			"apps/desktop/src/main/__tests__/directSessionSendGuard.test.ts",
			"apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts",
		],
	);
});

test("manifest reasons use current local-test terminology", () => {
	const manifestText = JSON.stringify(manifest);
	assert.doesNotMatch(manifestText, /Phase 1/);
	assert.doesNotMatch(manifestText, /uses Electron and DB worker setup/);

	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	assert.match(desktop.tiers.db.reason, /explicit DB tier/);
	assert.match(desktop.tiers.migration.reason, /explicit DB tier/);
});

test("desktop DB tiers are explicit manual tiers outside test:all", () => {
	const desktopPackage = readWorkspacePackageJson("apps/desktop");
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	assert.equal(desktop.tiers.db.status, "manual");
	assert.equal(desktop.tiers.db.coverage, "allowlist");
	assert.deepEqual(desktop.tiers.db.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run"],
	});
	assert.match(
		desktop.tiers.db.include.join("\n"),
		/src\/main\/scheduler-host\/__tests__\/\*\.db\.test\.ts/,
	);
	assert.match(desktopPackage.scripts["test:db"], /test-workspaces\.mjs --tier db/);
	assert.doesNotMatch(desktopPackage.scripts["test:db"], /test:db-proxy-perf/);
	assert.equal(desktop.tiers.migration.status, "manual");
	assert.deepEqual(desktop.tiers.migration.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run"],
	});
	assert.equal(desktop.tiers["db-perf"].status, "manual");
	assert.deepEqual(desktop.tiers["db-perf"].command, {
		type: "packageScript",
		script: "test:db-proxy-perf",
	});
});

test("validateManifest rejects invalid status and missing reason", () => {
	assert.throws(
		() => validateManifest([{ cwd: "x", status: "invalid", tiers: {} }]),
		/has invalid status/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: { unit: { status: "invalid" } },
				},
			]),
		/unit has invalid status/,
	);
	assert.throws(
		() => validateManifest([{ cwd: "x", status: "notApplicable", tiers: {} }]),
		/requires reason/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: { unit: { status: "required" } },
				},
			]),
		/requires command/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						unit: {
							status: "required",
							coverage: "invalid",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/unit has invalid coverage mode/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						guard: {
							status: "required",
							coverage: "allowlist",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/guard allowlist coverage requires include patterns/,
	);
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "x",
					status: "required",
					tiers: {
						db: {
							status: "manual",
							reason: "Runs explicitly",
						},
					},
				},
			]),
		/x db requires command/,
	);
});

test("validateManifest rejects runnable tiers on non-required workspaces", () => {
	assert.throws(
		() =>
			validateManifest([
				{
					cwd: "packages/x",
					status: "notApplicable",
					reason: "No tests yet",
					tiers: {
						unit: {
							status: "required",
							command: { type: "packageScript", script: "test" },
						},
					},
				},
			]),
		/packages\/x unit cannot be runnable when workspace status is notApplicable/,
	);
});

test("planRuns rejects desktop unit if it directly uses package test script", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageScript", script: "test" },
				},
			},
		},
	];
	assert.throws(
		() => planRuns(workspaces, { tier: "unit" }),
		/desktop unit cannot use package test script/,
	);
});

test("planRuns skips deferred tiers and includes required tiers", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageBin", bin: "vitest", args: ["run"] },
				},
				db: { status: "deferred", reason: "later", existingScript: "test:db" },
			},
		},
	];
	assert.equal(planRuns(workspaces, { tier: "unit" }).length, 1);
	assert.equal(planRuns(workspaces, { tier: "db" }).length, 0);
});

test("planRuns includes manual tiers only for explicit tier runs", () => {
	const workspaces = [
		{
			cwd: "apps/desktop",
			status: "required",
			tiers: {
				unit: {
					status: "required",
					command: { type: "packageBin", bin: "vitest", args: ["run"] },
				},
				db: {
					status: "manual",
					reason: "Runs explicitly",
					command: { type: "packageScript", script: "test:db" },
				},
			},
		},
	];
	assert.equal(planRuns(workspaces, { tier: "db" }).length, 1);
	assert.equal(planRuns(workspaces, { tier: "db", explicit: false }).length, 0);
});

test("planRuns includes the required desktop guard tier", () => {
	const runs = planRuns(manifest.workspaces, { tier: "guard" });
	assert.deepEqual(
		runs.map((run) => [run.workspace.cwd, run.tier]),
		[["apps/desktop", "guard"]],
	);
});

test("filterRunsByWorkspace selects by manifest name or cwd and supports exclude", () => {
	const runs = planRuns(manifest.workspaces, { tier: "unit" });
	assert.deepEqual(
		filterRunsByWorkspace(runs, { workspaces: ["desktop"] }).map(
			(run) => run.workspace.cwd,
		),
		["apps/desktop"],
	);
	assert.deepEqual(
		filterRunsByWorkspace(runs, {
			workspaces: ["apps/desktop", "mobile"],
			excludeWorkspaces: ["desktop"],
		}).map((run) => run.workspace.cwd),
		["apps/mobile"],
	);
});

test("expandWorkspacePatterns supports nested submodule package roots", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-patterns-"));
	try {
		const pkg = path.join(root, "cindy-protocol", "packages", "protocol-a");
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"protocol-a"}\n');
		assert.deepEqual(expandWorkspacePatterns(root, ["cindy-protocol/packages/*"]), [
			"cindy-protocol/packages/protocol-a",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("parseCliOptions rejects --tier without a value", () => {
	assert.throws(
		() => parseCliOptions(["--tier"]),
		/--tier requires a value/,
	);
	assert.deepEqual(parseCliOptions([]), {
		all: false,
		tier: "unit",
		workspaces: [],
		excludeWorkspaces: [],
	});
});

test("parseCliOptions supports workspace include and exclude selectors", () => {
	assert.deepEqual(
		parseCliOptions([
			"--tier",
			"unit",
			"--workspace",
			"desktop,apps/server",
			"--workspace",
			"@cindy/maker-core",
			"--exclude-workspace",
			"packages/orca-workflow",
		]),
		{
			all: false,
			tier: "unit",
			workspaces: ["desktop", "apps/server", "@cindy/maker-core"],
			excludeWorkspaces: ["packages/orca-workflow"],
		},
	);
	assert.deepEqual(parseWorkspaceSelectorValue(" desktop, apps/server "), [
		"desktop",
		"apps/server",
	]);
	assert.throws(
		() => parseCliOptions(["--workspace", ","]),
		/--workspace requires a value/,
	);
});

test("resolvePnpmInvocation uses current pnpm through node when npm_execpath is present on any platform", () => {
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "apps/server", "run", "test"], {
			execPath: "C:/node/node.exe",
			npmExecPath: "C:/pnpm/pnpm.cjs",
			platform: "win32",
		}),
		{
			command: "C:/node/node.exe",
			args: ["C:/pnpm/pnpm.cjs", "--dir", "apps/server", "run", "test"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "/repo/apps/server", "run", "test"], {
			execPath: "/usr/local/bin/node",
			npmExecPath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
			platform: "darwin",
		}),
		{
			command: "/usr/local/bin/node",
			args: [
				"/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
				"--dir",
				"/repo/apps/server",
				"run",
				"test",
			],
			shell: false,
		},
	);
});

test("resolvePnpmInvocation fallback shell behavior is explicit per platform", () => {
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			platform: "win32",
		}),
		{ command: "pnpm", args: ["--version"], shell: true },
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			platform: "darwin",
		}),
		{ command: "pnpm", args: ["--version"], shell: false },
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			platform: "linux",
		}),
		{ command: "pnpm", args: ["--version"], shell: false },
	);
});

test("classifyFailure distinguishes no tests and collect failures conservatively", () => {
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "No test files found",
		}),
		"NO_TESTS_REQUIRED",
	);
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "Failed Suites 3\nCannot find module",
		}),
		"TEST_COLLECT_FAILED",
	);
	assert.equal(
		classifyFailure({
			stage: "test",
			exitCode: 1,
			output: "FAIL expected value\nTest timed out in 5000ms",
		}),
		"TEST_ASSERTION_FAILED",
	);
});

test("runCommand resolves spawn errors as failed command results", async () => {
	const result = await runCommand("__xdmaker_missing_command__", [], {
		shell: false,
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.output, /ENOENT|not found|找不到|无法|spawn/i);
});

test("createOutputForwarder stops writing after EPIPE without treating it as a command failure", () => {
	class FakeStream extends EventEmitter {
		writes = [];
		write(chunk) {
			this.writes.push(chunk.toString());
		}
	}
	const stream = new FakeStream();
	const forwarder = createOutputForwarder(stream);
	forwarder.write(Buffer.from("before"));
	stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
	assert.doesNotThrow(() => forwarder.write(Buffer.from("after")));
	assert.deepEqual(stream.writes, ["before"]);
	assert.equal(forwarder.finish(), null);
});

test("resolveOutputStream preserves explicit null while defaulting undefined", () => {
	const fallback = new EventEmitter();
	assert.equal(resolveOutputStream(undefined, fallback), fallback);
	assert.equal(resolveOutputStream(null, fallback), null);
});

test("runCommand completes successfully when its output consumer closes with EPIPE", async () => {
	class ClosedStream extends EventEmitter {
		write() {}
	}
	const stream = new ClosedStream();
	const pending = runCommand(
		process.execPath,
		["-e", "setTimeout(() => process.stdout.write('child-finished'), 20)"],
		{ shell: false, stdout: stream, stderr: stream },
	);
	stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
	const result = await pending;
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /child-finished/);
});

test("runPlannedTests skips test command when preflight fails", async () => {
	const calls = [];
	const manifest = {
		workspaces: [
			{
				name: "server",
				cwd: "apps/server",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						preflight: [{ type: "packageScript", script: "db:generate" }],
						command: { type: "packageScript", script: "test" },
					},
				},
			},
		],
	};
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["apps/server"],
		allFiles: ["apps/server/src/__tests__/sessions.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd });
			return { exitCode: 1, output: "generate failed" };
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(normalizeRelPath(calls[0].cwd), "F:/repo/apps/server");
	assert.equal(result[0].stage, "preflight");
	assert.equal(result[0].failure, "PREFLIGHT_FAILED");
});

test("runPlannedTests filters workspaces after full manifest coverage validation", async () => {
	const fakeManifest = {
		workspaces: [
			{
				name: "desktop",
				cwd: "apps/desktop",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
			{
				name: "server",
				cwd: "apps/server",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageScript", script: "test" },
					},
				},
			},
		],
	};
	const common = {
		root: "/repo",
		manifest: fakeManifest,
		workspaceCwds: ["apps/desktop", "apps/server"],
		allFiles: [
			"apps/desktop/src/main/__tests__/lifecycle.test.ts",
			"apps/server/src/__tests__/sessions.test.ts",
		],
		runCommandImpl: async () => ({ exitCode: 0, output: "ok" }),
	};

	const desktopOnly = await runPlannedTests({
		...common,
		tier: "unit",
		workspaces: ["desktop"],
	});
	assert.deepEqual(
		desktopOnly.map((result) => result.workspace),
		["apps/desktop"],
	);

	const restOnly = await runPlannedTests({
		...common,
		tier: "unit",
		excludeWorkspaces: ["apps/desktop"],
	});
	assert.deepEqual(
		restOnly.map((result) => result.workspace),
		["apps/server"],
	);

	await assert.rejects(
		() =>
			runPlannedTests({
				...common,
				workspaceCwds: ["apps/desktop"],
				tier: "unit",
				workspaces: ["desktop"],
			}),
		/Manifest declares non-pnpm workspace: apps\/server/,
	);
	await assert.rejects(
		() =>
			runPlannedTests({
				...common,
				tier: "unit",
				workspaces: ["missing"],
			}),
		/--workspace matched no workspace: missing/,
	);
});

test("runPlannedTests continues after one workspace test fails", async () => {
	const manifest = {
		workspaces: [
			{
				name: "a",
				cwd: "packages/a",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
			{
				name: "b",
				cwd: "packages/b",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
		],
	};
	let index = 0;
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/a", "packages/b"],
		allFiles: ["packages/a/a.test.ts", "packages/b/b.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async () =>
			index++ === 0
				? { exitCode: 1, output: "FAIL expected" }
				: { exitCode: 0, output: "PASS" },
	});
	assert.equal(result.length, 2);
	assert.equal(result[0].failure, "TEST_ASSERTION_FAILED");
	assert.equal(result[1].exitCode, 0);
});

test("runPlannedTests passes selected include files to packageBin commands", async () => {
	const calls = [];
	const manifest = {
		workspaces: [
			{
				name: "orca",
				cwd: "packages/orca-workflow",
				status: "required",
				tiers: {
					unit: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
						include: ["src/__tests__/**/*.test.ts"],
					},
				},
			},
		],
	};
	await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/orca-workflow"],
		allFiles: ["packages/orca-workflow/src/__tests__/orca-bridge-mcp.test.ts"],
		manifest,
		tier: "unit",
		runCommandImpl: async (command, args) => {
			calls.push({ command, args });
			return { exitCode: 0, output: "PASS" };
		},
	});
	assert.deepEqual(calls[0].args.slice(-1), [
		"src/__tests__/orca-bridge-mcp.test.ts",
	]);
	assert.equal(calls[0].args.includes("src/__tests__/**/*.test.ts"), false);
});

test("buildPnpmArgs rejects selected files outside the workspace", () => {
	assert.throws(
		() =>
			buildPnpmArgs(
				"F:/repo",
				{ cwd: "packages/orca-workflow" },
				{ type: "packageBin", bin: "vitest", args: ["run"] },
				{ include: ["src/__tests__/**/*.test.ts"] },
				["packages/other/src/foo.test.ts"],
			),
		/Selected test file is outside workspace packages\/orca-workflow: packages\/other\/src\/foo\.test\.ts/,
	);
});

test("runPlannedTests all mode runs required configured tiers and skips manual tiers", async () => {
	const manifest = {
		workspaces: [
			{
				name: "a",
				cwd: "packages/a",
				status: "required",
				tiers: {
					smoke: {
						status: "required",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
					heavy: {
						status: "manual",
						reason: "Run explicitly",
						command: { type: "packageBin", bin: "vitest", args: ["run"] },
					},
				},
			},
		],
	};
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: ["packages/a"],
		allFiles: ["packages/a/a.test.ts"],
		manifest,
		all: true,
		runCommandImpl: async () => ({ exitCode: 0, output: "PASS" }),
	});
	assert.equal(result.length, 1);
	assert.equal(result[0].tier, "smoke");
});

test("runPlannedTests rejects explicit tiers with no runnable runs", async () => {
	const manifest = {
		workspaces: [
			{
				name: "desktop",
				cwd: "apps/desktop",
				status: "required",
				tiers: {
					db: {
						status: "deferred",
						reason: "Uses existing desktop script",
						existingScript: "test:db",
					},
				},
			},
		],
	};
	await assert.rejects(
		() =>
			runPlannedTests({
				root: "F:/repo",
				workspaceCwds: ["apps/desktop"],
				allFiles: [],
				manifest,
				tier: "db",
			}),
		/No runnable test runs configured for tier db/,
	);
});

test("printSummary includes complete command line and skipped workspaces", () => {
	const logs = [];
	const originalLog = console.log;
	console.log = (message) => {
		logs.push(message);
	};
	try {
		printSummary(
			[
				{
					workspace: "apps/server",
					tier: "unit",
					exitCode: 1,
					failure: "TEST_ASSERTION_FAILED",
					command: "pnpm",
					args: ["--dir", "F:/repo/apps/server", "run", "test"],
				},
			],
			{
				workspaces: [
					{
						cwd: "apps/heartbeat-server",
						status: "notApplicable",
						reason: "No tests yet",
						tiers: {},
					},
				],
			},
		);
	} finally {
		console.log = originalLog;
	}
	const output = logs.join("\n");
	assert.match(output, /FAIL TEST_ASSERTION_FAILED apps\/server unit/);
	assert.match(output, /command: pnpm --dir F:\/repo\/apps\/server run test/);
	assert.match(
		output,
		/SKIP apps\/heartbeat-server notApplicable: No tests yet/,
	);
});
