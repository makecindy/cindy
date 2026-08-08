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

function workflowJob(workflow, jobId) {
	const lines = workflow.split(/\r?\n/);
	const start = lines.findIndex((line) => line === `  ${jobId}:`);
	if (start === -1) return undefined;
	const endOffset = lines
		.slice(start + 1)
		.findIndex((line) => /^  [a-zA-Z0-9_-]+:$/.test(line));
	const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
	return lines.slice(start + 1, end).join("\n");
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

/**
 * 去掉 fenced code block 与 inline code span,再抽链接。顺序不能反 —— fenced block
 * 内部含反引号,先剥 inline 会把围栏本身吃掉。
 *
 * 这样 `[x](y)` 这类**演示 markdown 语法**的写法不会被当成真链接(design-rules/DESIGN.md
 * 里有多处);而 [`foo.md`](./foo.md) 这种「链接文本本身是 inline code」的常见写法,剥完
 * 变成 [](./foo.md),目标仍在括号里,正则照常命中。
 */
function stripCodeSpans(text) {
	return (
		text
			// 围栏允许带缩进 —— 列表项里的围栏本就是缩进的(docs/design-rules/DESIGN.md
			// 与 docs/dev-rules/pi-remaining-work.md 各有一处)。只认行首 ``` 会漏掉它们,
			// 块内的示例链接就会被当成真链接。
			.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "")
			// inline code 用「等长反引号串」配对,这样内容本身含反引号的写法也能整段剥掉
			// (docs/product-rules/task-and-conversation-naming.md 有 `` `${n} 个会话` ``)。
			// 刻意不跨行:落单的反引号不应该让后面整篇文档漏检。
			.replace(/(`+)(?:(?!\1)[^\n])*?\1/g, "")
	);
}

function localMarkdownLinks(relativePath) {
	return [...stripCodeSpans(readText(relativePath)).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
		.map((match) => match[1].trim())
		.filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
}

/**
 * 需要做内链体检的全部文档:根目录规则文件 + `docs/` 下所有 markdown(递归)。
 *
 * 覆盖面刻意做全 —— 悬空内链最容易出现在深层目录里:文档被删除时,引用它的索引
 * (如 `docs/legal/README.md`、`docs/README.md`)常常漏改。只体检 CHECKED_DOCS 那几篇
 * canonical 文档挡不住这类回归。
 */
function listLinkCheckedDocs() {
	const out = ["AGENTS.md", ...CONTRIBUTING_DOCS];
	const walk = (relativeDir) => {
		for (const entry of fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
			const relativePath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) walk(relativePath);
			else if (entry.name.endsWith(".md")) out.push(relativePath);
		}
	};
	walk("docs");
	return [...new Set(out)].sort();
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
	for (const relativePath of listLinkCheckedDocs()) {
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
	assert.equal(rootPackage.engines.node, ">=22.12");
	assert.equal(rootPackage.engines.pnpm, ">=10.7 <11");
	assert.match(rootPackage.packageManager, /^pnpm@10\./);
	assert.match(rootPackage.scripts["test:runner"], /scripts\/__tests__\/dev-docs-contract\.test\.mjs/);
});

test("client CI keeps the complete two-shard unit gate on Windows", () => {
	const workflow = readText(".github/workflows/ci.yml");
	const shards = workflowJob(workflow, "windows-unit-shards");
	assert.ok(shards, "client CI must define Windows unit shards");
	assert.match(shards, /^    runs-on: windows-latest$/m);
	assert.match(shards, /^      fail-fast: false$/m);
	assert.match(shards, /^        shard: \[1, 2\]$/m);
	assert.match(shards, /^      XDT_UNIT_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/2$/m);
	assert.match(shards, /^        run: pnpm test:unit$/m);
	assert.doesNotMatch(shards, /pnpm test:unit\s+--/);

	const gate = workflowJob(workflow, "windows-unit");
	assert.ok(gate, "client CI must preserve the stable Windows unit check");
	assert.match(gate, /^    name: Windows unit tests$/m);
	assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
	assert.match(gate, /^    needs: windows-unit-shards$/m);
	assert.match(gate, /^          WINDOWS_UNIT_SHARDS_RESULT: \$\{\{ needs\.windows-unit-shards\.result \}\}$/m);
	assert.match(gate, /^        run: test "\$WINDOWS_UNIT_SHARDS_RESULT" = "success"$/m);
});

test("client CI runs Linux checks and complete unit shards in parallel behind stable verify", () => {
	const workflow = readText(".github/workflows/ci.yml");
	const checks = workflowJob(workflow, "verify-checks");
	assert.ok(checks, "client CI must define independent Linux verification checks");
	assert.doesNotMatch(checks, /^    needs:/m);
	assert.match(checks, /^        run: pnpm test:runner$/m);
	assert.doesNotMatch(checks, /node scripts\/test-workspaces\.mjs --tier unit/);

	const shards = workflowJob(workflow, "linux-unit-shards");
	assert.ok(shards, "client CI must define Linux unit shards");
	assert.match(shards, /^    runs-on: ubuntu-latest$/m);
	assert.doesNotMatch(shards, /^    needs:/m);
	assert.match(shards, /^      fail-fast: false$/m);
	assert.match(shards, /^        shard: \[1, 2\]$/m);
	assert.match(shards, /^      XDT_UNIT_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/2$/m);
	assert.match(shards, /^      - name: Reject cindy-protocol rollback or divergence$/m);
	assert.match(shards, /^        if: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
	assert.match(shards, /^          CINDY_PROTOCOL_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m);
	assert.match(shards, /^        run: node scripts\/check-submodule-forward\.mjs$/m);
	assert.match(shards, /^        run: pnpm exec node scripts\/test-workspaces\.mjs --tier unit$/m);
	assert.doesNotMatch(shards, /pnpm test:(?:unit|runner)/);

	const gate = workflowJob(workflow, "verify");
	assert.ok(gate, "client CI must preserve the stable verify check");
	assert.match(gate, /^    name: verify$/m);
	assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
	assert.match(gate, /^      - verify-checks$/m);
	assert.match(gate, /^      - linux-unit-shards$/m);
	assert.match(gate, /^          VERIFY_CHECKS_RESULT: \$\{\{ needs\.verify-checks\.result \}\}$/m);
	assert.match(gate, /^          LINUX_UNIT_SHARDS_RESULT: \$\{\{ needs\.linux-unit-shards\.result \}\}$/m);
	assert.match(gate, /^          test "\$VERIFY_CHECKS_RESULT" = "success"$/m);
	assert.match(gate, /^          test "\$LINUX_UNIT_SHARDS_RESULT" = "success"$/m);
});
