import fs from "node:fs";
import path from "node:path";

const WIDE_ROOT_FILES = new Set([
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
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
const GIT_BASE_REFS = ["origin/main", "main", "origin/master", "master"];

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

export function isWideFile(file) {
	const normalized = normalizeRelPath(file);
	if (WIDE_ROOT_FILES.has(normalized)) return true;
	if (normalized.endsWith("/package.json")) return true;
	if (/(^|\/)vitest\.config\.[cm]?[jt]s$/.test(normalized)) return true;
	if (
		normalized === "scripts/test-workspaces.mjs" ||
		normalized === "scripts/test-workspaces.config.mjs" ||
		normalized === "scripts/test-related.mjs" ||
		normalized === "scripts/test-gate-lock.mjs"
	) {
		return true;
	}
	return normalized.startsWith(".github/workflows/");
}

export function shouldRunTestRunner(files) {
	return files.some((file) => {
		const normalized = normalizeRelPath(file);
		return (
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
		.map((run) =>
			Array.isArray(run.relatedFiles)
				? `${run.cwd} (related ${run.relatedFiles.length})`
				: `${run.cwd} (full)`,
		)
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

	for (const file of testable) {
		const cwd = workspaceForFile(file, workspaceCwds);
		if (!cwd) continue;
		const workspace = byCwd.get(cwd);
		if (!workspace || !hasRequiredUnitTier(workspace)) continue;
		if (!ownerRelated.has(cwd)) ownerRelated.set(cwd, new Set());
		if (fileExists(file)) ownerRelated.get(cwd).add(file);
		if (isPackagePublicSource(file)) sourceChangedCwds.add(cwd);
	}

	const dependents = collectTransitiveDependents(
		[...sourceChangedCwds],
		buildDependentMap(workspaces, packageJsonByCwd),
	);
	const runCwds = new Set([...ownerRelated.keys(), ...dependents]);
	const runs = [...runCwds]
		.sort()
		.flatMap((cwd) => {
			const workspace = byCwd.get(cwd);
			if (!workspace || !hasRequiredUnitTier(workspace)) return [];
			const ownFiles = [...(ownerRelated.get(cwd) ?? [])].sort();
			const relatedFiles = dependents.has(cwd) ? null : ownFiles;
			if (Array.isArray(relatedFiles) && relatedFiles.length === 0) return [];
			return [
				{
					cwd,
					name: workspace.name,
					relatedFiles,
				},
			];
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
