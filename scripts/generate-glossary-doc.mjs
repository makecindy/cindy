#!/usr/bin/env node
/**
 * 从 i18n/glossary.json 生成人读版 i18n/GLOSSARY.md。
 *
 * 术语表的价值在于「改文案的人会去读」。JSON 适合脚本消费,不适合人和 AI 快速查阅,
 * 所以维护一份 markdown 镜像,并由 check-i18n-glossary.mjs 校验两者同步——避免出现
 * 「改了 JSON 忘了生成文档,大家继续照着过期的 markdown 写文案」。
 *
 * 用法:
 *   node scripts/generate-glossary-doc.mjs          # 生成(root: pnpm i18n:glossary-doc)
 *   node scripts/generate-glossary-doc.mjs --check  # 只校验是否最新,不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDocEol, renderGlossaryDoc } from './shared/glossary-doc.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOSSARY_PATH = path.join(repoRoot, 'i18n', 'glossary.json');
const DOC_PATH = path.join(repoRoot, 'i18n', 'GLOSSARY.md');

const checkOnly = process.argv.includes('--check');

const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8'));
const rendered = renderGlossaryDoc(glossary);

if (checkOnly) {
  const existing = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
  if (normalizeDocEol(existing) !== normalizeDocEol(rendered)) {
    console.error(
      '[generate-glossary-doc] ❌ i18n/GLOSSARY.md 与 i18n/glossary.json 不同步。\n' +
        '  运行 pnpm i18n:glossary-doc 重新生成。',
    );
    process.exit(1);
  }
  console.log('[generate-glossary-doc] ✅ GLOSSARY.md 与术语表同步');
  process.exit(0);
}

fs.writeFileSync(DOC_PATH, rendered, 'utf8');
console.log(
  `[generate-glossary-doc] ✅ 已生成 ${path.relative(repoRoot, DOC_PATH)}` +
    `(${glossary.terms.length} 条术语)`,
);
