import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CANONICAL_DOCS = [
	"docs/dev-rules/environment-setup.md",
	"docs/dev-rules/desktop-development.md",
	"docs/dev-rules/mobile-development.md",
];
const CONTRIBUTING_DOCS = ["CONTRIBUTING.md", "CONTRIBUTING.en.md"];
const CHECKED_DOCS = [...CONTRIBUTING_DOCS, ...CANONICAL_DOCS];
const WORKSPACES = new Map([
	["desktop", "apps/desktop/package.json"],
	["mobile", "apps/mobile/package.json"],
]);
const PNPM_BUILTINS = new Set(["install", "--version"]);

function readText(relativePath) {
	return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
	return JSON.parse(readText(relativePath));
}

function shellLines(relativePath) {
	const markdown = readText(relativePath);
	return [...markdown.matchAll(/```(?:bash|sh)?\r?\n([\s\S]*?)```/g)]
		.flatMap((match) => match[1].split(/\r?\n/))
		.map((line) => line.trim())
		.filter((line) => line.startsWith("pnpm "));
}

function assertPnpmCommandExists(line, rootPackage) {
	const tokens = line.split(/\s+/);
	if (tokens[1] === "--filter") {
		const selector = tokens[2];
		const command = tokens[3];
		const workspaceManifest = WORKSPACES.get(selector);
		assert.ok(workspaceManifest, `unknown workspace selector in documented command: ${line}`);
		const workspacePackage = readJson(workspaceManifest);
		if (command === "exec") {
			const binary = tokens[4];
			assert.ok(
				workspacePackage.dependencies?.[binary] || workspacePackage.devDependencies?.[binary],
				`documented binary '${binary}' is not declared by ${workspaceManifest}: ${line}`,
			);
			return;
		}
		assert.ok(
			workspacePackage.scripts?.[command],
			`documented script '${command}' is missing from ${workspaceManifest}: ${line}`,
		);
		return;
	}

	const command = tokens[1];
	if (PNPM_BUILTINS.has(command)) return;
	assert.ok(rootPackage.scripts?.[command], `documented root script is missing: ${line}`);
}

function localMarkdownLinks(relativePath) {
	return [...readText(relativePath).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
		.map((match) => match[1].trim())
		.filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
}

test("developer docs only document pnpm commands that exist", () => {
	const rootPackage = readJson("package.json");
	for (const relativePath of CHECKED_DOCS) {
		for (const line of shellLines(relativePath)) {
			assertPnpmCommandExists(line, rootPackage);
		}
	}
});

test("developer docs do not duplicate canonical command lines", () => {
	const owners = new Map();
	for (const relativePath of CHECKED_DOCS) {
		for (const line of shellLines(relativePath)) {
			assert.equal(
				owners.get(line),
				undefined,
				`documented command is duplicated in ${owners.get(line)} and ${relativePath}: ${line}`,
			);
			owners.set(line, relativePath);
		}
	}
	for (const relativePath of CONTRIBUTING_DOCS) {
		assert.equal(shellLines(relativePath).length, 0, `${relativePath} must link to canonical command docs`);
	}
});

test("AGENTS and CONTRIBUTING route to the canonical developer docs", () => {
	const agents = readText("AGENTS.md");
	const contributingDocs = CONTRIBUTING_DOCS.map(readText);
	for (const relativePath of CANONICAL_DOCS) {
		assert.match(agents, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		for (const contributing of contributingDocs) {
			assert.match(contributing, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	}
});

test("developer documentation links resolve", () => {
	for (const relativePath of CHECKED_DOCS) {
		const sourceDir = path.dirname(path.join(ROOT, relativePath));
		for (const target of localMarkdownLinks(relativePath)) {
			const fileTarget = decodeURIComponent(target.split("#", 1)[0]);
			assert.ok(
				fs.existsSync(path.resolve(sourceDir, fileTarget)),
				`broken local link in ${relativePath}: ${target}`,
			);
		}
	}
});

test("runtime versions and the docs contract are code-owned", () => {
	const rootPackage = readJson("package.json");
	assert.equal(rootPackage.engines.node, ">=22");
	assert.equal(rootPackage.engines.pnpm, ">=10.7 <11");
	assert.match(rootPackage.packageManager, /^pnpm@10\./);
	assert.match(rootPackage.scripts["test:runner"], /scripts\/__tests__\/dev-docs-contract\.test\.mjs/);
});
