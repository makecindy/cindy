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
 */
export type BackgroundCommandKind = 'work' | 'service';

const MAX_SCAN_CHARS = 4_000;
const MAX_SHELL_DEPTH = 3;

/** 只包一层再执行真实命令的前缀。 */
const WRAPPER_HEADS = new Set(['sudo', 'nohup', 'time', 'exec', 'env', 'command', 'npx', 'bunx', 'pnpx']);
const SHELL_HEADS = new Set(['bash', 'sh', 'zsh']);
/** 跑脚本名的入口：脚本名（按 `:` 分段）命中长驻词即服务。 */
const SCRIPT_RUNNER_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'turbo', 'nx', 'lerna', 'make', 'just']);
const SCRIPT_RUNNER_EXEC_ARGS = new Set(['exec', 'dlx', 'x']);
const LONG_LIVED_SCRIPT_WORDS = new Set(['dev', 'start', 'serve', 'watch', 'preview', 'storybook']);

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
  for (const segment of splitCommandSegments(command)) {
    if (isLongLivedSegment(tokenize(segment), depth)) return true;
  }
  return false;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
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
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
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

  if (args.some((arg) => arg === '--watch' || arg.startsWith('--watch=') || arg === '--watchall')) {
    return true;
  }

  if (SHELL_HEADS.has(head)) {
    const scriptIndex = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c$/.test(token));
    if (scriptIndex < 0 || depth >= MAX_SHELL_DEPTH) return false;
    return isLongLivedCommand(unquote(tokens.slice(scriptIndex + 1).join(' ')), depth + 1);
  }

  if (SCRIPT_RUNNER_HEADS.has(head)) {
    const execIndex = tokens.findIndex(
      (token, index) => index > 0 && SCRIPT_RUNNER_EXEC_ARGS.has(token.toLowerCase()),
    );
    if (execIndex > 0 && depth < MAX_SHELL_DEPTH) {
      let rest = tokens.slice(execIndex + 1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
      return isLongLivedSegment(rest, depth + 1);
    }
    return positional.some(isLongLivedScriptName);
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

/**
 * 脚本名按 `:` 分段：首段是长驻词（`dev`、`start:prod`、`serve:docs`）或任一段是 `watch`
 * （`build:watch`）才算服务。只看首段是为了让 `build:preview` 这类会结束的构建仍按工作显示。
 */
function isLongLivedScriptName(name: string): boolean {
  const parts = name.split(':');
  return LONG_LIVED_SCRIPT_WORDS.has(parts[0]!) || parts.includes('watch');
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
