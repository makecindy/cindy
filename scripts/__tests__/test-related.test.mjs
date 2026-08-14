import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDependentMap,
	collectChangedFiles,
	collectTransitiveDependents,
	isSkippableFile,
	isTestFile,
	isWideFile,
	planRelatedUnitTests,
	shouldRunTestRunner,
	workspaceForFile,
} from "../test-related.mjs";

const workspaces = [
	{
		name: "desktop",
		cwd: "apps/desktop",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "@cindy/maker-core",
		cwd: "packages/maker-core",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "@cindy/maker-shared",
		cwd: "packages/maker-shared",
		status: "required",
		tiers: { unit: { status: "required" } },
	},
	{
		name: "project-context",
		cwd: "packages/project-context",
		status: "notApplicable",
		reason: "No tests",
		tiers: {},
	},
];

const packageJsonByCwd = {
	"apps/desktop": {
		name: "desktop",
		dependencies: {
			"@cindy/maker-core": "workspace:*",
		},
	},
	"packages/maker-core": {
		name: "@cindy/maker-core",
		dependencies: {
			"@cindy/maker-shared": "workspace:*",
		},
	},
	"packages/maker-shared": {
		name: "@cindy/maker-shared",
		dependencies: {},
	},
	"packages/project-context": {
		name: "project-context",
		dependencies: {},
	},
};

test("isWideFile covers test scheduler, lockfile, and CI workflows", () => {
	assert.equal(isWideFile("package.json"), true);
	assert.equal(isWideFile("apps/desktop/package.json"), true);
	assert.equal(isWideFile("pnpm-lock.yaml"), true);
	assert.equal(isWideFile("scripts/test-related.mjs"), true);
	assert.equal(isWideFile("scripts/test-workspaces.config.mjs"), true);
	assert.equal(isWideFile(".github/workflows/ci.yml"), true);
	assert.equal(isWideFile("apps/desktop/src/main/foo.ts"), false);
});

test("isSkippableFile and isTestFile classify docs versus tests", () => {
	assert.equal(isSkippableFile("docs/dev-rules/development-workflow.md"), true);
	assert.equal(isSkippableFile("LICENSE"), true);
	assert.equal(isSkippableFile("apps/desktop/src/main/foo.ts"), false);
	assert.equal(isTestFile("apps/desktop/src/main/foo.test.ts"), true);
	assert.equal(isTestFile("apps/desktop/src/main/foo.ts"), false);
});

test("shouldRunTestRunner only when something outside apps/packages changed", () => {
	assert.equal(
		shouldRunTestRunner(["apps/desktop/src/main/foo.ts"]),
		false,
	);
	assert.equal(
		shouldRunTestRunner(["docs/dev-rules/desktop-development.md"]),
		true,
	);
	assert.equal(shouldRunTestRunner(["scripts/check-i18n.mjs"]), true);
});

test("workspaceForFile picks the longest matching workspace prefix", () => {
	assert.equal(
		workspaceForFile("apps/desktop/src/main/foo.ts", [
			"apps",
			"apps/desktop",
		]),
		"apps/desktop",
	);
	assert.equal(
		workspaceForFile("README.md", ["apps/desktop", "packages/maker-core"]),
		undefined,
	);
});

test("collectChangedFiles unions committed, staged, unstaged, and untracked files", () => {
	const calls = [];
	const runGit = (args) => {
		calls.push(args);
		const key = args.join(" ");
		if (key === "rev-parse --verify origin/main") return "abc\n";
		if (key === "merge-base HEAD origin/main") return "base123\n";
		if (key === "diff --name-only base123 HEAD")
			return "apps/desktop/src/a.ts\n";
		if (key === "diff --name-only --cached")
			return "apps/desktop/src/b.ts\n";
		if (key === "diff --name-only") return "apps/desktop/src/c.ts\n";
		if (key === "ls-files --others --exclude-standard")
			return "apps/desktop/src/d.ts\n";
		throw new Error(`unexpected git ${key}`);
	};
	assert.deepEqual(collectChangedFiles(runGit), {
		files: [
			"apps/desktop/src/a.ts",
			"apps/desktop/src/b.ts",
			"apps/desktop/src/c.ts",
			"apps/desktop/src/d.ts",
		],
		base: "base123",
		baseRef: "origin/main",
	});
	assert.deepEqual(calls[0], ["rev-parse", "--verify", "origin/main"]);
});

test("collectChangedFiles falls back when git base cannot be resolved", () => {
	const runGit = () => {
		throw new Error("not a git repo");
	};
	assert.deepEqual(collectChangedFiles(runGit), {
		files: [],
		base: null,
		baseRef: null,
		error: "cannot resolve git base against main",
	});
});

test("planRelatedUnitTests runs only related tests for a leaf workspace file", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["apps/desktop/src/main/foo.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.equal(plan.runTestRunner, false);
	assert.deepEqual(plan.runs, [
		{
			cwd: "apps/desktop",
			name: "desktop",
			relatedFiles: ["apps/desktop/src/main/foo.ts"],
		},
	]);
});

test("planRelatedUnitTests runs dependents fully when a shared package source changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["packages/maker-shared/src/index.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.deepEqual(
		plan.runs.map((run) => [run.cwd, run.relatedFiles]),
		[
			["apps/desktop", null],
			["packages/maker-core", null],
			["packages/maker-shared", ["packages/maker-shared/src/index.ts"]],
		],
	);
});

test("planRelatedUnitTests does not fan out dependents for a test-only change", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["packages/maker-core/src/foo.test.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.deepEqual(plan.runs, [
		{
			cwd: "packages/maker-core",
			name: "@cindy/maker-core",
			relatedFiles: ["packages/maker-core/src/foo.test.ts"],
		},
	]);
});

test("planRelatedUnitTests falls back to the full suite for wide files", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["package.json", "apps/desktop/src/main/foo.ts"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "full");
	assert.match(plan.reason, /wide files changed: package\.json/);
	assert.equal(plan.runTestRunner, true);
	assert.deepEqual(plan.runs, []);
});

test("planRelatedUnitTests skips markdown-only changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["README.md", "docs/dev-rules/development-workflow.md"],
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.equal(plan.runTestRunner, true);
	assert.deepEqual(plan.runs, []);
});

test("planRelatedUnitTests skips when there are no changes", () => {
	const plan = planRelatedUnitTests({
		changedFiles: [],
		workspaces,
		packageJsonByCwd,
	});
	assert.deepEqual(plan, {
		mode: "skip",
		reason: "no changes vs main",
		runTestRunner: false,
		runs: [],
	});
});

test("planRelatedUnitTests drops deleted files from related args", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["apps/desktop/src/main/gone.ts"],
		workspaces,
		packageJsonByCwd,
		fileExists: () => false,
	});
	assert.equal(plan.mode, "skip");
	assert.deepEqual(plan.runs, []);
});

test("buildDependentMap and collectTransitiveDependents follow workspace:* edges", () => {
	const dependents = buildDependentMap(workspaces, packageJsonByCwd);
	assert.deepEqual(
		[...collectTransitiveDependents(["packages/maker-shared"], dependents)].sort(),
		["apps/desktop", "packages/maker-core"],
	);
	assert.deepEqual(
		[...collectTransitiveDependents(["apps/desktop"], dependents)],
		[],
	);
});
