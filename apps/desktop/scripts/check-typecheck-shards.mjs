// CI guard: desktop 的 typecheck 拆成 tsconfig.main.json + tsconfig.renderer.json 两片
// （全量单片实测堆 11.6 GiB / RSS 12.4 GB，已贴近 tsc 的 heap limit）。
// 拆片的代价是「漏掉一个目录就静默少检查一片代码」，所以这里在跑 tsc 之前断言：
// 两片实际会检查到的文件并集，覆盖原单片 tsconfig.json 会检查到的全部文件。
//
// 文件集用 TypeScript 自己的配置解析算（ts.getParsedCommandLineOfConfigFile）：
// include / exclude / extends / 默认扩展名全都按 tsc 的规则解析，guard 与 tsc 不会各说各话。
// 只按 include 手写 glob 会漏掉两件事：某一片加 exclude 时仍报「覆盖完整」，
// 以及 tsc 默认扩展名之外的源文件（.mts/.cts 等）到底算不算在内。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch (error) {
  console.error(
    '❌  [typecheck-shards] 加载 typescript 失败，guard 拒绝放行：',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'tsconfig.json';
const SHARDS = ['tsconfig.main.json', 'tsconfig.renderer.json'];

const host = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    console.error(
      '❌  [typecheck-shards] 配置无法解析：',
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    process.exit(1);
  },
};

// 一份 tsconfig 实际会检查到的文件集（相对 apps/desktop，posix 斜杠）。
const filesOf = (configFile) => {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(DESKTOP, configFile),
    {},
    host,
  );
  if (!parsed) {
    console.error(`❌  [typecheck-shards] 无法解析 ${configFile}`);
    process.exit(1);
  }
  if (parsed.errors.length > 0) {
    console.error(`❌  [typecheck-shards] ${configFile} 有配置错误：`);
    for (const diagnostic of parsed.errors) {
      console.error(
        `      ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    }
    process.exit(1);
  }
  return new Set(
    parsed.fileNames.map((file) =>
      path.relative(DESKTOP, file).split(path.sep).join('/'),
    ),
  );
};

const baseFiles = filesOf(BASE);
const shardFiles = new Map(SHARDS.map((file) => [file, filesOf(file)]));
const union = new Set();
for (const files of shardFiles.values()) {
  for (const file of files) union.add(file);
}

// 覆盖口径 = 原单片 tsconfig.json 会检查到的文件集。分片少查一个文件就是漏检。
const missing = [...baseFiles].filter((file) => !union.has(file)).sort();
if (missing.length > 0) {
  console.error(
    `❌  [typecheck-shards] FAIL — 有 ${missing.length} 个原单片会检查的文件不在任何 typecheck 分片里：`,
  );
  for (const file of missing) console.error(`      ${file}`);
  console.error(
    '    Fix: 把它加进 tsconfig.main.json 或 tsconfig.renderer.json 的 include（或别在那里 exclude 它）。',
  );
  process.exit(1);
}

// 分片多查的文件（比原单片多）不算错，只是记一笔，避免「多查了但没人知道」。
const extra = [...union].filter((file) => !baseFiles.has(file)).sort();
if (extra.length > 0) {
  console.log(
    `ℹ️  [typecheck-shards] 分片额外覆盖 ${extra.length} 个原单片未包含的文件（多查，不漏检）：${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}`,
  );
}

// 覆盖口径说明：baseFiles 是 tsc 自己解析出来的「原单片实际会检查的文件集」，
// 里面已经包含 tsc 支持的全部扩展名（.ts/.tsx/.d.ts/.mts/.cts/.d.mts…），
// 所以新增任何一种扩展名的源文件都会自动进入这个口径，不用在这里另列规则。
for (const [file, files] of shardFiles) {
  console.log(`ℹ️  [typecheck-shards] ${file}: ${files.size} 个文件`);
}
console.log(
  `✅  [typecheck-shards] PASS — ${SHARDS.join(' + ')} 覆盖原 tsconfig.json 的 ${baseFiles.size} 个文件（分片合计 ${union.size}）`,
);
