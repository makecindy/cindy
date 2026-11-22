import fs from "node:fs";
import path from "node:path";

const WIDE_ROOT_FILES = new Set([
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"scripts/test-workspaces.mjs",
	"scripts/test-workspaces.config.mjs",
	"scripts/test-related.mjs",
	"scripts/test-gate-lock.mjs",
]);
const SKIP_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	".rst",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico",
	".bmp",
	".mp4",
	".webm",
	".mov",
	".mp3",
	".wav",
	".ogg",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pdf",
]);
const SKIP_BASENAMES = new Set([
	"LICENSE",
	"LICENSE.txt",
	"DCO",
	"NOTICE",
	"NOTICE.txt",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".npmrc",
	".prettierignore",
	".eslintignore",
]);
// Locale JSON is imported by the shared i18n module, so Vitest's import graph
// marks almost every renderer test as related: a 12-file locale change selected
// 1,157 test files / 33,244 tests, and the graph walk alone cost ~190s before
// any test started. Route locale edits to the i18n gates plus the tests that
// model copy explicitly instead of paying that fan-out locally. CI still runs
// the full unit tier, so page-level copy assertions outside this list stay
// covered there (docs/dev-rules/development-workflow.md).
const LOCALE_INPUT_PATTERNS = [
	/^apps\/desktop\/src\/renderer\/i18n\/locales\/[^/]+\/[^/]+\.json$/,
	/^apps\/desktop\/src\/renderer\/i18n\/crossLocaleStrings\.generated\.json$/,
];

/** Every `*.i18n.test.*` must be listed here; a root-runner test enforces it. */
export const LOCALE_RELATED_TEST_FILES = Object.freeze([
	"apps/desktop/src/main/cindy-brain/__tests__/ghostExternalLinkNavigation.i18n.test.ts",
	"apps/desktop/src/renderer/__tests__/PermissionPrompt.i18n.test.tsx",
	// Source-to-locale parity: catches a `t('key')` that no locale provides.
	"apps/desktop/src/renderer/__tests__/i18nCompleteness.test.ts",
	"apps/desktop/src/renderer/components/chat/__tests__/SystemCard.i18n.test.tsx",
	"apps/desktop/src/renderer/components/cindy-make/__tests__/CindyMakeBuildFailure.i18n.test.tsx",
	"apps/desktop/src/renderer/components/cindy-make/__tests__/CindyMakeHistoryPanel.i18n.test.tsx",
	"apps/desktop/src/renderer/components/cindy-make/__tests__/CindyMakePreflightDialog.i18n.test.tsx",
	"apps/desktop/src/renderer/components/cindy-make/__tests__/CindyMakeTestCard.i18n.test.tsx",
	"apps/desktop/src/renderer/components/cindy-make/__tests__/CindyMakeVersionsPanel.i18n.test.tsx",
	"apps/desktop/src/renderer/features/cc-agent/sidebar/__tests__/TaskMigrationDialog.i18n.test.tsx",
]);

/** Root scripts that guard locale structure and terminology. `cwd` is repo-relative. */
export const LOCALE_RELATED_CHECKS = Object.freeze([
	{ script: "check:i18n", cwd: "." },
	{ script: "check:i18n-glossary", cwd: "." },
]);

// A fork's origin can lag behind the contribution target. Prefer the upstream
// default branch before origin, and use local branches only as a fallback.
const GIT_BASE_REFS = [
	"refs/remotes/upstream/HEAD", "upstream/main", "upstream/master",
	"refs/remotes/origin/HEAD", "origin/main", "origin/master", "main", "master",
];

export function normalizeRelPath(value) {
	return String(value).replace(/\\/g, "/");
}

export function isTestFile(file) {
	return /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalizeRelPath(file));
}

export function isSkippableFile(file) {
	const normalized = normalizeRelPath(file);
	const basename = normalized.split("/").pop() ?? normalized;
	if (SKIP_BASENAMES.has(basename)) return true;
	const extension = path.posix.extname(basename).toLowerCase();
	return SKIP_EXTENSIONS.has(extension);
}

export function isLocaleInputFile(file) {
	const normalized = normalizeRelPath(file);
	return LOCALE_INPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isWideFile(file) {
	const normalized = normalizeRelPath(file);
	if (WIDE_ROOT_FILES.has(normalized)) return true;
	return /^vitest\.config\.[cm]?[jt]s$/.test(normalized);
}

export function shouldRunTestRunner(files) {
	return files.some((file) => {
		const normalized = normalizeRelPath(file);
		// These text artifacts are executable test inputs, not explanatory docs:
		// glossary-rules and third-party-notices validate their generated content.
		if (
			normalized === "i18n/GLOSSARY.md" ||
			normalized.startsWith("docs/legal/notices/")
		) return true;
		return (
			!isSkippableFile(normalized) &&
			!normalized.startsWith("apps/") && !normalized.startsWith("packages/")
		);
	});
}

export function workspaceForFile(file, workspaceCwds) {
	const normalized = normalizeRelPath(file);
	return workspaceCwds
		.map(normalizeRelPath)
		.filter(
			(cwd) => normalized === cwd || normalized.startsWith(`${cwd}/`),
		)
		.sort((left, right) => right.length - left.length)[0];
}

function isPackagePublicSource(file) {
	const normalized = normalizeRelPath(file);
	if (isTestFile(normalized)) return false;
	return !(
		normalized.includes("/__tests__/") || normalized.includes("/__mocks__/")
	);
}

function isWorkspaceDependency(version) {
	return typeof version === "string" && version.startsWith("workspace:");
}

export function buildDependentMap(workspaces, packageJsonByCwd) {
	const nameToCwd = new Map();
	for (const workspace of workspaces) {
		nameToCwd.set(workspace.name, normalizeRelPath(workspace.cwd));
	}
	for (const [cwd, pkg] of Object.entries(packageJsonByCwd)) {
		if (pkg?.name) nameToCwd.set(pkg.name, normalizeRelPath(cwd));
	}

	const dependents = new Map();
	for (const workspace of workspaces) {
		dependents.set(normalizeRelPath(workspace.cwd), new Set());
	}

	for (const workspace of workspaces) {
		const cwd = normalizeRelPath(workspace.cwd);
		const pkg =
			packageJsonByCwd[cwd] ?? packageJsonByCwd[workspace.cwd] ?? null;
		if (!pkg) continue;
		const entries = [
			...Object.entries(pkg.dependencies ?? {}),
			...Object.entries(pkg.devDependencies ?? {}),
			...Object.entries(pkg.peerDependencies ?? {}),
		];
		for (const [depName, version] of entries) {
			if (!isWorkspaceDependency(version)) continue;
			const producer = nameToCwd.get(depName);
			if (!producer || producer === cwd) continue;
			if (!dependents.has(producer)) dependents.set(producer, new Set());
			dependents.get(producer).add(cwd);
		}
	}
	return dependents;
}

export function collectTransitiveDependents(startCwds, dependentMap) {
	const result = new Set();
	const queue = startCwds.map(normalizeRelPath);
	while (queue.length > 0) {
		const cwd = queue.pop();
		for (const dependent of dependentMap.get(cwd) ?? []) {
			if (result.has(dependent)) continue;
			result.add(dependent);
			queue.push(dependent);
		}
	}
	return result;
}

export function resolveGitBaseRef(runGit) {
	for (const ref of GIT_BASE_REFS) {
		try {
			runGit(["rev-parse", "--verify", ref]);
			return ref;
		} catch {
			// try the next conventional main-branch name
		}
	}
	return null;
}

function addGitNames(files, output) {
	for (const line of String(output).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) files.add(normalizeRelPath(trimmed));
	}
}

export function collectChangedFiles(runGit) {
	try {
		const baseRef = resolveGitBaseRef(runGit);
		if (!baseRef) {
			return {
				files: [],
				base: null,
				baseRef: null,
				error: "cannot resolve git base against main",
			};
		}
		const mergeBase = String(runGit(["merge-base", "HEAD", baseRef])).trim();
		if (!mergeBase) {
			return {
				files: [],
				base: null,
				baseRef,
				error: `cannot compute merge-base with ${baseRef}`,
			};
		}
		const files = new Set();
		addGitNames(files, runGit(["diff", "--name-only", mergeBase, "HEAD"]));
		addGitNames(files, runGit(["diff", "--name-only", "--cached"]));
		addGitNames(files, runGit(["diff", "--name-only"]));
		addGitNames(files, runGit(["ls-files", "--others", "--exclude-standard"]));
		return {
			files: [...files].sort(),
			base: mergeBase,
			baseRef,
		};
	} catch (error) {
		return {
			files: [],
			base: null,
			baseRef: null,
			error: error?.message ?? "git changed-file collection failed",
		};
	}
}

function hasRequiredUnitTier(workspace) {
	const unit = workspace.tiers?.unit;
	return unit?.status === "required";
}

function describeRelatedRuns(runs) {
	if (runs.length === 0) return "no workspace unit tests";
	return runs
		.map((run) => {
			const checks = run.checks?.length ? `, ${run.checks.length} checks` : "";
			if (Array.isArray(run.explicitFiles)) {
				return `${run.cwd} (${run.localeInputCount} locale inputs → ${run.explicitFiles.length} test files${checks})`;
			}
			return Array.isArray(run.relatedFiles)
				? `${run.cwd} (related ${run.relatedFiles.length}${checks})`
				: `${run.cwd} (full${checks})`;
		})
		.join(", ");
}

export function planRelatedUnitTests({
	changedFiles,
	workspaces,
	packageJsonByCwd,
	fileExists = () => true,
}) {
	const files = (changedFiles ?? []).map(normalizeRelPath);
	if (files.length === 0) {
		return {
			mode: "skip",
			reason: "no changes vs main",
			runTestRunner: false,
			runs: [],
		};
	}

	const wide = files.filter(isWideFile);
	if (wide.length > 0) {
		const preview = wide.slice(0, 5).join(", ");
		const extra = wide.length > 5 ? "…" : "";
		return {
			mode: "full",
			reason: `wide files changed: ${preview}${extra}`,
			runTestRunner: true,
			runs: [],
		};
	}

	const runTestRunner = shouldRunTestRunner(files);
	const testable = files.filter((file) => !isSkippableFile(file));
	if (testable.length === 0) {
		return {
			mode: runTestRunner ? "related" : "skip",
			reason: runTestRunner
				? "only non-code files changed; run root test:runner"
				: "only non-code files changed",
			runTestRunner,
			runs: [],
		};
	}

	const workspaceCwds = workspaces.map((workspace) =>
		normalizeRelPath(workspace.cwd),
	);
	const byCwd = new Map(
		workspaces.map((workspace) => [
			normalizeRelPath(workspace.cwd),
			workspace,
		]),
	);
	const ownerRelated = new Map();
	const sourceChangedCwds = new Set();
	const fullWorkspaces = new Set();
	const localeInputs = testable.filter(isLocaleInputFile);
	const localeInputSet = new Set(localeInputs);
	const localeCwds = new Set(
		localeInputs
			.map((file) => workspaceForFile(file, workspaceCwds))
			.filter(Boolean),
	);

	if (localeInputs.length > 0) {
		const missing = LOCALE_RELATED_TEST_FILES.filter((file) => !fileExists(file));
		if (missing.length > 0) {
			throw new Error(
				"i18n locale related mapping is stale: " +
					`${missing.join(", ")} does not exist. Update ` +
					"LOCALE_RELATED_TEST_FILES in scripts/test-related.mjs.",
			);
		}
	}

	for (const file of testable) {
		// Vitest related would walk the i18n import graph instead of the mapping.
		if (localeInputSet.has(file)) continue;
		const cwd = workspaceForFile(file, workspaceCwds);
		if (!cwd) continue;
		const workspace = byCwd.get(cwd);
		if (!workspace || !hasRequiredUnitTier(workspace)) continue;
		if (!ownerRelated.has(cwd)) ownerRelated.set(cwd, new Set());
		if (fileExists(file)) ownerRelated.get(cwd).add(file);
		if (
			file === `${cwd}/package.json` ||
			/(^|\/)vitest\.config\.[cm]?[jt]s$/.test(file.slice(cwd.length + 1)) ||
			!fileExists(file)
		) fullWorkspaces.add(cwd);
		if (isPackagePublicSource(file)) sourceChangedCwds.add(cwd);
	}

	const dependents = collectTransitiveDependents(
		[...sourceChangedCwds],
		buildDependentMap(workspaces, packageJsonByCwd),
	);

	// Locale edits are the mapped tests' trigger, so they replace the import
	// graph rather than joining it. When the same package already has real
	// related work, the mapped tests join that run (the graph is paid anyway);
	// otherwise they run as an explicit file list with no graph walk at all.
	const explicitFilesByCwd = localeInputs.length > 0 ? new Map() : null;
	if (explicitFilesByCwd) {
		const mappedByCwd = new Map();
		for (const testFile of LOCALE_RELATED_TEST_FILES) {
			const cwd = workspaceForFile(testFile, workspaceCwds);
			if (!cwd) continue;
			const workspace = byCwd.get(cwd);
			if (!workspace || !hasRequiredUnitTier(workspace)) continue;
			if (!mappedByCwd.has(cwd)) mappedByCwd.set(cwd, []);
			mappedByCwd.get(cwd).push(testFile);
		}
		for (const [cwd, mappedTests] of mappedByCwd) {
			if (dependents.has(cwd) || fullWorkspaces.has(cwd)) continue;
			const ownFiles = ownerRelated.get(cwd);
			if (ownFiles && ownFiles.size > 0) {
				for (const testFile of mappedTests) ownFiles.add(testFile);
				continue;
			}
			explicitFilesByCwd.set(cwd, mappedTests);
		}
	}

	const runCwds = new Set([
		...ownerRelated.keys(),
		...dependents,
		...(explicitFilesByCwd?.keys() ?? []),
	]);
	const runs = [...runCwds]
		.sort()
		.flatMap((cwd) => {
			const workspace = byCwd.get(cwd);
			if (!workspace || !hasRequiredUnitTier(workspace)) return [];
			const ownFiles = [...(ownerRelated.get(cwd) ?? [])].sort();
			const explicitFiles = explicitFilesByCwd?.get(cwd);
			const relatedFiles = dependents.has(cwd) || fullWorkspaces.has(cwd)
				? null : ownFiles;
			if (
				Array.isArray(relatedFiles) &&
				relatedFiles.length === 0 &&
				!explicitFiles?.length
			) return [];
			const checks = localeCwds.has(cwd) ? [...LOCALE_RELATED_CHECKS] : [];
			const run = explicitFiles?.length
				? {
						cwd,
						name: workspace.name,
						explicitFiles,
						localeInputCount: localeInputs.length,
					}
				: {
						cwd,
						name: workspace.name,
						relatedFiles,
					};
			return [checks.length > 0 ? { ...run, checks } : run];
		});

	if (runs.length === 0 && !runTestRunner) {
		return {
			mode: "skip",
			reason: "no related unit tests",
			runTestRunner: false,
			runs: [],
		};
	}

	return {
		mode: "related",
		reason: describeRelatedRuns(runs),
		runTestRunner,
		runs,
	};
}

export function readWorkspacePackages(
	root,
	workspaces,
	readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8")),
) {
	const result = {};
	for (const workspace of workspaces) {
		const cwd = normalizeRelPath(workspace.cwd);
		try {
			result[cwd] = readJson(path.join(root, ...cwd.split("/"), "package.json"));
		} catch {
			result[cwd] = null;
		}
	}
	return result;
}

export function createRelatedUnitPlan({
	root,
	manifest,
	runGit,
	readJson,
	fileExists,
}) {
	const collected = collectChangedFiles(runGit);
	if (collected.error) {
		return {
			mode: "full",
			reason: collected.error,
			runTestRunner: true,
			runs: [],
		};
	}
	return planRelatedUnitTests({
		changedFiles: collected.files,
		workspaces: manifest.workspaces,
		packageJsonByCwd: readWorkspacePackages(
			root,
			manifest.workspaces,
			readJson,
		),
		fileExists:
			fileExists ??
			((file) => fs.existsSync(path.join(root, ...normalizeRelPath(file).split("/")))),
	});
}
