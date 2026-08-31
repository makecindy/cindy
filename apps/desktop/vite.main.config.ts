import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { desktopClientBuildEnv } from '../../scripts/shared/client-endpoint-build-env.mjs';

const configDir = path.dirname(fileURLToPath(import.meta.url));
// 登录 scenario fixtures 的生产空 stub(implementation-plan Step 0 WHAT4 生产排除
// 双保险之 build-time 层;check-login-production-guard.mjs 以 sentinel 双断言校验)。
const loginFixturesStub = path.resolve(
  configDir,
  '../../packages/auth-client/fixtures/loginScenarios.production-stub.ts',
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Local dev does not go through dev-remote-env.mjs, so provide the same
  // production service endpoints from the shared config at bundle time. An
  // explicit .env/process override still wins, while API/Auth keep their
  // localhost defaults below.
  const configuredClientEnv = desktopClientBuildEnv({ allowEnvOverride: false });
  const readViteEnv = (key: keyof typeof configuredClientEnv): string =>
    env[key] || process.env[key] || configuredClientEnv[key];
  // 非 VITE_* 的 main-only 变量（不暴露到 renderer/preload；编译期注入）
  const allEnv = loadEnv(mode, process.cwd(), '');
  const readMainEnv = (key: string): string => allEnv[key] || process.env[key] || '';
  const readMainEnvPreservingEmpty = (key: string): string =>
    Object.prototype.hasOwnProperty.call(process.env, key)
      ? (process.env[key] ?? '')
      : (allEnv[key] ?? '');
  return {
    resolve: {
      // 仅 fixtures 生产排除条件(v6.17 允许范围):production 构建把
      // '@cindy/auth-client/fixtures' 整模块替换为空 stub,dev 构建保留真模块。
      alias:
        mode === 'production'
          ? [{ find: '@cindy/auth-client/fixtures', replacement: loginFixturesStub }]
          : [],
    },
    define: {
      'import.meta.env.VITE_CINDY_AUTH_REGION': JSON.stringify(
        readViteEnv('VITE_CINDY_AUTH_REGION'),
      ),
      // 本区与对端的两份端点清单自举基址(业务端点已全部改走运行期清单,
      // 旧的 VITE_API_BASE_URL 等端点 define 随之退役)。dev 构建也注入 cn 值,
      // `--endpoints-cdn` 才能零配置直连线上清单。
      'import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL': JSON.stringify(
        readViteEnv('VITE_ENDPOINT_MANIFEST_BASE_URL'),
      ),
      'import.meta.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL': JSON.stringify(
        readViteEnv('VITE_ENDPOINT_MANIFEST_PEER_BASE_URL'),
      ),
      // 日志上报目标(main-only,不暴露到 renderer)。真值不进仓,由 package-desktop.mjs 经
      // scripts/shared/log-upload-build-env.mjs 从 config/log-upload.json 读出**本区域那一个**
      // 目标后注入。dev server / 未注入 ⇒ 空串 ⇒ 运行时判「未配置」、功能整体关闭。
      // ⚠️ main 侧必须写成完整的 `process.env.XDT_LOG_UPLOAD_TARGET` 才能被本 define 文本替换,
      // 见 main/log-upload/logUploadTarget.ts 的 injectedRaw()。
      'process.env.XDT_LOG_UPLOAD_TARGET': JSON.stringify(readMainEnv('XDT_LOG_UPLOAD_TARGET')),
      // Triage bot token (dev only — production 留空，BotTokenStore 走 safeStorage)
      'process.env.TRIAGE_BOT_TOKEN': JSON.stringify(readMainEnv('TRIAGE_BOT_TOKEN')),
      // Filo Google OAuth desktop client（main-only，仓库不保存实际值）。
      'process.env.XDT_FILO_GOOGLE_CLIENT_ID': JSON.stringify(
        readMainEnv('XDT_FILO_GOOGLE_CLIENT_ID'),
      ),
      'process.env.XDT_FILO_GOOGLE_CLIENT_SECRET': JSON.stringify(
        readMainEnv('XDT_FILO_GOOGLE_CLIENT_SECRET'),
      ),
      // macOS WebAuthn Touch ID 的 Team ID 是公开签名身份，不是凭证。正式打包入口
      // 只在 Developer ID 签名路径注入；ad-hoc/dev 留空，runtime fail closed。
      'process.env.CINDY_WEBAUTHN_APPLE_TEAM_ID': JSON.stringify(
        readMainEnvPreservingEmpty('CINDY_WEBAUTHN_APPLE_TEAM_ID').trim(),
      ),
      'process.env.XDT_VOICE_INPUT_DICTIONARY_TEXT_DEBUG': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_DICTIONARY_TEXT_DEBUG'),
      ),
      'process.env.XDT_VOICE_INPUT_ASR_PROVIDER': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_ASR_PROVIDER'),
      ),
      'process.env.XDT_UTILITY_MODEL_PROVIDER': JSON.stringify(
        readMainEnv('XDT_UTILITY_MODEL_PROVIDER'),
      ),
      'process.env.XDT_UTILITY_MODEL': JSON.stringify(readMainEnv('XDT_UTILITY_MODEL')),
      'process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN': JSON.stringify(
        readMainEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN'),
      ),
      'process.env.XDT_VOICE_INPUT_REFINER_PROVIDER': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_REFINER_PROVIDER'),
      ),
      'process.env.XDT_VOICE_INPUT_REFINER_MODEL': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_REFINER_MODEL'),
      ),
      'process.env.XDT_VOICE_INPUT_REFINER_KEEPALIVE_MS': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_REFINER_KEEPALIVE_MS'),
      ),
      'process.env.XDT_VOICE_INPUT_DISABLE_REFINER_PREWARM': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_DISABLE_REFINER_PREWARM'),
      ),
      'process.env.XDT_VOICE_INPUT_REFINER_TIMING': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_REFINER_TIMING'),
      ),
      'process.env.XDT_VOICE_INPUT_DISABLE_PRECONNECT': JSON.stringify(
        readMainEnv('XDT_VOICE_INPUT_DISABLE_PRECONNECT'),
      ),
    },
    build: {
      rollupOptions: {
        output: {
          // Keep the vendored @cindy/browser-control-runtime (including its
          // dynamically-imported pw-ai.js / chrome-mcp.js) in ONE chunk. Otherwise
          // vite code-splits those dynamic imports into separate chunks that
          // `require()` the bootstrap-electron entry chunk again at load time →
          // bootstrap RE-EVALUATES → its module-top-level side effects re-run:
          //   - registerImageScheme() throws "registerSchemesAsPrivileged after
          //     ready" (→ browser navigate reports "Playwright unavailable"), and
          //   - the startup claude-orphan reaper re-runs and SIGKILLs the active
          //     agent.
          // Co-locating the whole package keeps the dynamic imports intra-chunk so
          // they resolve to the already-loaded module and never re-require/re-eval
          // the entry. See packages/browser-control-runtime.
          manualChunks(id: string) {
            const norm = id.replace(/\\/g, '/');
            if (norm.includes('/packages/browser-control-runtime/')) {
              return 'browser-control-runtime';
            }
            return undefined;
          },
        },
        // better-sqlite3 is a native (.node) addon — must NOT be bundled, must
        // be require()'d at runtime from node_modules. Same for ws transitive
        // optional native deps.
        // The compiled lark sdk does `require("protobufjs/minimal")` in a way
        // rollup-commonjs can't inline, so it leaks into the bundle as-is.
        // Externalize it explicitly and ship the package via forge's
        // NATIVE_RUNTIME_DEPS (protobufjs >=7.6 dropped `@protobufjs/inquire`).
        external: [
          // Electron's unpatched filesystem implementation. The legacy userData
          // migration needs physical .asar files to remain ordinary files.
          'original-fs',
          // node:sqlite is a Node 24 / Electron 41 builtin. The Vite process that
          // bundles main may still be Node 22, whose builtinModules list does not
          // include sqlite, so Vite stubs the specifier as
          // `__vite-browser-external`. Named imports like `backup` then fail and
          // a cold dev start never reaches ready-to-show.
          'sqlite',
          'node:sqlite',
          'bufferutil',
          'utf-8-validate',
          'better-sqlite3',
          'protobufjs',
          'protobufjs/minimal',
          // @parcel/watcher 也是 .node 原生模块,wrapper.js 内部用动态
          // require 选 platform-arch 子包(`@parcel/watcher-${platform}-${arch}`),
          // bundle 化会丢掉这条 resolve 路径并把 .node 引用从 node_modules
          // 切断。整个包 + 当前平台子包都得在运行时由 Node require。
          '@parcel/watcher',
          // sharp (libvips Node binding) — maker-core image-resizer 的依赖。
          // .node 原生模块 + 平台子包 (@img/sharp-${platform}-${arch} 和
          // @img/sharp-libvips-${platform}-${arch}), 必须运行时 require, 不能 bundle。
          'sharp',
          // loudness: voice-input 录音时静音用 (Windows-only path)。包内 Windows
          // 后端通过 __dirname 拼到自带的 adjust_get_current_system_volume_vista_plus.exe,
          // bundle 化会破坏路径解析。Mac 不走这里 (我们继续用 osascript), packaged
          // Mac 版本根本不会带上这个包。
          'loudness',
          // ssh2 (remote-ssh): 主体是纯 JS, 但内部 try/catch require('cpu-features')
          // 这条可选原生模块路径会被 rollup-commonjs 静态分析然后崩
          // (cpu-features 的 postinstall 默认被 pnpm 忽略, .node 不存在)。
          // 把 ssh2 整包 + cpu-features 都标 external —— ssh2 缺 cpu-features
          // 时会自动 fallback 到纯 JS cipher 选路, 功能完整。运行时由 Node 直接
          // require, 走 hoisted node_modules。
          'ssh2',
          'cpu-features',
          // ssh-config (remote-ssh): 解析 ~/.ssh/config。纯 JS, 但跟 ssh2
          // 同包 (@cindy/maker-remote-ssh) 出现, 同样不让 bundle 以保持依赖闭包对称。
          'ssh-config',
          // ws (codex remote transport, P2): SshDaemonTransport 用 ws/lib/receiver
          // + ws/lib/sender 给 ssh exec channel 上的 NDJSON over WebSocket 做帧编解码。
          // 主包 + 子路径都不让 vite bundle —— ws 内部 require() 几个可选 native
          // 加速包 (bufferutil / utf-8-validate) 触发跟 ssh2 一样的 commonjs 解析失败,
          // externalize 让 Node 运行时自己 try/catch fallback 到纯 JS 实现。
          'ws',
          'ws/lib/receiver',
          'ws/lib/sender',
          // discord.js uses circular CommonJS requires across managers, users,
          // channels, and messages. Rollup commonjs reordering can evaluate
          // those classes before their bases are initialized (`extends
          // undefined`) and crash Electron at startup. Keep the package as a
          // runtime Node require; forge.config.ts ships the JS dependency
          // closure in packaged builds.
          'discord.js',
          // @discordjs/ws lazy-imports zlib-sync as an optional compression fast
          // path; when absent it falls back internally. Keep that import external
          // so Rollup does not treat the optional package as a required bundle input.
          'zlib-sync',
          // node-pty (RSB 终端 tab 的 PTY 后端): .node 原生模块, 跟 better-sqlite3 同款,
          // 不能 bundle。main 进程通过 createRequire 在运行时 require, 走 hoisted
          // node_modules; packaged app 由 forge.config 的 NATIVE_RUNTIME_DEPS + rebuild
          // 流程把它放到 app.asar.unpacked/node_modules/node-pty/build/Release/pty.node。
          'node-pty',
        ],
        // gray-matter 的 JS frontmatter 引擎用了 eval,我们只走 YAML 引擎,
        // 这条警告纯噪音。只屏蔽这一处,保留对其他新增 eval 的告警能力。
        onwarn(warning, defaultHandler) {
          if (
            warning.code === 'EVAL' &&
            typeof warning.id === 'string' &&
            warning.id.replace(/\\/g, '/').includes('/gray-matter/lib/engines.js')
          ) {
            return;
          }
          defaultHandler(warning);
        },
      },
    },
  };
});
