import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import manifest, {
	desktopUnitWorkerCount,
} from "../test-workspaces.config.mjs";
import { nodeWebstorageEnabled } from "../shared/node-webstorage.mjs";
import {
	acquireTestGateLock,
	classifyTestGateLockProbeError,
	decideTestGateLock,
	resolveTestGateCommonDir,
	shouldUseTestGateLock,
	TEST_GATE_LOCK_TIMEOUT_EXIT_CODE,
	testGateLockIdentity,
} from "../test-gate-lock.mjs";
import {
	buildPnpmArgs,
	checkIncludeCoverage,
	checkTestFiles,
	classifyFailure,
	createBoundedOutputBuffer,
	createOutputForwarder,
	createWorkspaceRunReporter,
	defaultWorkspaceConcurrency,
	discoverTestFiles,
	expandWorkspacePatterns,
	filterRunsByWorkspace,
	mapWithConcurrency,
	normalizeRelPath,
	parseWorkspacePatterns,
	parseCliOptions,
	parseWorkspaceConcurrency,
	parseWorkspaceSelectorValue,
	planRuns,
	printSummary,
	readAllFiles,
	resolveOutputStream,
	runCommand,
	runPlannedTests,
	runWithExclusiveBarriers,
	selectFilesForTier,
	validateManifest,
	validateManifestCoverage,
} from "../test-workspaces.mjs";
import {
	resolvePnpmInvocation,
	usablePnpmExecPath,
} from "../shared/pnpm-invocation.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readRootScripts() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
		.scripts;
}

function readWorkspacePackageJson(cwd) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, cwd, "package.json"), "utf8"));
}

async function waitFor(predicate, message = "condition was not reached") {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
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
		scripts["test:git-integration"],
		"pnpm test:runner && node scripts/test-workspaces.mjs --tier git-integration",
	);
	assert.equal(
		scripts["test:db"],
		"pnpm test:runner && node scripts/test-workspaces.mjs --tier db",
	);
	assert.equal(scripts["test:guard"], "node scripts/test-workspaces.mjs --tier guard");
});

test("client CI owns the complete Desktop Git integration tier", () => {
	const workflow = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	).replace(/\r\n/g, "\n");
	const job = workflow.match(/\n  git-integration:\n([\s\S]*)$/);
	assert.ok(job, "client CI must define an independent git-integration job");
	assert.match(
		job[1],
		/^\s{6}- name: Run Desktop Git integration tests\n\s{8}run: pnpm test:git-integration$/m,
	);
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
		"pnpm dev:desktop:remote",
		"pnpm dev:desktop:remote --region=cn",
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
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--pool=threads", "--maxWorkers=1"],
	});
});

test("unit workspace concurrency reserves the full worker budget for heavy workspaces", () => {
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	const mobile = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/mobile",
	);
	const makerCore = manifest.workspaces.find(
		(workspace) => workspace.cwd === "packages/maker-core",
	);
	assert.equal(desktop.tiers.unit.execution, "exclusive");
	assert.deepEqual(desktop.tiers.unit.command.args, [
		"run",
		// win32 pins forks: threads segfaults the desktop suite there, and the
		// LaunchServices churn that threads exists to avoid is macOS-only.
		`--pool=${nodeWebstorageEnabled() || process.platform === "win32" ? "forks" : "threads"}`,
		`--maxWorkers=${desktopUnitWorkerCount()}`,
	]);
	assert.equal(desktopUnitWorkerCount(1), 1);
	assert.equal(desktopUnitWorkerCount(4), 4);
	assert.equal(desktopUnitWorkerCount(32), 8);
	assert.equal(desktopUnitWorkerCount(Number.NaN), 1);
	assert.equal(mobile.tiers.unit.execution, "exclusive");
	assert.deepEqual(mobile.tiers.unit.command.args, [
		"run",
		"--pool=threads",
		"--maxWorkers=4",
	]);
	assert.equal(makerCore.tiers.unit.execution, undefined);
	assert.deepEqual(makerCore.tiers.unit.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", "--pool=forks", "--maxWorkers=1"],
	});
});

test("unit tier pins an explicit vitest pool, forks only by documented exception", () => {
	// The default forks pool recycles one child process per test file, which on
	// 2026-07-30 sustained ~21 LaunchServices check-ins/second and took down
	// macOS 27.0 beta's launchservicesd mid-gate (empty running-application
	// registry -> no frontmost app -> dead keyboard, no menu bar, vanishing Dock
	// tiles). A workspace added later must not silently inherit that churn, and
	// opting back into forks must be a deliberate edit to this list.
	// Desktop's entry is conditional: it stays on forks on a Node whose
	// webstorage globals force the execArgv that worker threads cannot take,
	// and on win32, where threads segfaults the suite outright (native addon
	// finalizers crashing in isolate teardown) and no launchservicesd exists
	// for the churn to hurt.
	const forksByException = [
		...(nodeWebstorageEnabled() || process.platform === "win32"
			? ["apps/desktop"]
			: []),
		"packages/maker-core",
	];
	const unpinned = [];
	const onForks = [];
	for (const workspace of manifest.workspaces) {
		const tier = workspace.tiers?.unit;
		if (!tier || (tier.status !== "required" && tier.status !== "manual"))
			continue;
		if (tier.command?.type !== "packageBin" || tier.command.bin !== "vitest")
			continue;
		const args = tier.command.args ?? [];
		if (args.includes("--pool=forks")) onForks.push(workspace.cwd);
		else if (!args.includes("--pool=threads")) unpinned.push(workspace.cwd);
	}
	assert.deepEqual(unpinned, []);
	assert.deepEqual(onForks.sort(), [...forksByException].sort());
});

test("nodeWebstorageEnabled detects the globals that force the webstorage flag", () => {
	assert.equal(nodeWebstorageEnabled({}), false);
	assert.equal(nodeWebstorageEnabled({ localStorage: undefined }), false);
	assert.equal(nodeWebstorageEnabled({ localStorage: {} }), true);
	// Node 25's stub is an object whose methods are all missing; presence is what
	// matters here, because that alone displaces jsdom's implementation.
	assert.equal(
		nodeWebstorageEnabled({ localStorage: Object.create(null) }),
		true,
	);
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
			"**/*.git-integration.test.ts",
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
			"apps/desktop/src/main/git-review/__tests__/stageOps.git-integration.test.ts",
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

test("desktop real-Git coverage is an explicit coordinated tier outside default unit", () => {
	const desktopPackage = readWorkspacePackageJson("apps/desktop");
	const desktop = manifest.workspaces.find(
		(workspace) => workspace.cwd === "apps/desktop",
	);
	const tier = desktop.tiers["git-integration"];

	assert.equal(tier.status, "manual");
	assert.equal(tier.execution, "exclusive");
	assert.equal(tier.coverage, "allowlist");
	assert.deepEqual(tier.include, ["src/main/**/*.git-integration.test.ts"]);
	assert.deepEqual(tier.command, {
		type: "packageBin",
		bin: "vitest",
		args: ["run", `--maxWorkers=${desktopUnitWorkerCount()}`],
	});
	assert.match(
		desktopPackage.scripts["test:git-integration"],
		/test-workspaces\.mjs --tier git-integration/,
	);

	const files = [
		"apps/desktop/src/main/git-review/__tests__/stageOps.git-integration.test.ts",
		"apps/desktop/src/main/__tests__/gitSnapshotService.git-integration.test.ts",
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
	];
	assert.deepEqual(selectFilesForTier(desktop, desktop.tiers.unit, files), [
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
	]);
	assert.deepEqual(selectFilesForTier(desktop, tier, files), files.slice(0, 2));
});

test("default desktop unit keeps real Git subprocess coverage to one smoke", () => {
	const files = discoverTestFiles(readAllFiles(ROOT))
		.filter((file) =>
			file.startsWith("apps/desktop/src/main/") &&
			file.endsWith(".test.ts") &&
			!file.endsWith(".git-integration.test.ts"),
		)
		.filter((file) => /\b(?:runGit|gitExec)\(/.test(
			fs.readFileSync(path.join(ROOT, file), "utf8"),
		));

	assert.deepEqual(files, [
		"apps/desktop/src/main/git-review/__tests__/gitReviewSmoke.test.ts",
		// This file mocks child_process.spawn and tests the adapter itself.
		"apps/desktop/src/main/git-review/__tests__/gitRunner.test.ts",
	]);
});

test("tests never bind a fixed numeric port", () => {
	const violations = [];
	for (const file of discoverTestFiles(readAllFiles(ROOT))) {
		const source = fs.readFileSync(path.join(ROOT, file), "utf8");
		const directPort = /\.listen\s*\(\s*(\d+)/g;
		const objectPort = /\.listen\s*\(\s*\{[\s\S]{0,300}?\bport\s*:\s*(\d+)/g;
		for (const pattern of [directPort, objectPort]) {
			for (const match of source.matchAll(pattern)) {
				if (Number(match[1]) !== 0) violations.push(`${file}:${match[1]}`);
			}
		}
	}
	assert.deepEqual(violations, []);
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
							command: { type: "packageScript", script: "test" },
							execution: "parallel-ish",
						},
					},
				},
			]),
		/invalid execution mode/,
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
		workspaceConcurrency: undefined,
		noLock: false,
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
			workspaceConcurrency: undefined,
			noLock: false,
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

test("workspace concurrency defaults to a bounded CPU count and accepts both CLI forms", () => {
	assert.equal(defaultWorkspaceConcurrency(1), 1);
	assert.equal(defaultWorkspaceConcurrency(2), 2);
	assert.equal(defaultWorkspaceConcurrency(32), 4);
	assert.equal(defaultWorkspaceConcurrency(Number.NaN), 1);
	assert.equal(parseWorkspaceConcurrency("8"), 8);
	assert.equal(
		parseCliOptions(["--workspace-concurrency", "3"]).workspaceConcurrency,
		3,
	);
	assert.equal(
		parseCliOptions(["--", "--workspace-concurrency=2"]).workspaceConcurrency,
		2,
	);
	for (const value of ["0", "-1", "1.5", "nope", "999999999999999999999"]) {
		assert.throws(
			() => parseWorkspaceConcurrency(value),
			/requires a positive integer/,
		);
	}
	assert.throws(
		() => parseCliOptions(["--workspace-concurrency"]),
		/requires a positive integer/,
	);
	assert.equal(parseCliOptions(["--no-lock"]).noLock, true);
});

test("test gate lock covers heavy local tiers but skips guard, CI, and explicit bypass", () => {
	for (const tier of ["unit", "db", "git-integration"]) {
		assert.equal(shouldUseTestGateLock({ tier, env: {} }), true);
	}
	assert.equal(shouldUseTestGateLock({ all: true, env: {} }), true);
	assert.equal(shouldUseTestGateLock({ tier: "guard", env: {} }), false);
	assert.equal(
		shouldUseTestGateLock({ tier: "unit", noLock: true, env: {} }),
		false,
	);
	for (const env of [{ CI: "1" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
		assert.equal(shouldUseTestGateLock({ tier: "unit", env }), false);
	}
	assert.equal(
		shouldUseTestGateLock({ tier: "unit", env: { CI: "false" } }),
		true,
	);
});

test("test gate lock identity is stable per clone and normalizes Windows case", () => {
	assert.equal(
		testGateLockIdentity("C:\\Repo\\.git", "win32"),
		testGateLockIdentity("c:\\repo\\.git", "win32"),
	);
	assert.notEqual(
		testGateLockIdentity("/repo-a/.git", "linux"),
		testGateLockIdentity("/repo-b/.git", "linux"),
	);
});

test("test gate common-dir resolver joins worktrees from one clone without joining separate roots", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-common-dir-"));
	try {
		const commonDir = path.join(root, "common.git");
		const firstGitDir = path.join(commonDir, "worktrees", "first");
		const secondGitDir = path.join(commonDir, "worktrees", "second");
		const firstWorktree = path.join(root, "first");
		const secondWorktree = path.join(root, "second");
		const separateRoot = path.join(root, "separate");
		for (const directory of [
			firstGitDir,
			secondGitDir,
			firstWorktree,
			secondWorktree,
			separateRoot,
		]) {
			fs.mkdirSync(directory, { recursive: true });
		}
		fs.writeFileSync(path.join(firstWorktree, ".git"), `gitdir: ${firstGitDir}\n`);
		fs.writeFileSync(
			path.join(secondWorktree, ".git"),
			`gitdir: ${secondGitDir}\n`,
		);
		for (const gitDir of [firstGitDir, secondGitDir]) {
			fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		}

		const firstResolved = await resolveTestGateCommonDir(firstWorktree);
		const secondResolved = await resolveTestGateCommonDir(secondWorktree);
		const separateResolved = await resolveTestGateCommonDir(separateRoot);
		assert.equal(firstResolved, secondResolved);
		assert.notEqual(firstResolved, separateResolved);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock decision prefers an existing owner over an earlier free port", () => {
	const owner = { pid: 42, tier: "unit", cwd: "/repo/worktree-a" };
	assert.deepEqual(
		decideTestGateLock([
			{ port: 50_000, result: "available" },
			{ port: 50_001, result: "owner", owner },
		]),
		{ type: "wait", owner },
	);
	assert.deepEqual(
		decideTestGateLock([
			{ port: 50_000, result: "collision" },
			{ port: 50_001, result: "available" },
		]),
		{ type: "acquire", port: 50_001 },
	);
	assert.deepEqual(
		decideTestGateLock([{ port: 50_000, result: "collision" }]),
		{ type: "unavailable" },
	);
	assert.equal(classifyTestGateLockProbeError("ECONNREFUSED"), "available");
	assert.equal(classifyTestGateLockProbeError("ETIMEDOUT"), "collision");
});

test("test gate lock reports the holder, waits, and acquires after release", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-lock-"));
	let probeRound = 0;
	let now = 0;
	let listenedPort;
	const output = [];
	try {
		const lock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 99, tier: "db", cwd: root },
			timeoutMs: 1_000,
			retryDelayMs: 100,
			now: () => now,
			sleep: async (durationMs) => {
				now += durationMs;
			},
			probeCandidatesImpl: async (ports) => {
				probeRound += 1;
				if (probeRound === 1) {
					return [
						{ port: ports[0], result: "available" },
						{
							port: ports[1],
							result: "owner",
							owner: {
								pid: 42,
								tier: "unit",
								cwd: "/repo/worktree-a",
							},
						},
					];
				}
				return [{ port: ports[0], result: "available" }];
			},
			listenImpl: async (port) => {
				listenedPort = port;
				return { port, release: async () => {} };
			},
			output: (message) => output.push(message),
		});
		assert.equal(probeRound, 2);
		assert.equal(lock.port, listenedPort);
		assert.match(output.join("\n"), /pid 42, tier unit, cwd \/repo\/worktree-a/);
		await lock.release();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// A real probe round connects to every candidate port, and a port that accepts
// the connection without answering only resolves once the probe socket times
// out. So the window that waits for the WAIT report has to be far wider than a
// single probe round, otherwise a slow round loses the race and the assertion
// fails for reasons unrelated to the lock protocol.
const REAL_LOCK_WAIT_WINDOW_MS = 30_000;
const REAL_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

function raceWithDeadline(candidates, deadlineMs, deadlineValue) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(deadlineValue), deadlineMs);
	});
	return Promise.race([...candidates, deadline]).finally(() => {
		clearTimeout(timer);
	});
}

test("two real test gate lock holders serialize on the same identity", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-real-lock-"));
	let firstLock;
	let secondLockPromise;
	let reportWaiting;
	const waiting = new Promise((resolve) => {
		reportWaiting = resolve;
	});
	try {
		firstLock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 41, tier: "unit", cwd: path.join(root, "first") },
			output: () => {},
		});
		secondLockPromise = acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 42, tier: "db", cwd: path.join(root, "second") },
			timeoutMs: REAL_LOCK_ACQUIRE_TIMEOUT_MS,
			retryDelayMs: 10,
			output: reportWaiting,
		});
		// A failing assertion below jumps straight to `finally` while this
		// acquisition is still running. Attach a no-op handler so an eventual
		// rejection is never unhandled; the real await and release happen in
		// `finally`, otherwise a lock bound after the failure keeps its listener
		// open and `node --test` never exits.
		secondLockPromise.catch(() => {});

		const outcome = await raceWithDeadline(
			[waiting.then(() => "waiting"), secondLockPromise.then(() => "acquired")],
			REAL_LOCK_WAIT_WINDOW_MS,
			"timed-out",
		);
		assert.equal(outcome, "waiting");

		await firstLock.release();
		firstLock = undefined;
		const secondLock = await secondLockPromise;
		assert.ok(secondLock.port >= 49_152);
	} finally {
		// Order matters: releasing the first lock lets the second acquisition
		// settle immediately instead of waiting out its own timeout.
		await firstLock?.release();
		await secondLockPromise?.then(
			(lock) => lock.release(),
			() => {},
		);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock skips ports denied at bind time", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-bind-denied-"));
	const attemptedPorts = [];
	try {
		const lock = await acquireTestGateLock({
			repoRoot: root,
			owner: { pid: 99, tier: "unit", cwd: root },
			probeCandidatesImpl: async (ports) =>
				ports.map((port) => ({ port, result: "available" })),
			listenImpl: async (port) => {
				attemptedPorts.push(port);
				if (attemptedPorts.length === 1) {
					throw Object.assign(new Error("bind denied"), { code: "EACCES" });
				}
				return { port, release: async () => {} };
			},
			output: () => {},
		});

		assert.equal(attemptedPorts.length, 2);
		assert.notEqual(attemptedPorts[0], attemptedPorts[1]);
		assert.equal(lock.port, attemptedPorts[1]);
		await lock.release();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("test gate lock timeout uses a distinct temporary-failure exit code", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-timeout-"));
	let now = 0;
	try {
		await assert.rejects(
			() =>
				acquireTestGateLock({
					repoRoot: root,
					owner: { pid: 99, tier: "unit", cwd: root },
					timeoutMs: 100,
					retryDelayMs: 100,
					now: () => now,
					sleep: async (durationMs) => {
						now += durationMs;
					},
					probeCandidatesImpl: async (ports) => [
						{
							port: ports[0],
							result: "owner",
							owner: {
								pid: 42,
								tier: "unit",
								cwd: "/repo/worktree-a",
							},
						},
					],
					output: () => {},
				}),
			(error) => {
				assert.equal(error.exitCode, TEST_GATE_LOCK_TIMEOUT_EXIT_CODE);
				assert.match(error.message, /tests did not run/);
				return true;
			},
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolvePnpmInvocation uses current pnpm through node when npm_execpath points at a JS entry on any platform", () => {
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

test("resolvePnpmInvocation runs a native pnpm binary directly instead of feeding it to node", () => {
	// pnpm 的原生二进制发行版（standalone 安装）把 npm_execpath 指向可执行文件本身；
	// 交给 node 会抛 SyntaxError: Invalid or unexpected token，把整轮测试变成假失败。
	assert.deepEqual(
		resolvePnpmInvocation(["--dir", "/repo/apps/server", "run", "test"], {
			execPath: "/usr/local/bin/node",
			npmExecPath:
				"/Users/dev/Library/pnpm/.tools/@pnpm+macos-arm64/10.33.2/node_modules/@pnpm/macos-arm64/pnpm",
			platform: "darwin",
		}),
		{
			command:
				"/Users/dev/Library/pnpm/.tools/@pnpm+macos-arm64/10.33.2/node_modules/@pnpm/macos-arm64/pnpm",
			args: ["--dir", "/repo/apps/server", "run", "test"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "/usr/bin/node",
			npmExecPath: "/home/dev/.local/share/pnpm/pnpm",
			platform: "linux",
		}),
		{
			command: "/home/dev/.local/share/pnpm/pnpm",
			args: ["--version"],
			shell: false,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "C:/node/node.exe",
			npmExecPath: "C:/Users/dev/AppData/Local/pnpm/pnpm.exe",
			platform: "win32",
		}),
		{
			command: "C:/Users/dev/AppData/Local/pnpm/pnpm.exe",
			args: ["--version"],
			shell: false,
		},
	);
});

test("resolvePnpmInvocation invokes Windows command wrappers through cmd.exe", () => {
	// .cmd／.bat 通过 cmd.exe 执行，同时逐字传递 /c 命令串。
	for (const npmExecPath of [
		"C:/Program Files/nodejs/pnpm.cmd",
		"C:/Program Files/nodejs/pnpm.bat",
	]) {
		assert.deepEqual(
			resolvePnpmInvocation(["--version"], {
				execPath: "C:/node/node.exe",
				npmExecPath,
				platform: "win32",
				comSpec: "C:/Windows/System32/cmd.exe",
			}),
			{
				command: "C:/Windows/System32/cmd.exe",
				args: [
					"/d",
					"/s",
					"/v:off",
					"/c",
					'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%""',
				],
				env: {
					CINDY_PNPM_CMD_ARG_0: npmExecPath,
					CINDY_PNPM_CMD_ARG_1: "--version",
				},
				shell: false,
				windowsVerbatimArguments: true,
			},
		);
	}
});

test("resolvePnpmInvocation quotes Windows command wrapper arguments", () => {
	assert.deepEqual(
		resolvePnpmInvocation(
			[
				"--dir",
				'C:/Users/First Last/repo & "tools"!/%literal%/apps/server',
				"run",
				"test",
			],
			{
				npmExecPath: "C:/Program Files/nodejs/pnpm.cmd",
				platform: "win32",
				comSpec: "C:/Windows/System32/cmd.exe",
			},
		),
		{
			command: "C:/Windows/System32/cmd.exe",
			args: [
				"/d",
				"/s",
				"/v:off",
				"/c",
				'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%" "%CINDY_PNPM_CMD_ARG_2%" "%CINDY_PNPM_CMD_ARG_3%" "%CINDY_PNPM_CMD_ARG_4%""',
			],
			env: {
				CINDY_PNPM_CMD_ARG_0: "C:/Program Files/nodejs/pnpm.cmd",
				CINDY_PNPM_CMD_ARG_1: "--dir",
				CINDY_PNPM_CMD_ARG_2: 'C:/Users/First Last/repo & ""tools""!/%literal%/apps/server',
				CINDY_PNPM_CMD_ARG_3: "run",
				CINDY_PNPM_CMD_ARG_4: "test",
			},
			shell: false,
			windowsVerbatimArguments: true,
		},
	);
});

test("usablePnpmExecPath rejects paths that are not a present pnpm entry", () => {
	const present = () => true;
	assert.equal(usablePnpmExecPath(undefined, present), undefined);
	assert.equal(usablePnpmExecPath("", present), undefined);
	// 名字不是 pnpm：npm_execpath 可能残留自 npm／yarn 的生命周期脚本。
	assert.equal(usablePnpmExecPath("/usr/local/bin/npm-cli.js", present), undefined);
	// 路径不存在：Windows 的 restart 管线新开 cmd.exe 时见过残留的旧路径。
	assert.equal(usablePnpmExecPath("/gone/pnpm.cjs", () => false), undefined);
	assert.equal(
		usablePnpmExecPath("/home/dev/.local/share/pnpm/pnpm", present),
		"/home/dev/.local/share/pnpm/pnpm",
	);
});

test("resolvePnpmInvocation fallback shell behavior is explicit per platform", () => {
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			npmExecPath: undefined,
			platform: "win32",
			comSpec: "C:/Windows/System32/cmd.exe",
		}),
		{
			command: "C:/Windows/System32/cmd.exe",
			args: [
				"/d",
				"/s",
				"/v:off",
				"/c",
				'""%CINDY_PNPM_CMD_ARG_0%" "%CINDY_PNPM_CMD_ARG_1%""',
			],
			env: {
				CINDY_PNPM_CMD_ARG_0: "pnpm",
				CINDY_PNPM_CMD_ARG_1: "--version",
			},
			shell: false,
			windowsVerbatimArguments: true,
		},
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			npmExecPath: undefined,
			platform: "darwin",
		}),
		{ command: "pnpm", args: ["--version"], shell: false },
	);
	assert.deepEqual(
		resolvePnpmInvocation(["--version"], {
			execPath: "node",
			npmExecPath: undefined,
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

test("createBoundedOutputBuffer keeps bounded head and tail diagnostics", () => {
	const output = createBoundedOutputBuffer(20);
	output.append("0123456789");
	output.append("abcdefghij");
	output.append("KLMNOPQRST");
	assert.equal(
		output.toString(),
		"01234\n... 10 output characters omitted ...\nfghijKLMNOPQRST",
	);
});

test("runCommand bounds captured output while retaining head and tail", async () => {
	const result = await runCommand(
		process.execPath,
		["-e", "process.stdout.write(`HEAD${'x'.repeat(100)}TAIL`)"],
		{
			shell: false,
			stdout: null,
			stderr: null,
			maxOutputChars: 20,
		},
	);
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /^HEAD/);
	assert.match(result.output, /output characters omitted/);
	assert.match(result.output, /TAIL$/);
	assert.ok(result.output.length < 100);
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

test("mapWithConcurrency stays within the bound, remains work-conserving, and preserves result order", async () => {
	const releases = [];
	const started = [];
	let active = 0;
	let maxActive = 0;
	const pending = mapWithConcurrency(["a", "b", "c"], 2, async (item) => {
		started.push(item);
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => releases.push(resolve));
		active -= 1;
		return item.toUpperCase();
	});

	await waitFor(() => started.length === 2);
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(active, 2);
	releases.shift()();
	await waitFor(() => started.length === 3);
	assert.deepEqual(started, ["a", "b", "c"]);
	assert.equal(active, 2, "the freed slot should be reused immediately");
	for (const release of releases.splice(0)) release();

	assert.deepEqual(await pending, ["A", "B", "C"]);
	assert.equal(maxActive, 2);
});

test("runWithExclusiveBarriers never overlaps exclusive and normal work", async () => {
	const runs = [
		{ id: "a", tierConfig: {} },
		{ id: "b", tierConfig: {} },
		{ id: "desktop", tierConfig: { execution: "exclusive" } },
		{ id: "c", tierConfig: {} },
	];
	let normalActive = 0;
	let exclusiveActive = false;
	let maxNormalActive = 0;
	const started = [];
	const results = await runWithExclusiveBarriers(runs, 2, async (run) => {
		started.push(run.id);
		if (run.tierConfig.execution === "exclusive") {
			assert.equal(normalActive, 0);
			assert.equal(exclusiveActive, false);
			exclusiveActive = true;
		} else {
			assert.equal(exclusiveActive, false);
			normalActive += 1;
			maxNormalActive = Math.max(maxNormalActive, normalActive);
		}
		await new Promise((resolve) => setImmediate(resolve));
		if (run.tierConfig.execution === "exclusive") exclusiveActive = false;
		else normalActive -= 1;
		return run.id;
	});

	assert.deepEqual(started, ["a", "b", "desktop", "c"]);
	assert.deepEqual(results, ["a", "b", "desktop", "c"]);
	assert.equal(maxNormalActive, 2);
});

test("createWorkspaceRunReporter keeps passing output concise and flushes failed output as one block", () => {
	let timestamp = 1_000;
	const writes = [];
	const reporter = createWorkspaceRunReporter({
		stdout: { write: (chunk) => writes.push(String(chunk)) },
		now: () => timestamp,
	});
	const run = {
		workspace: { cwd: "packages/a" },
		tier: "unit",
	};
	reporter.onRunStart(run);
	reporter.onCommandComplete({
		run,
		stage: "test",
		commandResult: { output: "passing output", exitCode: 0 },
	});
	reporter.onCommandComplete({
		run,
		stage: "test",
		commandResult: { output: "failed output", exitCode: 1 },
	});
	timestamp = 2_250;
	reporter.onRunComplete(run, {
		exitCode: 1,
		failure: "COMMAND_FAILED",
		durationMs: 1_500,
	});
	assert.equal(
		writes.join(""),
		"START packages/a unit\n" +
			"\n[packages/a unit test]\nfailed output\n" +
			"FAIL COMMAND_FAILED packages/a unit (1.5s)\n",
	);
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

test("runPlannedTests applies bounded concurrency while keeping results in manifest order", async () => {
	const workspaces = ["a", "b", "c"].map((name) => ({
		name,
		cwd: `packages/${name}`,
		status: "required",
		tiers: {
			unit: {
				status: "required",
				command: { type: "packageBin", bin: "vitest", args: ["run"] },
			},
		},
	}));
	const delays = new Map([
		["packages/a", 20],
		["packages/b", 1],
		["packages/c", 5],
	]);
	let active = 0;
	let maxActive = 0;
	const result = await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: workspaces.map((workspace) => workspace.cwd),
		allFiles: workspaces.map(
			(workspace) => `${workspace.cwd}/src/example.test.ts`,
		),
		manifest: { workspaces },
		tier: "unit",
		workspaceConcurrency: 2,
		runCommandImpl: async (_command, _args, options) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			const workspace = normalizeRelPath(options.cwd).replace("F:/repo/", "");
			await new Promise((resolve) => setTimeout(resolve, delays.get(workspace)));
			active -= 1;
			return { exitCode: 0, output: workspace };
		},
	});

	assert.equal(maxActive, 2);
	assert.deepEqual(
		result.map((entry) => entry.workspace),
		["packages/a", "packages/b", "packages/c"],
	);
});

test("runPlannedTests treats an exclusive workspace as a concurrency barrier", async () => {
	const workspaces = [
		{ name: "a", cwd: "packages/a", execution: undefined },
		{ name: "desktop", cwd: "apps/desktop", execution: "exclusive" },
		{ name: "b", cwd: "packages/b", execution: undefined },
	].map(({ name, cwd, execution }) => ({
		name,
		cwd,
		status: "required",
		tiers: {
			unit: {
				status: "required",
				command: { type: "packageBin", bin: "vitest", args: ["run"] },
				...(execution ? { execution } : {}),
			},
		},
	}));
	let normalActive = 0;
	let desktopActive = false;
	await runPlannedTests({
		root: "F:/repo",
		workspaceCwds: workspaces.map((workspace) => workspace.cwd),
		allFiles: workspaces.map(
			(workspace) => `${workspace.cwd}/src/example.test.ts`,
		),
		manifest: { workspaces },
		tier: "unit",
		workspaceConcurrency: 2,
		runCommandImpl: async (_command, _args, options) => {
			const workspace = normalizeRelPath(options.cwd).replace("F:/repo/", "");
			if (workspace === "apps/desktop") {
				assert.equal(normalActive, 0);
				desktopActive = true;
			} else {
				assert.equal(desktopActive, false);
				normalActive += 1;
			}
			await new Promise((resolve) => setImmediate(resolve));
			if (workspace === "apps/desktop") desktopActive = false;
			else normalActive -= 1;
			return { exitCode: 0, output: workspace };
		},
	});
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
