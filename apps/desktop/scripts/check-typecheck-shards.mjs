// CI guard: desktop 的 typecheck 拆成 tsconfig.main.json + tsconfig.renderer.json 两片
// （全量单片实测堆 11.6 GiB / RSS 12.4 GB，已贴近 tsc 的 heap limit）。
// 拆片的代价是「漏掉一个目录就静默少检查一片代码」，所以这里在跑 tsc 之前断言：
// 两片 include 的并集覆盖 tsconfig.json 原本 `src/**/*` + `*.d.ts` 指到的每一个文件。
// 新增 src 顶层目录、或给某一片加 exclude 时，这个 guard 会失败并指出漏了什么。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SHARDS = ['tsconfig.main.json', 'tsconfig.renderer.json'];

const parseJsonc = (file) => {
  // tsconfig 允许注释；这里只剥掉 // 行注释，够用且不引依赖。
  const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw);
};

// tsconfig 的 include 是相对配置目录的 glob：`**` 跨任意层目录（也匹配零层），
// `*` 不跨目录。按 `/` 分段翻译，避免把 `a/**/b` 写成「至少要有一层目录」。
const globToRegExp = (pattern) => {
  const parts = pattern.split('/');
  let source = '^';
  for (let i = 0; i < parts.length; i += 1) {
    const segment = parts[i];
    const isLast = i === parts.length - 1;
    if (segment === '**') {
      source += isLast ? '.*' : '(?:.*/)?';
      continue;
    }
    source += segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    if (!isLast) source += '/';
  }
  return new RegExp(`${source}$`);
};

const shards = SHARDS.map((file) => ({
  file,
  matchers: (parseJsonc(file).include ?? []).map(globToRegExp),
}));

const trackedUnderSrc = execFileSync('git', ['ls-files', '-z', 'src'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => /\.(ts|tsx)$/.test(f));
const trackedTopLevelDts = execFileSync('git', ['ls-files', '-z', '--', '*.d.ts'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !f.includes('/') && /\.d\.ts$/.test(f));
const tracked = [...trackedUnderSrc, ...trackedTopLevelDts];

const missing = tracked.filter(
  (file) => !shards.some(({ matchers }) => matchers.some((re) => re.test(file))),
);

if (missing.length > 0) {
  console.error('❌  [typecheck-shards] FAIL — 有源文件不在任何 typecheck 分片里：');
  for (const file of missing) console.error(`      ${file}`);
  console.error('    Fix: 把它加进 tsconfig.main.json 或 tsconfig.renderer.json 的 include。');
  process.exit(1);
}

console.log(`✅  [typecheck-shards] PASS — ${SHARDS.join(' + ')} 覆盖 ${tracked.length} 个源文件`);
