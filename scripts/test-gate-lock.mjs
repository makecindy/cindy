import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const LOCK_HOST = "127.0.0.1";
const LOCK_PORT_START = 49_152;
const LOCK_PORT_COUNT = 16_000;
const LOCK_PORT_CANDIDATES = 32;
const LOCK_PROTOCOL = "cindy-test-workspaces-lock-v1";
const PROBE_TIMEOUT_MS = 1_000;
const RETRY_DELAY_MS = 500;
const WAIT_REPORT_INTERVAL_MS = 60_000;
const HEAVY_TEST_TIERS = new Set(["unit", "db", "git-integration"]);
const BIND_DENIED_ERROR_CODES = new Set(["EACCES", "EPERM"]);

export const TEST_GATE_LOCK_TIMEOUT_EXIT_CODE = 75;
export const DEFAULT_TEST_GATE_LOCK_TIMEOUT_MS = 15 * 60_000;

export class TestGateLockTimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = "TestGateLockTimeoutError";
		this.exitCode = TEST_GATE_LOCK_TIMEOUT_EXIT_CODE;
	}
}

function delay(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function enabledEnvironmentFlag(value) {
	if (value === undefined || value === null) return false;
	const normalized = String(value).trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export function isTestGateCiEnvironment(env = process.env) {
	return (
		enabledEnvironmentFlag(env.CI) ||
		enabledEnvironmentFlag(env.GITHUB_ACTIONS)
	);
}

export function shouldUseTestGateLock({
	all = false,
	tier = "unit",
	noLock = false,
	env = process.env,
} = {}) {
	if (noLock || isTestGateCiEnvironment(env)) return false;
	return all || HEAVY_TEST_TIERS.has(tier);
}

export async function resolveTestGateCommonDir(repoRoot) {
	const dotGitPath = path.join(repoRoot, ".git");
	let dotGitStat;
	try {
		dotGitStat = await fs.stat(dotGitPath);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return fs.realpath(repoRoot);
	}
	if (dotGitStat.isDirectory()) return fs.realpath(dotGitPath);

	const gitDirLine = (await fs.readFile(dotGitPath, "utf8")).trim();
	const gitDirMatch = /^gitdir:\s*(.+)$/i.exec(gitDirLine);
	if (!gitDirMatch) throw new Error(`Invalid gitdir file: ${dotGitPath}`);
	const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
	try {
		const commonDir = (await fs.readFile(path.join(gitDir, "commondir"), "utf8"))
			.trim();
		return fs.realpath(path.resolve(gitDir, commonDir));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return fs.realpath(gitDir);
	}
}

export function testGateLockIdentity(commonDir, platform = process.platform) {
	const normalized = platform === "win32" ? commonDir.toLowerCase() : commonDir;
	return createHash("sha256")
		.update(`${LOCK_PROTOCOL}\0${normalized}`)
		.digest("hex");
}

function lockPort(identity, candidate) {
	const baseOffset = Number.parseInt(identity.slice(0, 8), 16) % LOCK_PORT_COUNT;
	return LOCK_PORT_START + ((baseOffset + candidate) % LOCK_PORT_COUNT);
}

export function classifyTestGateLockProbeError(code) {
	return code === "ECONNREFUSED" ? "available" : "collision";
}

export function decideTestGateLock(probes) {
	const owner = probes.find((probe) => probe.result === "owner");
	if (owner) return { type: "wait", owner: owner.owner };
	const available = probes.find((probe) => probe.result === "available");
	return available
		? { type: "acquire", port: available.port }
		: { type: "unavailable" };
}

function parseOwnerBanner(response, identity) {
	try {
		const parsed = JSON.parse(response);
		if (
			parsed?.protocol !== LOCK_PROTOCOL ||
			parsed?.identity !== identity ||
			!parsed.owner ||
			typeof parsed.owner !== "object"
		) {
			return null;
		}
		return parsed.owner;
	} catch {
		return null;
	}
}

function probeLock(port, identity) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host: LOCK_HOST, port });
		let response = "";
		let settled = false;
		const finish = (result, owner) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ port, result, ...(owner ? { owner } : {}) });
		};

		socket.setEncoding("utf8");
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.on("data", (chunk) => {
			response += chunk;
			if (response.length > 16 * 1024) {
				finish("collision");
				return;
			}
			if (!response.includes("\n")) return;
			const owner = parseOwnerBanner(response.trim(), identity);
			finish(owner ? "owner" : "collision", owner);
		});
		socket.on("end", () => {
			const owner = parseOwnerBanner(response.trim(), identity);
			finish(owner ? "owner" : "collision", owner);
		});
		socket.on("timeout", () => finish("collision"));
		socket.on("error", (error) =>
			finish(classifyTestGateLockProbeError(error?.code)),
		);
	});
}

async function probeCandidates(ports, identity) {
	return Promise.all(ports.map((port) => probeLock(port, identity)));
}

function listen(server, port) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: LOCK_HOST, port, exclusive: true });
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function listenForLock(port, banner) {
	const server = net.createServer((socket) => {
		socket.end(`${banner}\n`);
	});
	await listen(server, port);
	// The lock lives only as long as its holder has real work in flight (a child
	// test process, a timer, a pending file operation). Keeping the listener
	// unref'd means a holder that forgets to release still exits instead of
	// hanging its runner until the CI job times out.
	server.unref();
	return {
		port,
		release: () => close(server),
	};
}

function formatWaitDuration(durationMs) {
	if (durationMs < 60_000) return `${Math.ceil(durationMs / 1_000)}s`;
	return `${Math.ceil(durationMs / 60_000)}m`;
}

function describeOwner(owner) {
	const pid = Number.isInteger(owner?.pid) ? owner.pid : "unknown";
	const tier = owner?.tier || "unknown";
	const cwd = owner?.cwd || "unknown";
	return `pid ${pid}, tier ${tier}, cwd ${cwd}`;
}

function createTimeoutError(waitedMs, owner) {
	const holder = owner
		? ` held by ${describeOwner(owner)}`
		: " because another process kept winning the local lock race";
	return new TestGateLockTimeoutError(
		`Timed out after ${formatWaitDuration(waitedMs)} waiting for the local test gate${holder}. Exit ${TEST_GATE_LOCK_TIMEOUT_EXIT_CODE} means the tests did not run.`,
	);
}

/**
 * Acquires one repository-wide local test budget. Every deterministic port is
 * probed before listening so an owner on a fallback port cannot be missed.
 */
export async function acquireTestGateLock({
	repoRoot,
	owner,
	timeoutMs = DEFAULT_TEST_GATE_LOCK_TIMEOUT_MS,
	retryDelayMs = RETRY_DELAY_MS,
	waitReportIntervalMs = WAIT_REPORT_INTERVAL_MS,
	now = Date.now,
	sleep = delay,
	probeCandidatesImpl = probeCandidates,
	listenImpl = listenForLock,
	output = (message) => console.log(message),
} = {}) {
	if (!repoRoot) throw new Error("repoRoot is required");
	if (!owner || typeof owner !== "object") throw new Error("owner is required");
	const commonDir = await resolveTestGateCommonDir(repoRoot);
	const identity = testGateLockIdentity(commonDir);
	const ports = Array.from(
		{ length: LOCK_PORT_CANDIDATES },
		(_, candidate) => lockPort(identity, candidate),
	);
	const banner = JSON.stringify({
		protocol: LOCK_PROTOCOL,
		identity,
		owner,
	});
	const startedAt = now();
	let lastReportAt = Number.NEGATIVE_INFINITY;
	const bindDeniedPorts = new Set();

	while (true) {
		const probes = (await probeCandidatesImpl(ports, identity)).map((probe) =>
			bindDeniedPorts.has(probe.port)
				? { port: probe.port, result: "collision" }
				: probe,
		);
		const decision = decideTestGateLock(probes);
		if (decision.type === "unavailable") {
			throw new Error(
				`All ${LOCK_PORT_CANDIDATES} test gate lock ports are occupied by unrelated local services`,
			);
		}
		if (decision.type === "acquire") {
			try {
				return await listenImpl(decision.port, banner);
			} catch (error) {
				if (BIND_DENIED_ERROR_CODES.has(error?.code)) {
					bindDeniedPorts.add(decision.port);
					continue;
				}
				if (error?.code !== "EADDRINUSE") throw error;
				const waitedMs = now() - startedAt;
				if (waitedMs >= timeoutMs) throw createTimeoutError(waitedMs);
				await sleep(Math.min(retryDelayMs, timeoutMs - waitedMs));
				continue;
			}
		}

		const waitedMs = now() - startedAt;
		if (waitedMs >= timeoutMs) {
			throw createTimeoutError(waitedMs, decision.owner);
		}
		if (now() - lastReportAt >= waitReportIntervalMs) {
			output(
				`WAIT test gate: ${describeOwner(decision.owner)}; waited ${formatWaitDuration(waitedMs)} (timeout ${formatWaitDuration(timeoutMs)}). Do not kill and restart; use --no-lock only when intentional overlap is safe.`,
			);
			lastReportAt = now();
		}
		await sleep(Math.min(retryDelayMs, timeoutMs - waitedMs));
	}
}
