#!/usr/bin/env node
// 规则索引：按改动的文件找出要读的规则。
//
// 正本是各规则文档开头引用块里的两行（docs/dev-rules/development-workflow.md §4）：
//   > **读取时机**：什么情况下要读这份规则
//   > **适用路径**：`apps/x/**`、`packages/y/src/z.ts`      ← 仓库相对路径通配
//   > **适用路径**：按主题                                  ← 无法按路径判定的规则
// 本脚本只读这两行：生成 docs/dev-rules/rule-index.md（不运行任何东西也能查），
// 并回答「这些文件要读哪些规则」。不依赖 node_modules，新 worktree 里可直接运行。
//
//   node scripts/rule-index.mjs write            生成索引（pnpm rules:index）
//   node scripts/rule-index.mjs check            索引是否最新、声明是否有效
//   node scripts/rule-index.mjs for <路径…>      这些路径要读哪些规则（pnpm rules:for）
//   node scripts/rule-index.mjs changed          本分支改动要读哪些规则（pnpm rules:changed）

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULE_INDEX_PATH = "docs/dev-rules/rule-index.md";
export const TOPIC_MARK = "按主题";
const FIELD_WHEN = "读取时机";
const FIELD_PATHS = "适用路径";
/** 声明必须出现在文档开头，避免把正文里的引用块误读成声明。 */
const HEADER_LINES = 60;

const toPosix = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");

/** 读出文档开头引用块里的 `> **字段**：值`；值可以折行，直到下一个字段或引用块结束。 */
export function parseRuleHeader(text) {
	const fields = new Map();
	let current = null;
	for (const line of String(text).split(/\r?\n/).slice(0, HEADER_LINES)) {
		if (!line.startsWith(">")) {
			current = null;
			continue;
		}
		const body = line.replace(/^>\s?/, "");
		const field = /^\*\*([^*]+)\*\*[：:]\s*(.*)$/.exec(body);
		if (field) {
			current = field[1].trim();
			if (!fields.has(current)) fields.set(current, field[2].trim());
			else current = null;
		} else if (current === FIELD_PATHS && !/[、，,]$/.test(fields.get(current))) {
			// 路径列表只在上一行以分隔符结尾时折行；其后的说明文字不属于声明。
			current = null;
		} else if (current) {
			fields.set(current, `${fields.get(current)} ${body.trim()}`.trim());
		}
	}
	const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? "";
	const when = fields.get(FIELD_WHEN) ?? "";
	const rawPaths = fields.get(FIELD_PATHS);
	if (rawPaths === undefined) return { title, when, declared: false, topic: false, globs: [] };
	const globs = [...rawPaths.matchAll(/`([^`]+)`/g)].map((match) => toPosix(match[1].trim()));
	return { title, when, declared: true, topic: rawPaths.startsWith(TOPIC_MARK), globs };
}

/** `**` 跨目录，`*` 与 `?` 不跨目录，`{a,b}` 多选一；其余按字面匹配。 */
export function globToRegExp(glob) {
	let out = "";
	const source = toPosix(glob);
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "*") {
			if (source[i + 1] === "*") {
				i++;
				if (source[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else out += ".*";
			} else out += "[^/]*";
		} else if (char === "?") out += "[^/]";
		else if (char === "{") {
			const end = source.indexOf("}", i);
			if (end < 0) out += "\\{";
			else {
				const options = source.slice(i + 1, end).split(",");
				out += `(?:${options.map((option) => globToRegExp(option).source.slice(1, -1)).join("|")})`;
				i = end;
			}
		} else out += char.replace(/[.+^$()|[\]\\}]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

function walkMarkdown(root, relativeDir, out) {
	for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
		const relativePath = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory()) walkMarkdown(root, relativePath, out);
		else if (entry.name.endsWith(".md")) out.push(relativePath);
	}
}

/** 所有带「读取时机」或「适用路径」的规则文档，按路径排序。 */
export function loadRules(root) {
	const files = [];
	walkMarkdown(root, "docs", files);
	const rules = [];
	for (const file of files.sort()) {
		if (file === RULE_INDEX_PATH) continue;
		const header = parseRuleHeader(fs.readFileSync(path.join(root, file), "utf8"));
		if (!header.declared && !header.when) continue;
		rules.push({ file, ...header, matchers: header.globs.map(globToRegExp) });
	}
	return rules;
}

/** 声明本身的问题；`trackedFiles` 给出时还检查每条路径至少匹配一个现存文件。 */
export function ruleProblems(rules, trackedFiles) {
	const problems = [];
	for (const rule of rules) {
		if (!rule.when) problems.push(`${rule.file}: 缺少「${FIELD_WHEN}」`);
		// 读取时机会原样进入索引；相对链接换了目录就失效，说明文字另起一个引用块。
		if (/\]\(/.test(rule.when)) problems.push(`${rule.file}: 「${FIELD_WHEN}」里不要放链接（会原样进入索引）`);
		if (!rule.declared) {
			problems.push(`${rule.file}: 有「${FIELD_WHEN}」但缺少「${FIELD_PATHS}」（写路径通配，或写「${TOPIC_MARK}」）`);
			continue;
		}
		if (rule.topic && rule.globs.length) {
			problems.push(`${rule.file}: 「${FIELD_PATHS}」不能同时写「${TOPIC_MARK}」和路径`);
		}
		if (!rule.topic && rule.globs.length === 0) {
			problems.push(`${rule.file}: 「${FIELD_PATHS}」里没有反引号包住的路径，也不是「${TOPIC_MARK}」`);
		}
		if (!trackedFiles) continue;
		rule.matchers.forEach((matcher, index) => {
			if (!trackedFiles.some((file) => matcher.test(file))) {
				problems.push(`${rule.file}: 路径 \`${rule.globs[index]}\` 没有匹配任何现存文件`);
			}
		});
	}
	return problems;
}

/** 每份命中的规则及其命中的文件；按主题的规则不参与。 */
export function rulesForFiles(rules, files) {
	const normalized = files.map(toPosix);
	const hits = [];
	for (const rule of rules) {
		if (rule.topic) continue;
		const matched = normalized.filter((file) => rule.matchers.some((matcher) => matcher.test(file)));
		if (matched.length) hits.push({ rule, matched });
	}
	return hits;
}

// 先转义反斜杠再转义竖线，否则原文里的「\|」会被读成一个转义过的竖线。
const cell = (value) => value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
function ruleLink(rule) {
	const target = toPosix(path.posix.relative(path.posix.dirname(RULE_INDEX_PATH), rule.file));
	return `[${cell(rule.title || rule.file)}](${target})`;
}

export function renderIndex(rules) {
	const declared = rules.filter((rule) => rule.declared);
	const lines = [
		"# 规则索引：改哪些文件要读哪些规则",
		"",
		"> 本文件由 `pnpm rules:index` 生成，不要手改。正本是各规则文档开头的「读取时机」与",
		"> 「适用路径」；`pnpm check:dev-docs` 核对本文件是否最新、每条路径是否仍有文件。",
		"",
		"第一张表是全部规则和它们的读取时机：判定为「路径」的，改到第二张表里对应的路径就要读；",
		"判定为「主题」的无法由路径判定，按读取时机判断。动手前运行 `pnpm rules:for <路径…>`，",
		"提交前运行 `pnpm rules:changed`，它们按路径列出要读的规则；没有 pnpm 时用",
		"`node scripts/rule-index.mjs for <路径…>`。新增规则文档时在它自己的开头声明这两行，",
		"不往根 `AGENTS.md` 加条目（[开发工作流](development-workflow.md) §4、§5）。",
		"",
		"## 规则与读取时机",
		"",
		"| 规则 | 读取时机 | 判定 |",
		"| --- | --- | --- |",
		...declared.map((rule) => `| ${ruleLink(rule)} | ${cell(rule.when)} | ${rule.topic ? "主题" : "路径"} |`),
		"",
		"## 适用路径",
		"",
		"| 规则 | 适用路径 |",
		"| --- | --- |",
		...declared
			.filter((rule) => !rule.topic)
			.map((rule) => `| ${ruleLink(rule)} | ${rule.globs.map((glob) => `\`${glob}\``).join("<br>")} |`),
		"",
	];
	return lines.join("\n");
}

function formatHits(rules, files) {
	const hits = rulesForFiles(rules, files);
	const topics = rules.filter((rule) => rule.topic).length;
	const lines = [];
	if (hits.length === 0) lines.push(`这 ${files.length} 个路径没有命中按路径声明的规则。`);
	else lines.push(`这 ${files.length} 个路径涉及 ${hits.length} 份规则，动手或提交前先读：`);
	for (const { rule, matched } of hits) {
		lines.push("", `- ${rule.file}`, `    读取时机：${cell(rule.when)}`);
		const more = matched.length > 3 ? ` 等 ${matched.length} 个` : "";
		lines.push(`    命中：${matched.slice(0, 3).join("、")}${more}`);
	}
	lines.push("", `另有 ${topics} 份规则按主题判断，见 ${RULE_INDEX_PATH} 里判定为「主题」的行。`);
	return lines.join("\n");
}

function main(argv) {
	const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
	// stderr 丢弃：探测基准分支时不存在的 ref 会让 git 报错，那不是给使用者看的。
	const git = (args) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	const [command, ...rest] = argv;
	const rules = loadRules(root);
	if (command === "write") {
		fs.writeFileSync(path.join(root, RULE_INDEX_PATH), renderIndex(rules));
		console.log(`已生成 ${RULE_INDEX_PATH}（${rules.filter((rule) => rule.declared).length} 份规则）`);
		return 0;
	}
	if (command === "check") {
		// 含未跟踪的新文件，不含已删除但尚未提交的文件。
		const tracked = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
			.split("\0")
			.filter((file) => file && fs.existsSync(path.join(root, file)))
			.map(toPosix);
		const problems = ruleProblems(rules, tracked);
		const current = fs.existsSync(path.join(root, RULE_INDEX_PATH))
			? fs.readFileSync(path.join(root, RULE_INDEX_PATH), "utf8").replace(/\r\n/g, "\n")
			: "";
		if (current !== renderIndex(rules)) problems.push(`${RULE_INDEX_PATH} 不是最新，运行 pnpm rules:index`);
		for (const problem of problems) console.error(problem);
		if (problems.length === 0) console.log("规则索引与各文档的声明一致。");
		return problems.length ? 1 : 0;
	}
	if (command === "for") {
		if (rest.length === 0) {
			console.error("用法：node scripts/rule-index.mjs for <路径…>");
			return 2;
		}
		const files = rest.map((value) => toPosix(path.relative(root, path.resolve(process.cwd(), value))));
		console.log(formatHits(rules, files));
		return 0;
	}
	if (command === "changed") {
		// 与 pnpm test:unit:related 同一口径：已提交、已暂存、未暂存和未跟踪的改动。
		return import("./test-related.mjs").then(({ collectChangedFiles }) => {
			const changed = collectChangedFiles(git);
			if (changed.error) {
				console.error(`无法确定改动范围：${changed.error}。改用 node scripts/rule-index.mjs for <路径…>`);
				return 2;
			}
			console.log(formatHits(rules, changed.files));
			return 0;
		});
	}
	console.error("用法：node scripts/rule-index.mjs <write|check|for <路径…>|changed>");
	return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	Promise.resolve(main(process.argv.slice(2))).then((code) => {
		process.exitCode = code;
	});
}
