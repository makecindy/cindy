import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

const TIPTAP_AND_PROSEMIRROR_PACKAGES = [
  '@tiptap/core',
  '@tiptap/react',
  '@tiptap/extension-document',
  '@tiptap/extension-hard-break',
  '@tiptap/extension-history',
  '@tiptap/extension-paragraph',
  '@tiptap/extension-placeholder',
  '@tiptap/extension-text',
  '@tiptap/pm',
  '@tiptap/pm/model',
  '@tiptap/pm/state',
  '@tiptap/pm/view',
  'prosemirror-model',
  'prosemirror-state',
  'prosemirror-transform',
  'prosemirror-view',
];

const TIPTAP_AND_PROSEMIRROR_OPTIMIZE_EXCLUDES = TIPTAP_AND_PROSEMIRROR_PACKAGES.filter(
  (pkg) => pkg !== '@tiptap/react',
);

const CODEMIRROR_RUNTIME_PACKAGES = [
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-cpp',
  '@codemirror/lang-css',
  '@codemirror/lang-go',
  '@codemirror/lang-html',
  '@codemirror/lang-java',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-php',
  '@codemirror/lang-python',
  '@codemirror/lang-rust',
  '@codemirror/lang-sql',
  '@codemirror/lang-xml',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/legacy-modes',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  'codemirror',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  '@lezer/css',
  '@lezer/html',
  '@lezer/java',
  '@lezer/javascript',
  '@lezer/json',
  '@lezer/markdown',
  '@lezer/php',
  '@lezer/python',
  '@lezer/rust',
  '@lezer/xml',
  '@lezer/yaml',
  '@replit/codemirror-lang-csharp',
  'cm6-theme-basic-light',
];

const CODEMIRROR_OPTIMIZE_EXCLUDES = [
  ...CODEMIRROR_RUNTIME_PACKAGES,
  '@codemirror/legacy-modes/mode/clike',
  '@codemirror/legacy-modes/mode/diff',
  '@codemirror/legacy-modes/mode/dockerfile',
  '@codemirror/legacy-modes/mode/groovy',
  '@codemirror/legacy-modes/mode/haskell',
  '@codemirror/legacy-modes/mode/lua',
  '@codemirror/legacy-modes/mode/perl',
  '@codemirror/legacy-modes/mode/powershell',
  '@codemirror/legacy-modes/mode/properties',
  '@codemirror/legacy-modes/mode/protobuf',
  '@codemirror/legacy-modes/mode/r',
  '@codemirror/legacy-modes/mode/ruby',
  '@codemirror/legacy-modes/mode/shell',
  '@codemirror/legacy-modes/mode/swift',
  '@codemirror/legacy-modes/mode/toml',
];

/**
 * pdfjs-dist 的 cmaps / standard_fonts 是 CJK 字体 / 标准字体表,渲染中文 PDF
 * 必须。文件多但小(cmaps 169 / 1.5MB,standard_fonts 16 / 805KB),不值得
 * commit 进仓库 — 走这条 plugin 直接从 node_modules 出:
 *   - dev:  挂 middleware,把 /pdfjs/cmaps/<name> 和 /pdfjs/standard_fonts/<name>
 *           的请求 streaming 回 node_modules 对应文件。
 *   - build: closeBundle 时把两个目录整体复制到 outDir/pdfjs/ 下。
 * 离线可用 — 全程不走 CDN。
 */
function pdfjsAssetsPlugin(): Plugin {
  const pdfjsRoot = path.resolve(__dirname, '../../node_modules/pdfjs-dist');
  const assets = ['cmaps', 'standard_fonts'] as const;

  return {
    name: 'xdt-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const m = req.url.match(/^\/pdfjs\/(cmaps|standard_fonts)\/([^?#]+)/);
        if (!m) return next();
        const abs = path.join(pdfjsRoot, m[1], m[2]);
        if (!abs.startsWith(path.join(pdfjsRoot, m[1]))) {
          res.statusCode = 403;
          res.end();
          return;
        }
        fs.stat(abs, (err, stat) => {
          if (err || !stat.isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Length', stat.size);
          fs.createReadStream(abs).pipe(res);
        });
      });
    },
    async closeBundle() {
      const outDir = path.resolve(__dirname, '.vite/renderer/main_window/pdfjs');
      await fsp.mkdir(outDir, { recursive: true });
      for (const dir of assets) {
        const src = path.join(pdfjsRoot, dir);
        const dst = path.join(outDir, dir);
        await fsp.cp(src, dst, { recursive: true });
      }
    },
  };
}

/**
 * 「零第三方依赖」的内部 workspace 包从 dev 预打包(optimizeDeps)里整体排除。
 *
 * 背景:Vite 会把 node_modules 里(含 pnpm 软链的内部包)被 import 到的依赖预打包进
 * `.vite/deps`,而预打包缓存的失效只看 config / lockfile / 依赖 package.json 哈希,**不跟踪
 * 软链包的源码内容**。于是给某个内部包「新增一个导出」后,旧缓存(新增导出之前生成)仍被服务 →
 * `does not provide an export named X` → renderer 在挂载前抛错 → 整页黑屏(且静态检查发现不了)。
 *
 * 排除后这些包走正常 transform 管线(它们的 exports 本就指向 ./src 原始 TS),不再有过期预打包。
 * 但仅排除还不够:这些模块经 node_modules **软链路径**进入模块图(见 renderer 报错 URL
 * `/@fs/.../node_modules/@cindy/xxx/src/index.ts`),而 Vite watcher 默认忽略 node_modules 目录,
 * 源码变更(git pull / 合 PR / 本地编辑)不会失效 transform 缓存——引用方组件热更成引用新导出的
 * 版本后,被引用包仍是旧模块 → `does not provide an export named X` → 白屏且刷新无效。因此下方
 * `server.watch.ignored` 用反向 glob 把这些包从默认忽略里豁免,变更即时失效 + HMR,运行中的实例
 * 无需重启。这里**自动扫描** `packages/<package>` 而非手写名单:未来新增的纯内部包会被自动覆盖,不会漏。
 *
 * 「是不是内部包」按**位置**判定(`pnpm-workspace.yaml` 声明 packages 下的包即 workspace 包),
 * 而非按包名前缀(`@cindy/`)——后者会漏掉 `@cindy/im` / `@cindy/mcps` / `@cindy/*` 这类不带该
 * scope 的内部包。位置是权威信号,包名 scope 不是。
 *
 * 只排除 deps 为空的「纯源码包」——它们没有(可能是 CJS 的)第三方子依赖,排除 100% 安全、也不会
 * 把 server-only 重依赖(如 maker-core 的 @anthropic-ai SDK)误拖进 renderer 预打包。带第三方依赖
 * 的内部包(maker-core / maker-cc-manager 等)保持预打包不动。
 *
 * 仅作用于 dev server;`vite build`(release 打包)走 Rollup、根本不读 optimizeDeps,零影响。
 */
function discoverPureInternalPackages(): { specifiers: string[]; names: string[] } {
  const packagesDir = path.resolve(__dirname, '../../packages');
  const specifiers: string[] = [];
  const names: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return { specifiers, names };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        exports?: Record<string, unknown> | string;
      };
      // 「内部」由位置(packages/ 下)保证;名字只用作 import specifier,不参与判定。
      const name = pkg.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      // 仅「零第三方依赖」的纯源码包(无 CJS 子依赖 → 排除安全)。
      if (Object.keys(pkg.dependencies ?? {}).length !== 0) continue;
      names.push(name);
      // 主入口 + 所有 subpath 导出都要排除(subpath 在预打包里是独立条目,如 .../cron)。
      const exportsField = pkg.exports;
      if (exportsField && typeof exportsField === 'object') {
        for (const key of Object.keys(exportsField)) {
          specifiers.push(key === '.' ? name : `${name}/${key.replace(/^\.\//, '')}`);
        }
      } else {
        specifiers.push(name);
      }
    } catch {
      // 跳过无法解析的 package.json。
    }
  }
  return { specifiers, names };
}

const { specifiers: INTERNAL_PURE_PACKAGE_EXCLUDES, names: INTERNAL_PURE_PACKAGE_NAMES } =
  discoverPureInternalPackages();

/**
 * 「带第三方依赖」的内部 workspace 包(maker-core / maker-cc-manager 等)仍走 optimizeDeps
 * 预打包(见上方注释:排除它们会把 CJS 子依赖拖出预打包,不安全)。但 Vite 的预打包缓存失效
 * 判据不含软链包的源码内容 —— 这些包的源码变了(git pull / 本地编辑)后,冷启动仍会被服务旧
 * 缓存,renderer 在模块求值期抛 `does not provide an export named X`,整窗黑屏且主进程日志
 * 零痕迹(docs/dev-rules/development-workflow.md「stale prebundle 白屏陷阱」)。
 *
 * 这里在 dev server 启动前对这些包的源码做一次轻量指纹(相对路径 + mtime + size,不读内容,
 * 跳过 node_modules / dist / .git),与上次启动留在 cache 目录里的 marker 比对:变了就直接删掉
 * `node_modules/.vite/deps` 强制全量重新预打包。删缓存而非 optimizeDeps.force 的原因:marker
 * 在删除后立即写盘,若随后的 optimize 中途崩溃,缓存目录仍是缺失态,下次启动自然重新 optimize,
 * 不会出现「marker 已更新但缓存还是旧的」的错位。
 *
 * 仅 dev serve 生效;`vite build` 不读 optimizeDeps,本守卫不参与。
 */
function collectPrebundledInternalPackageDirs(): string[] {
  const packagesDir = path.resolve(__dirname, '../../packages');
  const dirs: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, entry.name);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      // 与 discoverPureInternalPackages 互补:纯源码包已被 exclude,无预打包缓存
      // 可言;只有 dep-bearing 包(仍被预打包)的源码变化需要触发缓存失效。
      if (Object.keys(pkg.dependencies ?? {}).length === 0) continue;
      dirs.push(pkgDir);
    } catch {
      // 跳过无法解析的 package.json。
    }
  }
  return dirs;
}

function computeInternalSrcDigest(dirs: string[]): string {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', 'coverage']);
  const entries: string[] = [];
  const walk = (dir: string, base: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        walk(path.join(dir, d.name), base);
      } else if (d.isFile()) {
        const abs = path.join(dir, d.name);
        try {
          const st = fs.statSync(abs);
          entries.push(`${path.relative(base, abs).split(path.sep).join('/')}:${st.mtimeMs}:${st.size}`);
        } catch {
          // 文件在扫描间隙被删 → 忽略,下次启动指纹自然不同。
        }
      }
    }
  };
  for (const dir of dirs) walk(dir, path.dirname(dir));
  entries.sort();
  return crypto.createHash('sha1').update(entries.join('\n')).digest('hex');
}

function invalidateStalePrebundleCache(): void {
  const cacheRoot = path.resolve(__dirname, 'node_modules/.vite');
  const markerPath = path.join(cacheRoot, 'internal-src-digest.json');
  const digest = computeInternalSrcDigest(collectPrebundledInternalPackageDirs());
  let prev: string | null = null;
  try {
    prev = (JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { digest?: string }).digest ?? null;
  } catch {
    // marker 缺失 / 损坏 → 视为指纹变化,走失效路径重建。
  }
  if (prev === digest) return;
  fs.rmSync(path.join(cacheRoot, 'deps'), { recursive: true, force: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ digest, updatedAt: new Date().toISOString() }, null, 2));
  // eslint-disable-next-line no-console -- vite config 运行在构建工具进程,无应用 logger 可用
  console.log('[vite.renderer] internal package sources changed — cleared dep prebundle cache (will re-optimize)');
}

export default defineConfig(({ command }) => {
  if (command === 'serve') invalidateStalePrebundleCache();
  if (command !== 'build') return rendererConfig;
  // 仅 fixtures 生产排除条件(implementation-plan v6.17 允许范围):renderer 现状
  // 不 import 登录 scenario fixtures,此 alias 为防御性兜底——未来任何 renderer
  // 代码引用 '@cindy/auth-client/fixtures',生产构建也只会拿到空 stub
  // (check-login-production-guard.mjs 以 sentinel 扫描产物兜底)。
  return {
    ...rendererConfig,
    resolve: {
      ...rendererConfig.resolve,
      alias: {
        ...rendererConfig.resolve.alias,
        '@cindy/auth-client/fixtures': path.resolve(
          __dirname,
          '../../packages/auth-client/fixtures/loginScenarios.production-stub.ts',
        ),
      },
    },
  };
});

const rendererConfig = {
  root: path.resolve(__dirname, 'src/renderer'),
  envDir: __dirname,
  plugins: [react(), pdfjsAssetsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
    // ProseMirror and CodeMirror both rely on instanceof checks for runtime
    // extension/decorator values. Dev pre-bundling can otherwise create multiple
    // class copies and make valid editor extensions look invalid.
    dedupe: [...TIPTAP_AND_PROSEMIRROR_PACKAGES, ...CODEMIRROR_RUNTIME_PACKAGES],
  },
  optimizeDeps: {
    exclude: [
      ...TIPTAP_AND_PROSEMIRROR_OPTIMIZE_EXCLUDES,
      ...CODEMIRROR_OPTIMIZE_EXCLUDES,
      ...INTERNAL_PURE_PACKAGE_EXCLUDES,
    ],
    // The diff highlighter runs in a lazily-created module Worker. Explicitly
    // include its dependency so the first Review/Diff render does not trigger
    // Vite's runtime dependency discovery and a full-page reload.
    include: ['@tiptap/react', 'highlight.js'],
  },
  server: {
    watch: {
      // 被 exclude 的内部包以 node_modules 软链路径进模块图,默认 `**/node_modules/**`
      // 忽略规则会让 watcher 对它们的源码变更全盲(变更后引用新导出的组件热更、被引用包
      // 却停在旧模块 → 白屏,见 discoverPureInternalPackages 顶注)。反向 glob 豁免之。
      ignored: INTERNAL_PURE_PACKAGE_NAMES.map((name) => `!**/node_modules/${name}/**`),
    },
  },
  build: {
    // Force outDir relative to project root (not renderer root),
    // so electron-forge can find it at .vite/renderer/main_window/
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
    // AudioWorklet 模块脚本(`*-worklet.js`,经 `?url` 引入)绝不能被内联成
    // `data:` URI:worklet 加载受 CSP `script-src`(csp.ts,prod 无 data:)管辖,
    // 内联后 audioWorklet.addModule() 必被拦截(issue #903,语音输入整体失效)。
    // 这些文件小于默认阈值 4096B,不加此回调 Vite 会默认内联。
    // 注意本项目 Vite 5.4 不支持 `?no-inline` import query(Vite 6+ 才有),
    // 只能走这条配置;返回 undefined = 其余资产维持默认阈值行为。
    assetsInlineLimit: (filePath: string) =>
      /-worklet\.js$/.test(filePath) ? false : undefined,
  },
};
