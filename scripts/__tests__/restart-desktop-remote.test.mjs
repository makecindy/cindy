import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	applyDesktopStartupConfigForPhase,
	clearDesktopDevCaches,
	commandUsesUserDataDir,
	createIsolatedAuthLaunchProof,
	defaultIsolatedUserDataDir,
	desktopDevCacheDirs,
	devEnvPrefix,
	hasIsolationIntent,
	isTrustedIsolatedAuthUserDataDir,
	ISOLATED_AUTH_LAUNCH_PROOF_FILE,
	isOfficialProductionUserDataDir,
	isRepositoryDesktopDevProcess,
	officialProductionUserDataDirs,
	resolveRestartTargetUserDataDir,
	sanitizeIsolationName,
	canonicalizeUserDataDir,
	formatDesktopStartupFailure,
	inspectSharedUserDataRegion,
	partitionDesktopDevProcesses,
	productionUserDataDir,
	readDesktopStartupStatus,
	parseWorktreePaths,
	osascriptLaunchDarwinTerminalArgs,
	waitForDesktopStartup,
	shouldRefuseHostedRestart,
	commandContainsPath,
	inheritedUserDataBlocksNamedIsolation,
} from "../restart-desktop-remote.mjs";
import {
	DESKTOP_DEV_VERDICT_PREFIX,
	ISOLATED_RESTART_NEXT,
	WORKTREE_ISOLATED_ARG,
	SHARED_USERDATA_ARG,
	DEFAULT_ISOLATED_ARG,
	buildDesktopDevVerdictFromFailure,
	buildDesktopDevVerdictFromWhoami,
	desktopRestartArgvConflictMessage,
	formatDesktopDevVerdict,
	inferDesktopDevFailureCode,
	isolationNameFromWorktree,
	isolatedRestartNextCommand,
	normalizeDesktopRestartArgv,
	resolveIsolatedArg,
	restartContextFromArgv,
	shouldSuggestIsolatedNext,
} from "../desktop-dev-verdict.mjs";
import {
	collectDesktopWhoamiReport,
	identifyDesktopProcesses,
	mergeDesktopInstanceRecords,
	parseWorktreeEntries,
} from "../desktop-whoami.mjs";
import {
	assertDesktopRestartStepSucceeded,
	buildDesktopRestartSteps,
	DesktopRestartStepError,
	runDesktopRestart,
} from "../desktop-restart-runner.mjs";

function appleScriptLines(args) {
	const lines = [];
	for (let i = 0; i < args.length - 1; i += 1) {
		if (args[i] === "-e") lines.push(args[i + 1]);
	}
	return lines;
}

// 被测脚本用 path.join / path.resolve 生成路径,分隔符随平台变(Windows 反斜杠、
// 且 path.resolve 会补盘符)。测试的合成路径也必须走同一套 path API,才能在
// macOS / Windows 上都与生产实际所见一致——硬编码 POSIX 字面量只在 *nix 成立。
const stepScript = (root, name) => path.join(root, "scripts", name);

test("macOS Terminal launch runs command before activating Terminal", () => {
	const lines = appleScriptLines(osascriptLaunchDarwinTerminalArgs("echo test"));
	const doScriptIndex = lines.indexOf("set targetTab to do script devCommand");
	const activateIndex = lines.indexOf("activate");

	assert.notEqual(doScriptIndex, -1);
	assert.notEqual(activateIndex, -1);
	assert.ok(
		doScriptIndex < activateIndex,
		"do script must run before activate to avoid Terminal creating an empty default window",
	);
});

test("desktop restart no longer depends on the retired Feishu build app id", () => {
	const source = fs.readFileSync(
		new URL("../restart-desktop-remote.mjs", import.meta.url),
		"utf8",
	);
	assert.equal(source.includes("VITE_FEISHU_APP_ID"), false);
});

test("desktop restart clears only desktop Vite dev caches", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-dev-cache-"));
	const desktopCacheDirs = desktopDevCacheDirs(repo);
	const preservedDirs = [
		path.join(repo, "node_modules", ".vite"),
		path.join(repo, "apps", "mobile", "node_modules", ".vite"),
		path.join(repo, "packages", "maker-shared", "node_modules", ".vite"),
	];
	try {
		for (const dir of [...desktopCacheDirs, ...preservedDirs]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "marker"), "cached\n");
		}

		const logs = [];
		const removed = clearDesktopDevCaches(repo, { logger: { log: (message) => logs.push(message) } });

		assert.deepEqual(removed.map((entry) => path.relative(repo, entry)), [
			path.join("apps", "desktop", "node_modules", ".vite"),
			path.join("apps", "desktop", ".vite"),
		]);
		for (const dir of desktopCacheDirs) {
			assert.equal(fs.existsSync(dir), false);
		}
		for (const dir of preservedDirs) {
			assert.equal(fs.existsSync(path.join(dir, "marker")), true);
		}
		assert.match(logs.join("\n"), /Cleared desktop dev cache/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("desktop restart recognizes dev processes from sibling repository worktrees", () => {
	const mainRoot = path.resolve("/repo/cindy");
	const featureRoot = path.resolve("/repo/cindy-feature");
	const unrelatedRoot = path.resolve("/repo/unrelated");
	const worktrees = parseWorktreePaths([
		`worktree ${mainRoot}`,
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		`worktree ${featureRoot}`,
		"HEAD def456",
		"branch refs/heads/carol/feature",
	].join("\n"));

	assert.deepEqual(worktrees, [mainRoot, featureRoot]);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 42,
		command: `node ${path.join(featureRoot, "node_modules/@electron-forge/cli")} electron-forge start`,
	}, worktrees, 999), true);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 43,
		command: `node ${path.join(unrelatedRoot, "node_modules/@electron-forge/cli")} electron-forge start`,
	}, worktrees, 999), false);
});

test("desktop restart preserves durable PI Subagent runners", () => {
	const checkoutRoot = path.resolve("/repo/cindy-feature");
	const electron = path.join(checkoutRoot, "node_modules/electron/dist/Electron");
	const runner = path.resolve(
		"/user-data/owners/owner/runtime/pi-subagent-runs/session/run/runner.cjs",
	);
	const config = path.resolve(
		"/user-data/owners/owner/runtime/pi-subagent-runs/session/run/config.json",
	);

	assert.equal(isRepositoryDesktopDevProcess({
		pid: 44,
		command: `${electron} ${runner} ${config}`,
	}, [checkoutRoot], 999), false);
	assert.equal(isRepositoryDesktopDevProcess({
		pid: 45,
		command: `${electron} .`,
	}, [checkoutRoot], 999), true);
});

test("restart kill scope only targets the checkout that runs the script", () => {
	const ownRoot = path.resolve("/repo/cindy-feature");
	const otherRoot = path.resolve("/repo/cindy-pi-sandbox");
	const processes = [
		{ pid: 1, command: `node ${path.join(ownRoot, "node_modules/@electron-forge/cli")} start` },
		{ pid: 2, command: `${path.join(otherRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")} .` },
		{ pid: 3, command: `node ${path.join(ownRoot, "node_modules/electron/dist")} --app-path=${path.join(ownRoot, "apps/desktop")}` },
	];

	const { targets, preserved } = partitionDesktopDevProcesses(processes, ownRoot);
	assert.deepEqual(targets.map((proc) => proc.pid), [1, 3]);
	assert.deepEqual(preserved.map((proc) => proc.pid), [2]);
});

test("userData conflict detection matches exact sandbox dirs only", () => {
	const helper =
		"/repo/cindy-pi-sandbox/node_modules/electron/dist/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) " +
		"--type=renderer --user-data-dir=/Users/dev/Library/Application Support/Cindy-dev-pi-latest --standard-schemes=xdt-image";

	// 精确同名沙箱命中(路径含空格,值后面跟空格+下一个 flag)。
	assert.equal(
		commandUsesUserDataDir(helper, "/Users/dev/Library/Application Support/Cindy-dev-pi-latest"),
		true,
	);
	// 前缀同名不许误命中: Cindy-dev ≠ Cindy-dev-pi-latest, Cindy ≠ Cindy-dev-*。
	assert.equal(
		commandUsesUserDataDir(helper, "/Users/dev/Library/Application Support/Cindy-dev"),
		false,
	);
	assert.equal(
		commandUsesUserDataDir(helper, "/Users/dev/Library/Application Support/Cindy"),
		false,
	);
	// 行尾结束与尾斜杠归一。
	assert.equal(
		commandUsesUserDataDir(
			"electron --user-data-dir=/Users/dev/Library/Application Support/Cindy-dev-a",
			"/Users/dev/Library/Application Support/Cindy-dev-a/",
		),
		true,
	);
	// 完全无关的命令行不命中。
	assert.equal(
		commandUsesUserDataDir("node scripts/dev.mjs", "/Users/dev/Library/Application Support/Cindy-dev"),
		false,
	);
});

test("shared production userData path is region-aware", () => {
	assert.equal(path.basename(productionUserDataDir()), "CindyGlobal");
	assert.equal(path.basename(productionUserDataDir("global")), "CindyGlobal");
	assert.equal(path.basename(productionUserDataDir("cn")), "Cindy");
	assert.equal(path.basename(productionUserDataDir("dev")), "CindyDev");
});

test("default isolated userData path is region-aware", () => {
	assert.equal(path.basename(defaultIsolatedUserDataDir("", "global")), "CindyGlobal-dev2");
	assert.equal(path.basename(defaultIsolatedUserDataDir("", "cn")), "Cindy-dev2");
	assert.equal(path.basename(defaultIsolatedUserDataDir("review", "dev")), "CindyDev-dev2-review");
});

test("hasIsolationIntent sees argv and ambient XDT_ISOLATED=1", () => {
	assert.equal(hasIsolationIntent([]), false);
	assert.equal(hasIsolationIntent(["--isolated"]), true);
	assert.equal(hasIsolationIntent(["--isolated=review"]), true);
	assert.equal(hasIsolationIntent([], { XDT_ISOLATED: "1" }), true);
	assert.equal(hasIsolationIntent([], { XDT_ISOLATED: "0" }), false);
});

test("normalizeDesktopRestartArgv defaults to one stable sandbox across worktrees", () => {
	assert.deepEqual(normalizeDesktopRestartArgv(["--wait-ready"], {}), [
		"--wait-ready",
		DEFAULT_ISOLATED_ARG,
	]);
	assert.deepEqual(
		normalizeDesktopRestartArgv(["--wait-ready", "--isolated=review"], {}),
		["--wait-ready", "--isolated=review"],
	);
	assert.deepEqual(normalizeDesktopRestartArgv(["--wait-ready"], { XDT_ISOLATED: "1" }), [
		"--wait-ready",
	]);
	assert.deepEqual(normalizeDesktopRestartArgv(["--wait-ready", SHARED_USERDATA_ARG], {}), [
		"--wait-ready",
		SHARED_USERDATA_ARG,
	]);
	assert.deepEqual(
		normalizeDesktopRestartArgv(["--wait-ready", "--preserve-running"], {}),
		["--wait-ready", "--preserve-running"],
	);
});

test("--shared conflicts with explicit or ambient isolation", () => {
	assert.equal(
		desktopRestartArgvConflictMessage(["--shared", "--isolated"], {}),
		"--shared cannot be combined with --isolated or XDT_ISOLATED=1",
	);
	assert.equal(
		desktopRestartArgvConflictMessage(["--shared"], { XDT_ISOLATED: "1" }),
		"--shared cannot be combined with --isolated or XDT_ISOLATED=1",
	);
	assert.equal(desktopRestartArgvConflictMessage(["--shared"], {}), null);
});

test("isOfficialProductionUserDataDir matches every official region profile", () => {
	assert.equal(isOfficialProductionUserDataDir(productionUserDataDir("cn")), true);
	assert.equal(isOfficialProductionUserDataDir(productionUserDataDir("global")), true);
	assert.equal(isOfficialProductionUserDataDir(productionUserDataDir("dev")), true);
	assert.equal(isOfficialProductionUserDataDir(defaultIsolatedUserDataDir("", "cn")), false);
	assert.ok(officialProductionUserDataDirs().some((dir) => path.basename(dir) === "Cindy"));
	assert.ok(officialProductionUserDataDirs().some((dir) => path.basename(dir) === "CindyGlobal"));
});

test("isolated restart target pointing at the other region's official profile is refused", () => {
	const cnFromGlobal = resolveRestartTargetUserDataDir({
		envUserDataDir: productionUserDataDir("cn"),
		isolatedArg: "--isolated",
		selectedRegion: "global",
	});
	assert.equal(isOfficialProductionUserDataDir(cnFromGlobal), true);
	const globalFromCn = resolveRestartTargetUserDataDir({
		envUserDataDir: productionUserDataDir("global"),
		isolatedArg: "--isolated",
		selectedRegion: "cn",
	});
	assert.equal(isOfficialProductionUserDataDir(globalFromCn), true);
});

test("env-only XDT_ISOLATED=1 derives the default sandbox, not the official profile", () => {
	const target = resolveRestartTargetUserDataDir({
		isolatedEnv: "1",
		selectedRegion: "cn",
	});
	assert.equal(target, defaultIsolatedUserDataDir("", "cn"));
	assert.equal(isOfficialProductionUserDataDir(target), false);
	const named = resolveRestartTargetUserDataDir({
		isolatedEnv: "1",
		isolatedName: "review",
		selectedRegion: "global",
	});
	assert.equal(named, defaultIsolatedUserDataDir("review", "global"));
});

test("isolated auth accepts only the epoch sandbox derived by this restart", () => {
	const isolatedArg = "--isolated=oauth-review";
	const derived = defaultIsolatedUserDataDir("oauth-review", "global");
	const trusted = {
		isolatedArg,
		userDataDir: derived,
		userDataDirEpoch: "1",
		userDataDerivedByRestart: true,
		selectedRegion: "global",
	};

	// A freshly derived sandbox does not need an existing credential file.
	assert.equal(isTrustedIsolatedAuthUserDataDir(trusted), true);
	assert.equal(isTrustedIsolatedAuthUserDataDir({
		...trusted,
		userDataDerivedByRestart: false,
	}), false);
	assert.equal(isTrustedIsolatedAuthUserDataDir({
		...trusted,
		userDataDirEpoch: undefined,
	}), false);
	assert.equal(isTrustedIsolatedAuthUserDataDir({
		...trusted,
		userDataDir: path.join(os.tmpdir(), "shared-cindy-profile"),
	}), false);
});

test("isolated auth rejects an explicit userData even when it spoofs the derived path and epoch", () => {
	const isolatedArg = "--isolated=oauth-review";
	assert.equal(isTrustedIsolatedAuthUserDataDir({
		isolatedArg,
		userDataDir: defaultIsolatedUserDataDir("oauth-review", "global"),
		userDataDirEpoch: "1",
		userDataDerivedByRestart: false,
		selectedRegion: "global",
	}), false);
});

test("isolated auth rejects a derived userData symlink or junction before minting proof", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-isolated-alias-"));
	const savedEnv = {
		APPDATA: process.env.APPDATA,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	};
	try {
		if (process.platform === "win32") {
			process.env.APPDATA = path.join(root, "appdata");
			process.env.USERPROFILE = root;
		} else if (process.platform === "darwin") {
			process.env.HOME = root;
		} else {
			process.env.XDG_CONFIG_HOME = path.join(root, "config");
		}
		const isolatedArg = "--isolated=link-guard";
		const derived = defaultIsolatedUserDataDir("link-guard", "global");
		const unrelatedProfile = path.join(root, "unrelated-profile");
		fs.mkdirSync(path.dirname(derived), { recursive: true });
		fs.mkdirSync(unrelatedProfile, { recursive: true });
		fs.symlinkSync(
			unrelatedProfile,
			derived,
			process.platform === "win32" ? "junction" : "dir",
		);

		assert.equal(isTrustedIsolatedAuthUserDataDir({
			isolatedArg,
			userDataDir: derived,
			userDataDirEpoch: "1",
			userDataDerivedByRestart: true,
			selectedRegion: "global",
		}), false);
		assert.throws(
			() => createIsolatedAuthLaunchProof({ userDataDir: derived }),
			/symlink or junction/,
		);
		assert.equal(
			fs.existsSync(path.join(unrelatedProfile, ISOLATED_AUTH_LAUNCH_PROOF_FILE)),
			false,
		);
	} finally {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("isolated auth launch proof binds the current derived sandbox and is private", () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-isolated-proof-"));
	try {
		const nonce = "b".repeat(64);
		assert.equal(createIsolatedAuthLaunchProof({
			userDataDir,
			isolationName: "oauth-review",
			now: 123_000,
			nonce,
		}), nonce);
		const proofPath = path.join(userDataDir, ISOLATED_AUTH_LAUNCH_PROOF_FILE);
		const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
		assert.deepEqual(proof, {
			version: 1,
			nonce,
			userDataDir: canonicalizeUserDataDir(userDataDir),
			profileKind: "isolated-sandbox",
			epoch: 1,
			isolationName: "oauth-review",
			issuedAtMs: 123_000,
			expiresAtMs: 723_000,
		});
		if (process.platform !== "win32") assert.equal(fs.statSync(proofPath).mode & 0o077, 0);
		assert.deepEqual(fs.readdirSync(userDataDir), [ISOLATED_AUTH_LAUNCH_PROOF_FILE]);
	} finally {
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
});

test("isolated=@worktree derives the named sandbox from the checkout directory", () => {
	const root = path.join("/repo", "cindy-local-ollama-models");
	const name = isolationNameFromWorktree(root);
	const target = resolveRestartTargetUserDataDir({
		isolatedArg: "--isolated=@worktree",
		selectedRegion: "global",
		rootDir: root,
	});
	assert.match(name, /^local-ollama-models-[0-9a-f]{6}$/);
	assert.equal(target, defaultIsolatedUserDataDir(name, "global"));
});

test("invalid env isolation name falls back to the default sandbox", () => {
	assert.equal(sanitizeIsolationName("../Cindy"), "");
	assert.equal(sanitizeIsolationName("我的沙箱"), "");
	const target = resolveRestartTargetUserDataDir({
		isolatedEnv: "1",
		isolatedName: "../Cindy",
		selectedRegion: "cn",
	});
	assert.equal(target, defaultIsolatedUserDataDir("", "cn"));
	assert.equal(isOfficialProductionUserDataDir(target), false);
});

test("canonicalizeUserDataDir follows symlink parents when the leaf does not exist yet", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-canon-"));
	const realParent = path.join(root, "real");
	const linkParent = path.join(root, "link");
	try {
		fs.mkdirSync(realParent);
		fs.symlinkSync(realParent, linkParent, process.platform === "win32" ? "junction" : "dir");
		const viaLink = canonicalizeUserDataDir(path.join(linkParent, "Cindy"));
		const viaReal = canonicalizeUserDataDir(path.join(realParent, "Cindy"));
		assert.equal(viaLink, viaReal);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("isolated official-profile refuse happens before mkdir in the restart main flow", () => {
	const source = fs.readFileSync(new URL("../restart-desktop-remote.mjs", import.meta.url), "utf8");
	const refuseIdx = source.indexOf("isOfficialProductionUserDataDir(targetUserDataDir)");
	const mkdirIdx = source.indexOf("fs.mkdirSync(process.env.XDT_USER_DATA_DIR");
	assert.ok(refuseIdx > 0);
	assert.ok(mkdirIdx > refuseIdx);
});

test("isolated auth trust gate runs before credential write flags and userData creation", () => {
	const source = fs.readFileSync(new URL("../restart-desktop-remote.mjs", import.meta.url), "utf8");
	const trustIdx = source.lastIndexOf("if (!isTrustedIsolatedAuthUserDataDir({");
	const authFlagIdx = source.indexOf("process.env.XDT_ISOLATED_AUTH = '1';");
	const mkdirIdx = source.indexOf("fs.mkdirSync(process.env.XDT_USER_DATA_DIR");
	assert.ok(trustIdx > 0);
	assert.ok(authFlagIdx > trustIdx);
	assert.ok(mkdirIdx > authFlagIdx);
});

test("isolated auth proof is minted only by this invocation's accepted flag path", () => {
	const source = fs.readFileSync(new URL("../restart-desktop-remote.mjs", import.meta.url), "utf8");
	const ambientDeleteIdx = source.indexOf("delete process.env.XDT_ISOLATED_AUTH_PROOF;");
	const authorizeIdx = source.indexOf("isolatedAuthAuthorizedByRestart = true;");
	const mintGuardIdx = source.indexOf("if (isolatedAuthAuthorizedByRestart) {");
	const mintIdx = source.indexOf("createIsolatedAuthLaunchProof({", mintGuardIdx);
	assert.ok(ambientDeleteIdx > 0);
	assert.ok(authorizeIdx > ambientDeleteIdx);
	assert.ok(mintGuardIdx > authorizeIdx);
	assert.ok(mintIdx > mintGuardIdx);
});

test("preserve-running only shares a target with live records from the same region", () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-shared-region-"));
	const records = path.join(userData, ".dev-instances");
	const knownRoot = path.resolve("/repo/cindy-global");
	fs.mkdirSync(records);
	try {
		fs.writeFileSync(
			path.join(records, `${process.pid}.json`),
			`${JSON.stringify({ schemaVersion: 1, pid: process.pid, region: "global", rootDir: knownRoot })}\n`,
		);
		const processes = [{
			pid: process.pid + 1,
			command: `electron --type=renderer --user-data-dir=${userData} --app-path=${path.join(knownRoot, "apps", "desktop")}`,
		}];
		assert.deepEqual(inspectSharedUserDataRegion(userData, "global", processes), {
			compatible: true,
			reason: null,
		});
		const mismatch = inspectSharedUserDataRegion(userData, "cn", processes);
		assert.equal(mismatch.compatible, false);
		assert.match(mismatch.reason, /pid=.*region=global/);

		fs.writeFileSync(
			path.join(records, `${process.pid}.json`),
			`${JSON.stringify({ schemaVersion: 1, pid: process.pid, rootDir: knownRoot })}\n`,
		);
		const unknown = inspectSharedUserDataRegion(userData, "global", processes);
		assert.equal(unknown.compatible, false);
		assert.match(unknown.reason, /region=unknown/);

		fs.writeFileSync(
			path.join(records, `${process.pid}.json`),
			`${JSON.stringify({ schemaVersion: 1, pid: process.pid, region: "global", rootDir: knownRoot })}\n`,
		);
		const unrecorded = inspectSharedUserDataRegion(userData, "global", [
			...processes,
			{
				pid: process.pid + 2,
				command: `electron --type=renderer --user-data-dir=${userData} --app-path=/repo/unknown/apps/desktop`,
			},
		]);
		assert.equal(unrecorded.compatible, false);
		assert.match(unrecorded.reason, /not covered/);
		assert.match(unrecorded.reason, new RegExp(`pid=${process.pid + 2}`));
	} finally {
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("desktop restart runner forwards user args (incl. --isolated) into the kill stage", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(
		["--region=global", "--isolated=tgbot-review", "--wait-ready"],
		root,
	);
	assert.deepEqual(steps[0].args, [
		stepScript(root, "restart-desktop-remote.mjs"),
		"--region=global",
		"--isolated=tgbot-review",
		"--kill-only",
	]);
	assert.deepEqual(steps[steps.length - 1].args, [
		stepScript(root, "restart-desktop-remote.mjs"),
		"--region=global",
		"--isolated=tgbot-review",
		"--wait-ready",
	]);
});

test("desktop restart runner keeps the kill-before-deps order by default", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(["--wait-ready"], root);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "restart-desktop-remote.mjs"), "--kill-only"],
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[stepScript(root, "restart-desktop-remote.mjs"), "--wait-ready"],
	]);
});

test("desktop restart process-control phase does not initialize startup configuration", () => {
	const processControlEnv = {};
	assert.equal(
		applyDesktopStartupConfigForPhase({
			argv: ["--kill-only", "--region=global", "--endpoints-cdn"],
			env: processControlEnv,
			mode: "remote",
		}),
		null,
	);
	assert.deepEqual(processControlEnv, {});

	const startupEnv = {};
	assert.deepEqual(
		applyDesktopStartupConfigForPhase({
			argv: ["--region=global"],
			env: startupEnv,
			mode: "remote",
		}),
		{
			region: "global",
			endpointsCdn: false,
			endpointManifestFile: "config/endpoint.global.json",
		},
	);
	assert.deepEqual(startupEnv, {
		CINDY_AUTH_REGION: "global",
		VITE_CINDY_AUTH_REGION: "global",
		XDT_ENDPOINT_MANIFEST_FILE: "config/endpoint.global.json",
	});
});

test("desktop restart rejects an unmerged migration before the kill step when --shared is explicit", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-restart-policy-"));
	const calls = [];
	try {
		fs.mkdirSync(path.join(repo, "apps", "desktop", "drizzle"), { recursive: true });
		fs.writeFileSync(path.join(repo, "apps", "desktop", "drizzle", "0000_init.sql"), "SELECT 0;\n");
		const git = (...args) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		};
		git("init", "-b", "main");
		git("config", "user.name", "Restart Policy Test");
		git("config", "user.email", "restart-policy@example.invalid");
		git("add", ".");
		git("commit", "-m", "base");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		git("switch", "-c", "feature");
		fs.writeFileSync(path.join(repo, "apps", "desktop", "drizzle", "0001_feature.sql"), "SELECT 1;\n");

		assert.throws(
			() => runDesktopRestart(["--wait-ready", "--", "--shared"], repo, (step) => calls.push(step)),
			/Shared Cindy userData cannot run migration artifacts/,
		);
		assert.deepEqual(calls, []);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("desktop restart defaults to the stable dev sandbox without the shared migration gate", () => {
	const steps = [];
	runDesktopRestart(["--wait-ready"], "/repo/cindy", (step) => steps.push(step));
	assert.equal(steps.length, 4);
	assert.ok(steps[0].args.includes(DEFAULT_ISOLATED_ARG));
	assert.equal(steps[0].args.at(-1), "--kill-only");
	assert.ok(steps.at(-1).args.includes(DEFAULT_ISOLATED_ARG));
	assert.equal(steps.at(-1).args.at(-1), "--wait-ready");
});

test("preserve-running skips every kill stage and reaches the readiness start", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running"],
		root,
	);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[
			stepScript(root, "restart-desktop-remote.mjs"),
			"--preserve-running",
			"--wait-ready",
		],
	]);
});

test("precise replacement stays in the preserve-running pipeline", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(
		["--wait-ready", "--", "--preserve-running", "--replace-running-root=/repo/old-preview"],
		root,
	);
	assert.deepEqual(steps.map((step) => step.args), [
		[stepScript(root, "ensure-deps.mjs")],
		[stepScript(root, "ensure-dev-runtime-assets.mjs")],
		[
			stepScript(root, "restart-desktop-remote.mjs"),
			"--preserve-running",
			"--replace-running-root=/repo/old-preview",
			"--wait-ready",
		],
	]);
});

test("local restart keeps --local on both process-control stages", () => {
	const root = "/repo/cindy";
	const steps = buildDesktopRestartSteps(["--local", "--wait-ready"], root);
	assert.deepEqual(steps[0].args, [
		stepScript(root, "restart-desktop-remote.mjs"),
		"--local",
		"--kill-only",
	]);
	assert.deepEqual(steps.at(-1).args, [
		stepScript(root, "restart-desktop-remote.mjs"),
		"--local",
		"--wait-ready",
	]);
});

test("desktop readiness status is parsed only after an atomic status file appears", () => {
	const statusPath = new URL(`./startup-${process.pid}.json`, import.meta.url);
	try {
		assert.equal(readDesktopStartupStatus(statusPath), null);
		fs.writeFileSync(statusPath, '{"state":"ready","pid":123}\n');
		assert.deepEqual(readDesktopStartupStatus(statusPath), { state: "ready", pid: 123 });
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("desktop readiness waiter removes an acknowledged ready status", async () => {
	const statusPath = fileURLToPath(new URL(`./startup-ready-${process.pid}.json`, import.meta.url));
	try {
		fs.writeFileSync(statusPath, '{"state":"ready","pid":123}\n');
		await waitForDesktopStartup(statusPath, 10);
		assert.equal(fs.existsSync(statusPath), false);
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("desktop readiness waiter keeps waiting after ready-to-show and surfaces database failure", async () => {
	const statusPath = fileURLToPath(new URL(`./startup-db-failed-${process.pid}.json`, import.meta.url));
	try {
		fs.writeFileSync(statusPath, '{"state":"window-ready","pid":123}\n');
		setTimeout(() => {
			fs.writeFileSync(statusPath, JSON.stringify({
				state: "failed",
				code: "MIGRATE_FAILED",
				message: "applied migration runtime identity changed at seq 77 (0077_nebulous_veda.sql)",
			}) + "\n");
		}, 10);

		await assert.rejects(
			waitForDesktopStartup(statusPath, 1_000),
			/MIGRATE_FAILED.*seq 77.*0077_nebulous_veda\.sql/,
		);
		assert.equal(fs.existsSync(statusPath), false);
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("desktop readiness timeout leaves an abandoned tombstone for late Electron events", async () => {
	const statusPath = fileURLToPath(new URL(`./startup-timeout-${process.pid}.json`, import.meta.url));
	try {
		fs.writeFileSync(statusPath, '{"state":"pending"}\n');
		await assert.rejects(waitForDesktopStartup(statusPath, 0), /did not finish window\/auth\/database startup/);
		assert.equal(readDesktopStartupStatus(statusPath)?.state, "abandoned");
	} finally {
		fs.rmSync(statusPath, { force: true });
	}
});

test("structured startup failures keep their actionable reason", () => {
	assert.equal(
		formatDesktopStartupFailure({
			state: "failed",
			code: "SINGLE_INSTANCE_OWNED",
			message: "Another Cindy instance owns the primary slot.",
			detail: { userDataDir: "/tmp/Cindy" },
		}),
		"[SINGLE_INSTANCE_OWNED] Another Cindy instance owns the primary slot. (userDataDir=/tmp/Cindy)",
	);
});

test("desktop whoami identifies multiple passive previews sharing one userData", () => {
	const previewRoot = path.resolve("/repo/cindy-preview");
	const previewRootTwo = path.resolve("/repo/cindy-preview-two");
	const userData = path.resolve("/tmp/Cindy");
	const worktrees = parseWorktreeEntries([
		`worktree ${previewRoot}`,
		"HEAD abc123",
		"branch refs/heads/carol/preview/example",
		"",
		`worktree ${previewRootTwo}`,
		"HEAD def456",
		"branch refs/heads/carol/preview/two",
	].join("\n"));
	const electronMain = path.join(previewRoot, "node_modules", "electron", "dist", "Electron");
	const electronHelper = path.join(previewRoot, "node_modules", "electron", "helper");
	const appPath = path.join(previewRoot, "apps", "desktop");
	const devEnv = path.join(previewRoot, "apps", "desktop", "scripts", "dev-remote-env.mjs");
	const electronMainTwo = path.join(previewRootTwo, "node_modules", "electron", "dist", "Electron");
	const electronHelperTwo = path.join(previewRootTwo, "node_modules", "electron", "helper");
	const appPathTwo = path.join(previewRootTwo, "apps", "desktop");
	const devEnvTwo = path.join(previewRootTwo, "apps", "desktop", "scripts", "dev-remote-env.mjs");
	const processes = [
		{ pid: 10, ppid: 9, command: `${electronMain} .` },
		{ pid: 11, ppid: 10, command: `${electronHelper} --type=renderer --user-data-dir=${userData} --app-path=${appPath}` },
		{ pid: 9, ppid: 8, command: `XDT_SCHEDULER_PASSIVE='1' node ${devEnv} electron-forge start` },
		{ pid: 20, ppid: 19, command: `${electronMainTwo} .` },
		{ pid: 21, ppid: 20, command: `${electronHelperTwo} --type=renderer --user-data-dir=${userData} --app-path=${appPathTwo}` },
		{ pid: 19, ppid: 18, command: `set "XDT_SCHEDULER_PASSIVE=1" && node ${devEnvTwo} electron-forge start` },
	];
	const instances = identifyDesktopProcesses(processes, worktrees);

	assert.deepEqual(instances, [{
		pid: 10,
		rootDir: previewRoot,
		branch: "carol/preview/example",
		state: "ready",
		ready: true,
		mode: "remote",
		passive: true,
		isolated: null,
		userDataDir: userData,
		commit: null,
		commitVerified: false,
		source: "process-scan",
	}, {
		pid: 20,
		rootDir: previewRootTwo,
		branch: "carol/preview/two",
		state: "ready",
		ready: true,
		mode: "remote",
		passive: true,
		isolated: null,
		userDataDir: userData,
		commit: null,
		commitVerified: false,
		source: "process-scan",
	}]);
});

test("passive previews do not use a one-slot userData lock", () => {
	const bootstrap = fs.readFileSync(
		new URL("../../apps/desktop/src/main/bootstrap-electron.ts", import.meta.url),
		"utf8",
	);
	assert.equal(bootstrap.includes(".passive-dev.lock"), false);
	assert.equal(
		fs.existsSync(new URL("../../apps/desktop/src/main/passiveDevLock.ts", import.meta.url)),
		false,
	);
});

test("desktop whoami prefers launch-time commit metadata over process inference", () => {
	const worktrees = [{ rootDir: "/repo/cindy-preview", branch: "carol/preview/example" }];
	const scanned = [{
		pid: 10,
		rootDir: "/repo/cindy-preview",
		branch: "carol/preview/example",
		state: "ready",
		ready: true,
		mode: "unknown",
		passive: false,
		isolated: null,
		userDataDir: "/tmp/Cindy",
		commit: null,
		commitVerified: false,
		source: "process-scan",
	}];
	const merged = mergeDesktopInstanceRecords(scanned, [{
		pid: 10,
		rootDir: "/repo/cindy-preview",
		state: "ready",
		mode: "remote",
		region: "global",
		passive: true,
		isolated: false,
		userDataDir: "/tmp/Cindy",
		commit: "abc123",
		startedAtMs: 1,
		updatedAtMs: 2,
	}], worktrees);

	assert.equal(merged[0].commit, "abc123");
	assert.equal(merged[0].commitVerified, true);
	assert.equal(merged[0].region, "global");
	assert.equal(merged[0].source, "record");
});

// ── 登录 scenario harness env 白名单透传(implementation-plan Step 0 WHAT4)──

test("devEnvPrefix passes XDT_LOGIN_SCENARIO and VITE_SPLASH_PHASE_FIXTURE through on macOS with shell-safe quoting", () => {
	const prefix = devEnvPrefix(
		{
			XDT_LOGIN_SCENARIO: "error:verify-code:INVALID_CODE",
			VITE_SPLASH_PHASE_FIXTURE: "spawn_failed",
		},
		"darwin",
	);
	assert.equal(
		prefix,
		"XDT_LOGIN_SCENARIO='error:verify-code:INVALID_CODE' VITE_SPLASH_PHASE_FIXTURE='spawn_failed' ",
	);
});

test("devEnvPrefix escapes single quotes in scenario values on POSIX shells", () => {
	const prefix = devEnvPrefix({ XDT_LOGIN_SCENARIO: "providers:both'x" }, "darwin");
	// shellSingleQuote 语义:内嵌单引号切段转义,拼回后 shell 读到原值。
	assert.ok(prefix.startsWith("XDT_LOGIN_SCENARIO='"));
	assert.ok(prefix.includes("'\\''") || prefix.includes("'\"'\"'"));
});

test("devEnvPrefix passes harness envs through on Windows cmd with quote stripping", () => {
	const prefix = devEnvPrefix(
		{
			XDT_LOGIN_SCENARIO: 'providers:"both"',
			VITE_SPLASH_PHASE_FIXTURE: "updating",
		},
		"win32",
	);
	assert.equal(
		prefix,
		'set "XDT_LOGIN_SCENARIO=providers:both" && set "VITE_SPLASH_PHASE_FIXTURE=updating" && ',
	);
});

test("devEnvPrefix omits harness envs when unset (whitelist stays opt-in)", () => {
	assert.equal(devEnvPrefix({}, "darwin"), "");
});

test("devEnvPrefix passes the explicit isolated OAuth write escape hatch", () => {
	assert.equal(
		devEnvPrefix(
			{
				XDT_ISOLATED_AUTH: "1",
				XDT_ALLOW_DEV_OAUTH_WRITE: "1",
				XDT_ISOLATED_AUTH_PROOF: "proof-nonce",
			},
			"darwin",
		),
		"XDT_ISOLATED_AUTH='1' XDT_ALLOW_DEV_OAUTH_WRITE='1' " +
			"XDT_ISOLATED_AUTH_PROOF='proof-nonce' ",
	);
});

test("devEnvPrefix passes explicit model catalog test controls to Desktop", () => {
	const prefix = devEnvPrefix(
		{
			XDT_MODELS_URL: "http://127.0.0.1:43181/api/model-catalog/catalog",
			XDT_MODELS_PATH: "/tmp/model catalog.json",
			XDT_DISABLE_MODELS_FETCH: "1",
		},
		"darwin",
	);
	assert.equal(
		prefix,
		"XDT_MODELS_URL='http://127.0.0.1:43181/api/model-catalog/catalog' " +
			"XDT_MODELS_PATH='/tmp/model catalog.json' XDT_DISABLE_MODELS_FETCH='1' ",
	);
});

test("devEnvPrefix passes native iOS dev switches to Electron", () => {
	assert.equal(
		devEnvPrefix(
			{
				CINDY_IOS_SIMULATOR_NATIVE_H264: "1",
				CINDY_IOS_SIMULATOR_NATIVE_HID: "1",
			},
			"darwin",
		),
		"CINDY_IOS_SIMULATOR_NATIVE_H264='1' CINDY_IOS_SIMULATOR_NATIVE_HID='1' ",
	);
});

test("formatDesktopDevVerdict prints a grepable ready block", () => {
	const text = formatDesktopDevVerdict({
		state: "ready",
		mode: "isolated",
		sandbox: "local-ollama",
		root: "/repo/cindy-local-ollama",
		commit: "abc123",
		pid: 42,
		region: "global",
	});
	assert.equal(
		text,
		[
			`${DESKTOP_DEV_VERDICT_PREFIX}=ready`,
			"mode=isolated",
			"sandbox=local-ollama",
			"root=/repo/cindy-local-ollama",
			"commit=abc123",
			"pid=42",
			"region=global",
			"",
		].join("\n"),
	);
});

test("formatDesktopDevVerdict flattens failed messages and keeps next", () => {
	const text = formatDesktopDevVerdict({
		state: "failed",
		code: "MIGRATION_POLICY",
		message: "Shared Cindy userData cannot run\nmigration artifacts",
		next: ISOLATED_RESTART_NEXT,
	});
	assert.match(text, new RegExp(`^${DESKTOP_DEV_VERDICT_PREFIX}=failed\\n`));
	assert.match(text, /code=MIGRATION_POLICY/);
	assert.match(text, /message=Shared Cindy userData cannot run migration artifacts/);
	assert.match(text, /next=pnpm restart:desktop:remote -- --isolated=@worktree/);
});

test("isolationNameFromWorktree strips cindy-, adds a path digest, and stays within 32 chars", () => {
	const named = isolationNameFromWorktree("/Users/dash/Code/Cindy/cindy-local-ollama-models");
	assert.match(named, /^local-ollama-models-[0-9a-f]{6}$/);
	assert.notEqual(
		named,
		isolationNameFromWorktree("/tmp/cindy-local-ollama-models"),
	);
	assert.match(
		isolationNameFromWorktree("/tmp/cindy-desktop-dev-startup-verdict"),
		/^desktop-dev-startup-verdi-[0-9a-f]{6}$/,
	);
	assert.match(isolationNameFromWorktree("/tmp/!!!"), /^worktree-[0-9a-f]{6}$/);
	assert.ok(isolationNameFromWorktree(`/tmp/cindy-${"a".repeat(80)}`).length <= 32);
});

test("resolveIsolatedArg expands @worktree to a named sandbox", () => {
	const root = "/repo/cindy-local-ollama-models";
	const expanded = resolveIsolatedArg(WORKTREE_ISOLATED_ARG, root);
	assert.match(expanded, /^--isolated=local-ollama-models-[0-9a-f]{6}$/);
	assert.equal(expanded, resolveIsolatedArg(WORKTREE_ISOLATED_ARG, root));
	assert.equal(resolveIsolatedArg("--isolated=feature-a", "/repo/x"), "--isolated=feature-a");
	assert.equal(resolveIsolatedArg("--isolated", "/repo/x"), "--isolated");
});

test("shouldRefuseHostedRestart blocks same-checkout hosts and other-checkout shared starts", () => {
	const own = "/repo/cindy-feature";
	const other = "/repo/cindy-other";
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `electron-forge start ${own}` },
			{ preserveRunning: false, ownRootDir: own, isolated: true },
		),
		true,
	);
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `electron-forge start ${other}` },
			{ preserveRunning: false, ownRootDir: own, isolated: true },
		),
		false,
	);
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `electron-forge start ${other}` },
			{ preserveRunning: false, ownRootDir: own, isolated: false },
		),
		true,
	);
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `electron-forge start ${own}` },
			{ preserveRunning: true, ownRootDir: own },
		),
		false,
	);
	assert.equal(
		shouldRefuseHostedRestart(null, { preserveRunning: false, ownRootDir: own }),
		false,
	);
});

test("whoami match becomes a ready verdict", () => {
	const root = path.resolve("/repo/cindy-preview");
	const verdict = buildDesktopDevVerdictFromWhoami({
		match: true,
		expected: { rootDir: root, commit: "abc123" },
		instances: [{
			pid: 99,
			rootDir: root,
			ready: true,
			commitVerified: true,
			commit: "abc123",
			isolated: true,
			region: "global",
		}],
	}, { isolated: true, sandbox: "preview" });
	assert.deepEqual(verdict, {
		state: "ready",
		mode: "isolated",
		sandbox: "preview",
		root,
		commit: "abc123",
		pid: 99,
		region: "global",
	});
});

test("whoami mismatch on shared start suggests isolated retry", () => {
	const root = path.resolve("/repo/cindy-preview");
	const verdict = buildDesktopDevVerdictFromWhoami({
		match: false,
		expected: { rootDir: root, commit: "abc123" },
		instances: [],
	}, { isolated: false });
	assert.equal(verdict.state, "failed");
	assert.equal(verdict.code, "WHOAMI_MISMATCH");
	assert.equal(verdict.next, ISOLATED_RESTART_NEXT);
});

test("shared migration policy failure keeps an isolated next command", () => {
	const verdict = buildDesktopDevVerdictFromFailure(
		new Error("Shared Cindy userData cannot run migration artifacts that are not canonical on origin/main."),
		{ isolated: false, rootDir: "/repo/cindy-feature" },
	);
	assert.equal(verdict.state, "failed");
	assert.equal(verdict.code, "MIGRATION_POLICY");
	assert.equal(verdict.next, ISOLATED_RESTART_NEXT);
	assert.equal(verdict.root, "/repo/cindy-feature");
});

test("isolated failures do not suggest another isolated start", () => {
	assert.equal(shouldSuggestIsolatedNext({ isolated: true, code: "MIGRATE_FAILED" }), false);
	const verdict = buildDesktopDevVerdictFromFailure(
		Object.assign(new Error("[MIGRATE_FAILED] applied identity changed"), {
			startupStatus: { code: "MIGRATE_FAILED", message: "applied identity changed" },
		}),
		{ isolated: true, sandbox: "feature" },
	);
	assert.equal(verdict.code, "MIGRATE_FAILED");
	assert.equal(verdict.next, undefined);
	assert.equal(verdict.mode, "isolated");
});

test("inferDesktopDevFailureCode reads tagged startup failures", () => {
	assert.equal(inferDesktopDevFailureCode("[SINGLE_INSTANCE_OWNED] owned"), "SINGLE_INSTANCE_OWNED");
	assert.equal(
		inferDesktopDevFailureCode("Desktop dev did not finish window/auth/database startup within 120s."),
		"STARTUP_TIMEOUT",
	);
});

test("collectDesktopWhoamiReport can be built from injected process facts", () => {
	const root = path.resolve("/repo/cindy-preview");
	const report = collectDesktopWhoamiReport({
		rootDir: root,
		commit: "abc123",
		worktrees: [{ rootDir: root, branch: "dash/preview" }],
		processes: [],
		scanned: [{
			pid: 10,
			rootDir: root,
			branch: "dash/preview",
			state: "ready",
			ready: true,
			mode: "remote",
			passive: true,
			isolated: null,
			userDataDir: "/tmp/Cindy",
			commit: null,
			commitVerified: false,
			source: "process-scan",
		}],
		records: [{
			schemaVersion: 1,
			pid: 10,
			rootDir: root,
			state: "ready",
			mode: "remote",
			region: "global",
			passive: true,
			isolated: false,
			userDataDir: "/tmp/Cindy",
			commit: "abc123",
			startedAtMs: 1,
			updatedAtMs: 2,
		}],
	});
	assert.equal(report.match, true);
	assert.equal(buildDesktopDevVerdictFromWhoami(report).state, "ready");
});

test("isolatedRestartNextCommand keeps region and local mode", () => {
	assert.equal(isolatedRestartNextCommand(), ISOLATED_RESTART_NEXT);
	assert.equal(
		isolatedRestartNextCommand({ region: "cn" }),
		"pnpm restart:desktop:remote --region=cn -- --isolated=@worktree",
	);
	assert.equal(
		isolatedRestartNextCommand({ local: true }),
		"pnpm restart:desktop:local -- --isolated=@worktree",
	);
	const verdict = buildDesktopDevVerdictFromFailure(
		new Error("Shared Cindy userData cannot run migration artifacts that are not canonical on origin/main."),
		{ isolated: false, region: "cn" },
	);
	assert.equal(verdict.next, "pnpm restart:desktop:remote --region=cn -- --isolated=@worktree");
});

test("host identity uses the same conservative path match as kill", () => {
	const own = "/repo/cindy-feature";
	assert.equal(commandContainsPath(`electron-forge start ${own} --isolated=feature`, own), false);
	assert.equal(commandContainsPath(`${own}/node_modules/electron`, own), true);
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `${own}/node_modules/electron` },
			{ preserveRunning: false, ownRootDir: own, isolated: true },
		),
		true,
	);
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: `${own} extra/node_modules/electron` },
			{ preserveRunning: false, ownRootDir: own, isolated: true },
		),
		false,
	);
});

test("hosted restart sees XDT_ISOLATED as isolation intent", () => {
	const own = "/repo/cindy-feature";
	const other = "/repo/cindy-other/node_modules/electron";
	assert.equal(
		shouldRefuseHostedRestart(
			{ pid: 10, command: other },
			{ preserveRunning: false, ownRootDir: own, isolated: true },
		),
		false,
	);
});

test("restartContextFromArgv reads --region cn and XDT_ISOLATED", () => {
	assert.equal(restartContextFromArgv(["--region", "cn"]).region, "cn");
	assert.equal(restartContextFromArgv([], { XDT_ISOLATED: "1" }).isolated, true);
	assert.equal(
		buildDesktopDevVerdictFromFailure(new Error("WHOAMI_MISMATCH"), {
			...restartContextFromArgv(["--region", "cn"]),
		}).next,
		"pnpm restart:desktop:remote --region=cn -- --isolated=@worktree",
	);
});

test("worktree sandbox hash follows the foldCase option from the volume", () => {
	assert.equal(
		isolationNameFromWorktree("/repo/Foo/cindy-feature", { foldCase: true }),
		isolationNameFromWorktree("/repo/foo/cindy-feature", { foldCase: true }),
	);
	assert.notEqual(
		isolationNameFromWorktree("/repo/Foo/cindy-feature", { foldCase: false }),
		isolationNameFromWorktree("/repo/foo/cindy-feature", { foldCase: false }),
	);
});

test("named isolated does not keep another checkout's inherited userData dir", () => {
	const derived = defaultIsolatedUserDataDir("local-ollama-models-abc123", "global");
	assert.equal(
		inheritedUserDataBlocksNamedIsolation(
			"--isolated=local-ollama-models-abc123",
			defaultIsolatedUserDataDir("other-sandbox", "global"),
			derived,
		),
		true,
	);
	assert.equal(
		inheritedUserDataBlocksNamedIsolation("--isolated=local-ollama-models-abc123", derived, derived),
		false,
	);
	assert.equal(
		inheritedUserDataBlocksNamedIsolation("--isolated", defaultIsolatedUserDataDir("other-sandbox", "global"), derived),
		false,
	);
	assert.equal(
		inheritedUserDataBlocksNamedIsolation("--isolated=local-ollama-models-abc123", "/custom/profile", derived),
		false,
	);
});

test("assertDesktopRestartStepSucceeded throws so runner can print a verdict", () => {
	assert.throws(
		() => assertDesktopRestartStepSucceeded(
			{ label: "verify desktop dependencies", args: ["ensure-deps.mjs"] },
			{ status: 1 },
		),
		(error) => error instanceof DesktopRestartStepError
			&& error.alreadyHasVerdict === false
			&& error.exitCode === 1,
	);
	assert.throws(
		() => assertDesktopRestartStepSucceeded(
			{ label: "start desktop and wait for readiness", args: ["restart.mjs", "--wait-ready"] },
			{ status: 2 },
		),
		(error) => error instanceof DesktopRestartStepError && error.alreadyHasVerdict === true,
	);
	assert.throws(
		() => assertDesktopRestartStepSucceeded(
			{ label: "stop existing desktop dev processes", args: ["restart.mjs", "--kill-only"] },
			{ status: 1 },
		),
		(error) => error instanceof DesktopRestartStepError && error.alreadyHasVerdict === true,
	);
});
