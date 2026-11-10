/**
 * 后台命令（Claude Code `Bash` 的 run_in_background）是「正在工作」还是「后台服务」。
 *
 * SDK 只给命令文本和一句描述，没有「这是长驻服务」的标记，只能由宿主从命令写法判断：
 *  - work：会自己结束的命令（测试、构建、类型检查）。结束后 CLI 自动开新一轮，任务没做完。
 *  - service：启动后不会自己结束的命令（本地预览服务、文件监听、日志跟随）。任务已经做完，
 *    只是留了个进程。
 *
 * 认不出来一律按 work：把工作显示成「已结束」是这条规则要修的问题，漏认的服务最多亮到
 * SDK 的后台命令超时（默认 30 分钟、上限 2 小时）。这是经验规则，不参与回合是否结束、
 * 停止语义或完成提醒，只影响展示。
 *
 * 不变量（评审收敛时定下，新增判断前先对照）：
 *  1. 只有「命令自己的前台部分永远不会结束」才是 service；其余一律 work。
 *  2. 命令的存活时间由前台部分决定：`;` `&&` `||` 换行是顺序执行，卡在第一个不会结束的段；
 *     `|` 管道只要有一段不结束就不结束；以单个 `&` 结尾的段是后台作业，命令不等它
 *     （除非有 `wait`），所以 `pnpm dev & …; pnpm test; kill $!` 是 work。
 *  3. 只看真正执行的程序名与子命令：选项和选项取值（`--include dev`、`--filter dev`）、包管理
 *     的安装发布类子命令不是脚本名；`2>&1`、`&>` 里的 `&` 不是命令分隔符；heredoc 正文
 *     （`cat <<'EOF' > script` … `EOF`）是数据，不是命令。
 *  4. 单一判断入口：splitCommandSegments 拆段，isLongLivedCommand 汇总，isLongLivedSegment
 *     判单段；shell -c 递归复用同一套，不另写第二份。
 *  5. 看不懂的结构（子 shell、`$(…)`、控制流）不猜，按 work。外层命令不认识（`nice`、`ionice`、
 *     `timeout` 等）同理：不让内层参数（`--watch`）越过它直接决定结果。
 *
 * 范围（有意不处理，按 work）：子 shell / 命令组 / `$(…)`、`while`/`for` 等控制流、`xargs`、
 * shell 别名与函数、不在下面各表里的程序。这些写法启动的服务会多亮一段时间（最多到 SDK 的后台
 * 命令超时），不会让工作被误显示为已结束。新增判断必须是某条不变量的缺口，不为单个写法加特例。
 */
export type BackgroundCommandKind = 'work' | 'service';

const MAX_SCAN_CHARS = 4_000;
const MAX_SHELL_DEPTH = 3;

/** 只包一层再执行真实命令的前缀。 */
const WRAPPER_HEADS = new Set(['sudo', 'nohup', 'time', 'exec', 'env', 'command', 'npx', 'bunx', 'pnpx']);
const SHELL_HEADS = new Set(['bash', 'sh', 'zsh']);
/** 跑脚本名的入口：脚本名（按 `:` 分段）命中长驻词即服务。 */
const SCRIPT_RUNNER_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'turbo', 'nx', 'lerna', 'make', 'just']);
/** 包管理器的「执行外部程序」子命令：后面跟的是真实命令，递归判断。 */
const SCRIPT_RUNNER_EXEC_SUBCOMMANDS = new Set(['exec', 'dlx', 'x']);
/** 「运行脚本」子命令：脚本名在它后面。 */
const SCRIPT_RUN_SUBCOMMANDS = new Set(['run', 'run-script']);
/** 安装、发布等不执行项目脚本的子命令：选项值（`--include dev`）不是脚本名。 */
const PACKAGE_ADMIN_SUBCOMMANDS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'link',
  'unlink', 'publish', 'pack', 'init', 'create', 'audit', 'outdated', 'list', 'ls', 'why',
  'config', 'cache', 'store', 'prune', 'dedupe', 'rebuild', 'login', 'logout', 'whoami', 'view',
  'info', 'search', 'help', 'version', 'fetch', 'import', 'patch', 'approve-builds',
]);
/** 后面跟一个取值的选项（`--filter desktop`）：取值不是子命令也不是脚本名。 */
const VALUE_OPTIONS = new Set([
  '--filter', '-f', '--prefix', '--cwd', '--dir', '-c', '--workspace', '--include', '--omit',
  '--registry', '--loglevel', '--reporter', '--config', '--userconfig', '--cache', '--tag',
]);
const LONG_LIVED_SCRIPT_WORDS = new Set(['dev', 'start', 'serve', 'watch', 'preview', 'storybook']);

/** 带监听模式的工具：参数里有 `--watch` 才算长驻。 */
const WATCH_CAPABLE_HEADS = new Set([
  'vitest', 'jest', 'tsc', 'tsx', 'mocha', 'ava', 'karma', 'webpack', 'rollup', 'esbuild', 'tsup',
  'parcel', 'sass', 'tailwindcss',
]);

/** 启动即长驻的程序。 */
const SERVICE_HEADS = new Set([
  'nodemon',
  'webpack-dev-server',
  'http-server',
  'live-server',
  'browser-sync',
  'json-server',
  'serve',
  'uvicorn',
  'gunicorn',
  'hypercorn',
  'daphne',
  'ngrok',
  'cloudflared',
  'redis-server',
  'mongod',
  'watchexec',
  'fswatch',
  'metro',
]);

/** 程序 + 子命令才是长驻。 */
const SERVICE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  next: new Set(['dev', 'start']),
  nuxt: new Set(['dev', 'preview', 'start']),
  astro: new Set(['dev', 'preview']),
  remix: new Set(['dev']),
  webpack: new Set(['serve']),
  ng: new Set(['serve']),
  expo: new Set(['start']),
  'react-native': new Set(['start']),
  hugo: new Set(['server', 'serve']),
  jekyll: new Set(['serve', 's']),
  mkdocs: new Set(['serve']),
  docusaurus: new Set(['start', 'serve']),
  flask: new Set(['run']),
  rails: new Set(['s', 'server']),
  wrangler: new Set(['dev']),
  netlify: new Set(['dev']),
  vercel: new Set(['dev']),
  tauri: new Set(['dev']),
  storybook: new Set(['dev']),
  jupyter: new Set(['notebook', 'lab']),
  streamlit: new Set(['run']),
  cargo: new Set(['watch']),
  kubectl: new Set(['port-forward']),
  'electron-forge': new Set(['start']),
  'electron-vite': new Set(['dev', 'preview']),
  deno: new Set(['serve']),
};

export function classifyBackgroundCommand(command: string | null | undefined): BackgroundCommandKind {
  if (typeof command !== 'string') return 'work';
  return isLongLivedCommand(command.slice(0, MAX_SCAN_CHARS), 0) ? 'service' : 'work';
}

function isLongLivedCommand(command: string, depth: number): boolean {
  // 引号内的 `&&` / `;` 不是命令分隔符：`bash -c "cd app && pnpm dev"` 要整体交给 shell 分支。
  const segments = splitCommandSegments(command);
  // 有 `wait` 才会等后台作业；没有时，单个 `&` 结尾的段不决定命令的存活时间。
  const waitsForJobs = segments.some((segment) => tokenize(segment.text)[0] === 'wait');
  for (const segment of segments) {
    if (segment.background && !waitsForJobs) continue;
    if (isLongLivedSegment(tokenize(segment.text), depth)) return true;
  }
  return false;
}

interface CommandSegment {
  text: string;
  /** 以单个 `&` 结尾：后台作业。 */
  background: boolean;
}

function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const push = (background: boolean): void => {
    segments.push({ text: current, background });
    current = '';
  };
  // 本行出现过的 heredoc 结束词；下一个换行之后的正文整段跳过。
  const pendingHeredocs: string[] = [];
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        // here-string `<<<`：不是 heredoc。
        current += '<<<';
        i += 2;
        continue;
      }
      const heredoc = HEREDOC_OPERATOR.exec(command.slice(i, i + 200));
      if (heredoc) {
        pendingHeredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]!);
        current += heredoc[0];
        i += heredoc[0].length - 1;
        continue;
      }
    }
    if (ch === '&') {
      // `2>&1`、`>&2`、`&>file` 里的 & 属于重定向，不是分隔符。
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch;
        continue;
      }
      if (next === '&') {
        // `&&`：顺序执行，两个字符一起消费。
        i += 1;
        push(false);
        continue;
      }
      push(true);
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|') {
      if (ch === '|' && command[i + 1] === '|') i += 1;
      push(false);
      if (ch === '\n') {
        for (const delimiter of pendingHeredocs.splice(0)) {
          i = skipHeredocBody(command, i + 1, delimiter) - 1;
        }
      }
      continue;
    }
    current += ch;
  }
  push(false);
  return segments;
}

/** `<<EOF`、`<<-EOF`、`<<'EOF'`、`<<"EOF"`：结束词在第 1、2、3 个捕获组之一。 */
const HEREDOC_OPERATOR = /^<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

/** 从 `start`（正文第一行行首）找结束行，返回结束行之后的位置；找不到就吞到结尾。 */
function skipHeredocBody(command: string, start: number, delimiter: string): number {
  let lineStart = start;
  while (lineStart < command.length) {
    const lineEnd = command.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? command.length : lineEnd;
    if (command.slice(lineStart, end).trim() === delimiter) return lineEnd < 0 ? command.length : lineEnd + 1;
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return command.length;
}

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

function unquote(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, '');
}

function isLongLivedSegment(rawTokens: string[], depth: number): boolean {
  let tokens = rawTokens;
  // 剥掉环境变量赋值与只包一层的前缀（含它们自己的选项），露出真实命令。
  for (;;) {
    const first = tokens[0];
    if (first === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      tokens = tokens.slice(1);
      continue;
    }
    if (WRAPPER_HEADS.has(programName(first))) {
      tokens = tokens.slice(1);
      while (tokens[0]?.startsWith('-')) tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  const head = programName(tokens[0]!);
  const args = tokens.slice(1).map((token) => unquote(token).toLowerCase());
  const positional = args.filter((arg) => !arg.startsWith('-'));

  // `--watch` 只对认得的程序生效（带监听模式的工具、包管理器转发给脚本的参数）。不认识的外层命令
  // （`timeout -k 5s 60s pnpm vitest --watch`、`nice`…）不让内层参数直接决定结果，按工作。
  if (WATCH_CAPABLE_HEADS.has(head) && args.some(isWatchFlag)) return true;

  if (SHELL_HEADS.has(head)) {
    const scriptIndex = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c$/.test(token));
    if (scriptIndex < 0 || depth >= MAX_SHELL_DEPTH) return false;
    return isLongLivedCommand(unquote(tokens.slice(scriptIndex + 1).join(' ')), depth + 1);
  }

  if (SCRIPT_RUNNER_HEADS.has(head)) {
    const parsed = parsePackageRunnerCommand(tokens);
    if (!parsed) return false;
    if (SCRIPT_RUNNER_EXEC_SUBCOMMANDS.has(parsed.subcommand)) {
      if (depth >= MAX_SHELL_DEPTH) return false;
      let rest = tokens.slice(parsed.subcommandIndex + 1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
      return isLongLivedSegment(rest, depth + 1);
    }
    if (PACKAGE_ADMIN_SUBCOMMANDS.has(parsed.subcommand)) return false;
    // 包管理器会把参数转给脚本（`pnpm test --watch`、`npm test -- --watch`）。
    if (args.some(isWatchFlag)) return true;
    // `yarn workspace web dev`：子命令后先跟工作区名，脚本名在其后。
    const scriptName = SCRIPT_RUN_SUBCOMMANDS.has(parsed.subcommand)
      ? parsed.positionals[1]
      : parsed.subcommand === 'workspace'
        ? parsed.positionals[2]
        : parsed.subcommand;
    return scriptName !== undefined && isLongLivedScriptName(scriptName);
  }

  if (SERVICE_HEADS.has(head)) return true;
  const subcommands = SERVICE_SUBCOMMANDS[head];
  if (subcommands && positional[0] !== undefined && subcommands.has(positional[0])) return true;

  switch (head) {
    case 'vite':
      // `vite` / `vite dev` / `vite preview` 长驻；`vite build` / `vite optimize` 会结束。
      // 选项的取值（`--port 5173`）也落在 positional 里，所以按「没有会结束的子命令」判断。
      return !positional.some((arg) => arg === 'build' || arg === 'optimize');
    case 'tail':
      return args.some((arg) => arg === '--follow' || /^-[a-z0-9]*f[a-z0-9]*$/i.test(arg));
    case 'docker':
      return positional[0] === 'compose' && isForegroundComposeUp(args.slice(args.indexOf('compose') + 1));
    case 'docker-compose':
      return isForegroundComposeUp(args);
    case 'php':
      return args.includes('-s') || (positional[0] === 'artisan' && positional[1] === 'serve');
    case 'firebase':
      return positional[0] === 'serve' || positional[0] === 'emulators:start';
    case 'deno':
      return positional[0] === 'task' && positional.slice(1).some(isLongLivedScriptName);
    case 'python':
    case 'python3':
      return isLongLivedPython(args, positional);
    default:
      return false;
  }
}

/** `--watch` / `--watch=true` / `--watchAll` 开监听；`--watch=false`、`--watch=0`、`--no-watch` 明确关掉。 */
function isWatchFlag(arg: string): boolean {
  if (arg === '--watch' || arg === '--watchall') return true;
  if (!arg.startsWith('--watch=')) return false;
  const value = arg.slice('--watch='.length);
  return value !== 'false' && value !== '0' && value !== 'no' && value !== 'off';
}

/**
 * 脚本名按 `:` 分段：首段是长驻词（`dev`、`start:prod`、`serve:docs`）或任一段是 `watch`
 * （`build:watch`）才算服务。只看首段是为了让 `build:preview` 这类会结束的构建仍按工作显示。
 */
function isLongLivedScriptName(name: string): boolean {
  const parts = name.split(':');
  return LONG_LIVED_SCRIPT_WORDS.has(parts[0]!) || parts.includes('watch');
}

/**
 * 拆包管理器命令（`pnpm --filter desktop test`）：跳过选项和它们的取值，第一个位置参数是子命令，
 * 其后的位置参数按子命令的含义解读。选项取值（`--include dev`、`--filter dev`）因此不会被当成
 * 脚本名。`--` 之后原样交给脚本，不再解析。
 */
function parsePackageRunnerCommand(
  tokens: readonly string[],
): { subcommand: string; subcommandIndex: number; positionals: string[] } | null {
  const positionals: string[] = [];
  let subcommandIndex = -1;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = unquote(tokens[i]!).toLowerCase();
    if (token === '--') break;
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    if (subcommandIndex < 0) subcommandIndex = i;
    positionals.push(token);
  }
  const subcommand = positionals[0];
  return subcommand === undefined ? null : { subcommand, subcommandIndex, positionals };
}

function programName(token: string): string {
  const name = unquote(token).toLowerCase();
  const slash = name.lastIndexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function isForegroundComposeUp(args: readonly string[]): boolean {
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional[0] !== 'up') return false;
  return !args.some((arg) => arg === '-d' || arg === '--detach');
}

function isLongLivedPython(args: readonly string[], positional: readonly string[]): boolean {
  const moduleIndex = args.indexOf('-m');
  if (moduleIndex >= 0) {
    const moduleName = args[moduleIndex + 1];
    if (moduleName === 'http.server' || moduleName === 'uvicorn' || moduleName === 'gunicorn') return true;
    return moduleName === 'flask' && args.slice(moduleIndex + 2).includes('run');
  }
  return positional[0]?.endsWith('manage.py') === true && positional[1] === 'runserver';
}
