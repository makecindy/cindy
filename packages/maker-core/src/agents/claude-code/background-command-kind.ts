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
 *  2. 只读懂简单结构：简单命令用 `;` `&&` `||` 换行顺序连接、用 `|` 连成管道。顺序执行卡在第一个
 *     不会结束的段，管道只要有一段不结束就不结束。
 *  3. 只看真正执行的程序名与子命令：选项和选项取值（`--include dev`、`--filter dev`）、包管理
 *     的安装发布类子命令不是脚本名；`2>&1`、`&>` 里的 `&` 是重定向，不是分隔符。
 *  4. 单一判断入口：splitCommandSegments 拆段，isLongLivedCommand 汇总，isLongLivedSegment
 *     判单段；shell -c 递归复用同一套，不另写第二份。
 *  5. 超出第 2 条的 shell 语法一律不猜，整条命令按 work：后台 `&`（有 `&` 就说明命令的存活
 *     另有安排，`wait`、`kill` 等都无从静态判断）、注释 `#`、heredoc `<<`、控制流
 *     （`if`/`while`/`for`/`case`）、命令组与子 shell。外层命令不认识（`nice`、`timeout` 等）
 *     同理：不让内层参数（`--watch`）越过它直接决定结果。
 *
 * 范围（有意不处理，按 work）：上面第 5 条列出的语法、`$(…)`、`xargs`、shell 别名与函数、不在
 * 下面各表里的程序。这些写法启动的服务会多亮一段时间（最多到 SDK 的后台命令超时），不会让工作
 * 被误显示为已结束。新增判断必须是某条不变量的缺口，不为单个写法加特例；要读懂更多 shell 语法
 * 之前，先想想能不能把它划进第 5 条。
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
  const segments = splitCommandSegments(command);
  // 拆不干净（见不变量 5）或段首是控制流/命令组：整条命令不猜，按工作。
  if (!segments || segments.some((segment) => startsUnparsedStructure(tokenize(segment)[0]))) {
    return false;
  }
  return segments.some((segment) => isLongLivedSegment(tokenize(segment), depth));
}

/**
 * 拆成由 `;`、`&&`、`||`、`|`、换行连接的简单命令。引号内的分隔符不算：
 * `bash -c "cd app && pnpm dev"` 要整体交给 shell 分支。遇到本函数不读的 shell 语法
 * （后台 `&`、注释 `#`、heredoc `<<`）返回 null，调用方按工作处理。
 */
function splitCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    segments.push(current);
    current = '';
  };
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
    // 词首的 `#` 是注释：其后的 `;`、命令都不会执行。
    if (ch === '#' && (i === 0 || /\s/.test(command[i - 1]!))) return null;
    if (ch === '<' && command[i + 1] === '<') {
      if (command[i + 2] === '<') {
        // here-string `<<<` 只是输入重定向。
        current += '<<<';
        i += 2;
        continue;
      }
      return null; // heredoc：正文是数据，不是命令
    }
    if (ch === '&') {
      // `2>&1`、`>&2`、`&>file` 里的 & 属于重定向，不是分隔符。
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch;
        continue;
      }
      if (next !== '&') return null; // 单个 `&`：后台作业
      i += 1; // `&&`
      push();
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|') {
      if (ch === '|' && command[i + 1] === '|') i += 1;
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

/** 控制流关键字与命令组/子 shell 的起止符：出现在段首就说明这条命令里的执行顺序无法静态判断。 */
const CONTROL_FLOW_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac',
  'select', 'function', '{', '}',
]);

function startsUnparsedStructure(firstToken: string | undefined): boolean {
  if (firstToken === undefined) return false;
  return CONTROL_FLOW_WORDS.has(firstToken) || firstToken.startsWith('(') || firstToken.startsWith(')');
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
