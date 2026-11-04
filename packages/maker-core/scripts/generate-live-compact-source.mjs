#!/usr/bin/env node
/**
 * 生成 live-compact 扩展的内联源码常量。
 *
 * 为什么要内联:扩展跑在 pi 子进程里,必须以 **磁盘文件** 形式经 `--extension`
 * 加载(pi 按路径读、自己转译);而 Cindy 打包后源码树不在 asar 内的可读位置。
 * 与 cindy-bridge / cache-recovery 同一形态:源码以字符串常量进 bundle,
 * 每次 session 启动写到 <configHome>/internal-extensions/ 再交给 pi。
 *
 * 源文件 `extensions/live-compact/index.ts` 是唯一真源(在 tsc include 之外,
 * 因为它 import 的 @earendil-works/pi-coding-agent 不在本仓依赖里)。
 * 本脚本把内容转成 JSON 字符串常量 —— 不是 String.raw:扩展里有大量反引号
 * 与 ${},String.raw 会保留转义用的反斜杠污染源码。
 *
 * 源文件不在 tsc include 里(见上),所以这里自己过一遍语法:真源写错时在
 * 构建期就红,而不是等用户开了开关、每个新会话启动 pi 时才崩。
 *
 * 用法:node scripts/generate-live-compact-source.mjs [--check]
 *   --check  只校验生成物是否与源一致(CI 用),不写文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.join(root, 'extensions', 'live-compact', 'index.ts');
const outputPath = path.join(root, 'src', 'agents', 'pi', 'live-compact-source.ts');

const source = readFileSync(sourcePath, 'utf8');

// 只查语法(不做类型检查):真源 import 的 pi 包不在本仓依赖里,类型查不了。
const parsed = ts.transpileModule(source, {
  fileName: sourcePath,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
const syntaxErrors = (parsed.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
if (syntaxErrors.length > 0) {
  for (const diagnostic of syntaxErrors) {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
    const where = position ? `:${position.line + 1}:${position.character + 1}` : '';
    console.error(`${sourcePath}${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  process.exit(1);
}
const content = [
  '/**',
  ' * 由 scripts/generate-live-compact-source.mjs 生成 —— 不要手改。',
  ' * 真源: packages/maker-core/extensions/live-compact/index.ts',
  ' *',
  ' * 这段代码跑在 pi 子进程里,不能 import cindy 任何模块;只依赖 pi 的',
  ' * ExtensionAPI 与 node 内置模块。宿主按设置开关把它写到会话的',
  ' * internal-extensions/ 目录并显式 --extension 加载。',
  ' */',
  `export const LIVE_COMPACT_EXTENSION_SOURCE = ${JSON.stringify(source)};`,
  '',
].join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    /* missing counts as out of date */
  }
  if (current !== content) {
    console.error(
      'live-compact-source.ts is out of date. Run: node scripts/generate-live-compact-source.mjs',
    );
    process.exit(1);
  }
  console.log('live-compact-source.ts is up to date');
  process.exit(0);
}

writeFileSync(outputPath, content, 'utf8');
console.log(
  `wrote ${path.relative(root, outputPath)} (${content.length} bytes from ${source.length} source bytes)`,
);
