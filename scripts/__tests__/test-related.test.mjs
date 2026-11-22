import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildDependentMap,
	collectChangedFiles,
	collectTransitiveDependents,
	isLocaleInputFile,
	isSkippableFile,
	isTestFile,
	isWideFile,
	LOCALE_RELATED_CHECKS,
	LOCALE_RELATED_TEST_FILES,
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

test("isWideFile keeps only repository-wide dependency and runner inputs", () => {
	assert.equal(isWideFile("package.json"), true);
	assert.equal(isWideFile("apps/desktop/package.json"), false);
	assert.equal(isWideFile("pnpm-lock.yaml"), true);
	assert.equal(isWideFile("scripts/test-related.mjs"), true);
	assert.equal(isWideFile("scripts/test-workspaces.config.mjs"), true);
	assert.equal(isWideFile(".github/workflows/ci.yml"), false);
	assert.equal(isWideFile("apps/desktop/src/main/foo.ts"), false);
});

test("isSkippableFile and isTestFile classify docs versus tests", () => {
	assert.equal(isSkippableFile("docs/dev-rules/development-workflow.md"), true);
	assert.equal(isSkippableFile("LICENSE"), true);
	assert.equal(isSkippableFile("apps/desktop/src/main/foo.ts"), false);
	assert.equal(isTestFile("apps/desktop/src/main/foo.test.ts"), true);
	assert.equal(isTestFile("apps/desktop/src/main/foo.ts"), false);
});

test("shouldRunTestRunner excludes documentation and workspace-only changes", () => {
	assert.equal(
		shouldRunTestRunner(["apps/desktop/src/main/foo.ts"]),
		false,
	);
	assert.equal(
		shouldRunTestRunner(["docs/dev-rules/desktop-development.md"]),
		false,
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
	assert.ok(calls.some((args) => args.join(" ") === "rev-parse --verify upstream/main"));
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
	assert.equal(plan.mode, "skip");
	assert.equal(plan.runTestRunner, false);
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

test("generated glossary and legal text retain their runner checks without business suites", () => {
	for (const file of ["i18n/GLOSSARY.md", "docs/legal/notices/desktop-win.txt"]) {
		const plan = planRelatedUnitTests({ changedFiles: [file], workspaces, packageJsonByCwd });
		assert.equal(plan.mode, "related", file);
		assert.equal(plan.runTestRunner, true, file);
		assert.deepEqual(plan.runs, [], file);
	}
});

test("planRelatedUnitTests runs the owner suite when a file is deleted", () => {
	const plan = planRelatedUnitTests({
		changedFiles: ["apps/desktop/src/main/gone.ts"],
		workspaces,
		packageJsonByCwd,
		fileExists: () => false,
	});
	assert.equal(plan.mode, "related");
	assert.deepEqual(plan.runs, [{ cwd: "apps/desktop", name: "desktop", relatedFiles: null }]);
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

test("workspace manifest and Vitest configuration changes stay in the affected dependency graph", () => {
	for (const file of ["packages/maker-core/package.json", "packages/maker-core/vitest.config.ts"]) {
		const plan = planRelatedUnitTests({ changedFiles: [file], workspaces, packageJsonByCwd });
		assert.equal(plan.mode, "related");
		assert.deepEqual(plan.runs.map(({ cwd, relatedFiles }) => [cwd, relatedFiles]), [
			["apps/desktop", null], ["packages/maker-core", null],
		]);
	}
});

test("workflow edits validate the runner without scheduling every workspace", () => {
	const plan = planRelatedUnitTests({
		changedFiles: [".github/workflows/pr-design-basis.yml"], workspaces, packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.equal(plan.runTestRunner, true);
	assert.deepEqual(plan.runs, []);
});

test("a stale fork does not count upstream commits as local work, including from a worktree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "related-git-base-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	// Git for Windows cannot open Node's \\.\nul device path as a config file.
	const globalConfig = path.join(root, "empty.gitconfig");
	fs.writeFileSync(globalConfig, "");
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
	const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		git(repo, ["init", "-b", "main"]);
		git(repo, ["config", "user.name", "Test"]);
		git(repo, ["config", "user.email", "test@example.invalid"]);
		git(repo, ["commit", "--allow-empty", "-m", "base"]);
		git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		fs.writeFileSync(path.join(repo, "upstream.ts"), "export const upstream = true;\n");
		git(repo, ["add", "upstream.ts"]);
		git(repo, ["commit", "-m", "upstream change"]);
		git(repo, ["update-ref", "refs/remotes/upstream/trunk", "HEAD"]);
		git(repo, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk"]);
		assert.deepEqual(collectChangedFiles((args) => git(repo, args)).files, []);
		const worktree = path.join(root, "task");
		git(repo, ["worktree", "add", "-b", "task", worktree]);
		fs.writeFileSync(path.join(worktree, "local.ts"), "export const local = true;\n");
		const result = collectChangedFiles((args) => git(worktree, args));
		assert.equal(result.baseRef, "refs/remotes/upstream/HEAD");
		assert.deepEqual(result.files, ["local.ts"]);
		git(repo, ["symbolic-ref", "--delete", "refs/remotes/upstream/HEAD"]);
		git(repo, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
		assert.deepEqual(collectChangedFiles((args) => git(worktree, args)).files, ["local.ts"]);
		git(repo, ["update-ref", "-d", "refs/remotes/upstream/main"]);
		assert.equal(collectChangedFiles((args) => git(worktree, args)).baseRef, "origin/main");
		git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
		assert.equal(collectChangedFiles((args) => git(worktree, args)).baseRef, "main");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/*
测试价值
- 生产入口与可观察结果：`pnpm test:unit:related` 的选测计划。locale JSON 改动后，开发者
  看到的是「12 locale inputs → 10 test files, 2 checks」，而不是 1,157 个 renderer 测试。
- Bug／规则依据：2026-11-22 的 12 文件 locale 改动命中 1,157 个测试文件 / 33,244 个测试；
  `vitest related` 仅建依赖图就实测 190s（docs/dev-rules/development-workflow.md
  「相关单测怎么选」）。
- 现有覆盖缺口：相邻用例只覆盖普通源码、公共包、宽文件与删除文件，没有 locale 输入。
- 最小失败输入：只改 `apps/desktop/src/renderer/i18n/locales/en/common.json`，旧 planner
  会把它原样放进 relatedFiles，Vitest related 随即扫出整片 renderer。
- tier：根 runner（node --test scripts/__tests__），不进入 workspace tier。
*/

const LOCALE_CHANGE_FILES = [
	"de",
	"en",
	"es",
	"fr",
	"ja",
	"ko",
	"pt-BR",
	"pt-PT",
	"zh-CN",
	"zh-Hans-x-lzh",
	"zh-Hant-x-lzh",
	"zh-TW",
].map((locale) => `apps/desktop/src/renderer/i18n/locales/${locale}/common.json`);

function findI18nTestFiles(repoRoot, subdir) {
	const found = [];
	const visit = (absDir) => {
		for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) {
					continue;
				}
				visit(path.join(absDir, entry.name));
				continue;
			}
			if (/\.i18n\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
				found.push(
					path
						.relative(repoRoot, path.join(absDir, entry.name))
						.split(path.sep)
						.join("/"),
				);
			}
		}
	};
	visit(path.join(repoRoot, subdir));
	return found.sort();
}

test("locale inputs are classified without catching other JSON or other apps", () => {
	assert.equal(isLocaleInputFile("apps/desktop/src/renderer/i18n/locales/en/common.json"), true);
	assert.equal(isLocaleInputFile("apps/desktop/src/renderer/i18n/locales/pt-BR/aiRename.json"), true);
	assert.equal(
		isLocaleInputFile("apps/desktop/src/renderer/i18n/crossLocaleStrings.generated.json"),
		true,
	);
	assert.equal(isLocaleInputFile("apps/desktop/package.json"), false);
	assert.equal(isLocaleInputFile("apps/mobile/src/i18n/locales/en/common.json"), false);
	assert.equal(isLocaleInputFile("apps/desktop/src/renderer/i18n/locales/en/common.ts"), false);
});

test("a locale-only change runs the mapped i18n tests and gates without touching the import graph", () => {
	const plan = planRelatedUnitTests({
		changedFiles: LOCALE_CHANGE_FILES,
		workspaces,
		packageJsonByCwd,
	});
	assert.equal(plan.mode, "related");
	assert.equal(plan.runTestRunner, false);
	assert.deepEqual(plan.runs, [
		{
			cwd: "apps/desktop",
			name: "desktop",
			explicitFiles: [...LOCALE_RELATED_TEST_FILES],
			localeInputCount: 12,
			checks: [...LOCALE_RELATED_CHECKS],
		},
	]);
	assert.match(
		plan.reason,
		/apps\/desktop \(12 locale inputs → 10 test files, 2 checks\)/,
	);
	for (const localeFile of LOCALE_CHANGE_FILES) {
		assert.equal(
			plan.runs[0].explicitFiles.includes(localeFile),
			false,
			`locale JSON must not reach Vitest: ${localeFile}`,
		);
		assert.equal("relatedFiles" in plan.runs[0], false);
	}
});

test("locale edits join an existing related run instead of replacing it", () => {
	const plan = planRelatedUnitTests({
		changedFiles: [...LOCALE_CHANGE_FILES, "apps/desktop/src/main/foo.ts"],
		workspaces,
		packageJsonByCwd,
	});
	const [run] = plan.runs;
	assert.equal(plan.runs.length, 1);
	assert.deepEqual(run.checks, [...LOCALE_RELATED_CHECKS]);
	assert.equal("explicitFiles" in run, false);
	assert.deepEqual(
		[...run.relatedFiles].sort(),
		["apps/desktop/src/main/foo.ts", ...LOCALE_RELATED_TEST_FILES].sort(),
	);
	for (const localeFile of LOCALE_CHANGE_FILES) {
		assert.equal(run.relatedFiles.includes(localeFile), false, localeFile);
	}
});

test("locale edits keep the gates when the owning workspace already runs in full", () => {
	const plan = planRelatedUnitTests({
		changedFiles: [
			"apps/desktop/src/renderer/i18n/locales/en/common.json",
			"packages/maker-shared/src/index.ts",
		],
		workspaces,
		packageJsonByCwd,
	});
	assert.deepEqual(
		plan.runs.map((run) => [run.cwd, run.relatedFiles, run.checks ?? []]),
		[
			["apps/desktop", null, [...LOCALE_RELATED_CHECKS]],
			["packages/maker-core", null, []],
			["packages/maker-shared", ["packages/maker-shared/src/index.ts"], []],
		],
	);
});

test("a stale locale mapping fails loudly instead of silently widening the run", () => {
	const missing = "apps/desktop/src/renderer/__tests__/i18nCompleteness.test.ts";
	assert.throws(
		() =>
			planRelatedUnitTests({
				changedFiles: ["apps/desktop/src/renderer/i18n/locales/en/common.json"],
				workspaces,
				packageJsonByCwd,
				fileExists: (file) => file !== missing,
			}),
		(error) => {
			assert.match(error.message, /i18n locale related mapping is stale/);
			assert.ok(error.message.includes(missing), error.message);
			return true;
		},
	);
});

test("every repository i18n test is mapped for locale-only changes", () => {
	const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
	const actual = findI18nTestFiles(repoRoot, "apps/desktop");
	assert.deepEqual(
		LOCALE_RELATED_TEST_FILES.filter((file) => /\.i18n\.test\./.test(file)).sort(),
		actual,
		"add every new *.i18n.test.* to LOCALE_RELATED_TEST_FILES in scripts/test-related.mjs",
	);
	assert.ok(
		LOCALE_RELATED_TEST_FILES.includes(
			"apps/desktop/src/renderer/__tests__/i18nCompleteness.test.ts",
		),
		"locale edits must keep the source-to-locale parity test",
	);
	for (const file of LOCALE_RELATED_TEST_FILES) {
		assert.match(file, /^apps\/desktop\//, file);
	}
});
