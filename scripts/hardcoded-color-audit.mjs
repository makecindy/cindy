#!/usr/bin/env node
// 零残留扫描(计划 §2 P 节五要素合同):
// ① BASE_REF = PR target 分支(默认 main,可经 env 覆盖)
// ② 扫描范围 = 仅 diff **新增行**(+ 行,不含 context)
// ③ 固定 regex:#hex / rgb() / rgba() / hsl() / hsla()
// ④ exemption 版本化(scripts/hardcoded-color-exemptions.json,每条含 glob/理由/owner)
// ⑤ 输出 raw / allowed / unexpected 三计数,**仅 unexpected=0 通过**
//
// 用法: node scripts/hardcoded-color-audit.mjs [--base-ref <ref>]
// 可证伪:同一 BASE_REF 两台机器三计数一致;人为加一条未登记 hex → unexpected 0→1。

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { matchBareColors } from "./shared/hardcoded-color-match.mjs";

const args = process.argv.slice(2);
let baseRef = "main";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base-ref" && args[i + 1]) baseRef = args[i + 1];
}

let exemptions = [];
try {
  exemptions = JSON.parse(readFileSync("scripts/hardcoded-color-exemptions.json", "utf8"));
} catch {
  exemptions = [];
}

function matchGlob(file, glob) {
  const re = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(re).test(file);
}

function isExempt(file) {
  return exemptions.some((e) => matchGlob(file, e.glob));
}

function diffAddedHits(ref) {
  const out = execSync(`git diff ${ref}...HEAD --unified=0`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const hits = [];
  let file = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); }
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (file.endsWith("hardcoded-color-exemptions.json")) continue;
      const text = line.slice(1);
      const all = matchBareColors(text);
      for (const v of all) hits.push({ file, value: v, text: text.trim().slice(0, 80) });
    }
  }
  return hits;
}

const hits = diffAddedHits(baseRef);
const allowed = hits.filter((h) => isExempt(h.file));
const unexpected = hits.filter((h) => !isExempt(h.file));

console.log(`BASE_REF: ${baseRef}`);
console.log(`raw: ${hits.length}`);
console.log(`allowed: ${allowed.length}`);
console.log(`unexpected: ${unexpected.length}`);
if (unexpected.length) {
  console.log("--- unexpected(未登记的硬编码色) ---");
  for (const h of unexpected) console.log(`  ${h.file}: ${h.value}  // ${h.text}`);
  process.exit(1);
}
console.log("PASS: unexpected=0");
