/**
 * anthropic-compat-proxy CLI entry point.
 *
 * Usage:
 *   anthropic-compat-proxy --upstream <url> [--host 127.0.0.1]
 *
 * Behavior:
 *   - Starts a loopback HTTP proxy
 *   - Writes one JSON line to stdout once listening:
 *       {"url":"http://127.0.0.1:54321","upstream":"https://..."}
 *   - Stays alive until SIGINT/SIGTERM, then gracefully closes
 *
 * Used by cc-manager (remote) to spawn the proxy when host pref
 * compatProxyMode='on'. Manager parses the JSON line for the URL and injects
 * it as ANTHROPIC_BASE_URL into the cc subprocess env.
 *
 * Bundled via `pnpm --filter @cindy/anthropic-compat-proxy bundle` →
 * dist/proxy.mjs (esbuild --bundle, no runtime deps, ~20-50KB).
 */

import { createAnthropicCompatProxy } from '../server.js';
import { createEnvOutboundProxyResolver } from '../outbound-proxy.js';
import { ALLOW_NON_LOOPBACK_ENV, resolveListenHost } from '../host-guard.js';

interface ParsedArgs {
  command: 'serve' | 'version' | 'help';
  upstream?: string;
  host?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return { command: 'help' };
  }
  if (rest[0] === '--version' || rest[0] === '-v') {
    return { command: 'version' };
  }
  let upstream: string | undefined;
  let host: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--upstream' || rest[i] === '-u') {
      upstream = rest[i + 1];
      i++;
    } else if (rest[i] === '--host') {
      host = rest[i + 1];
      i++;
    }
  }
  if (!upstream) {
    return { command: 'help' };
  }
  return { command: 'serve', upstream, ...(host ? { host } : {}) };
}

function printHelp(): void {
  process.stderr.write(
    [
      'anthropic-compat-proxy — strip Anthropic-only fields for non-Anthropic gateways',
      '',
      'Usage:',
      '  anthropic-compat-proxy --upstream <url> [--host 127.0.0.1]',
      '',
      'Required:',
      '  --upstream, -u <url>   Anthropic-compatible gateway URL',
      '',
      'Optional:',
      '  --host <addr>          Listen address. Default 127.0.0.1. Loopback only',
      '                         (127.0.0.1 / ::1 / localhost); non-loopback is',
      '                         refused because the proxy forwards credentials.',
      '                         Set XDT_PROXY_ALLOW_NON_LOOPBACK=1 to override.',
      '  --version, -v          Print version JSON',
      '  --help, -h             This message',
      '',
      'On listen, the proxy writes ONE JSON line to stdout, then stays alive until',
      'SIGINT/SIGTERM:',
      '  {"url":"http://127.0.0.1:54321","upstream":"https://..."}',
      '',
    ].join('\n'),
  );
}

const VERSION = '0.0.0';

function printVersion(): void {
  process.stdout.write(JSON.stringify({ version: VERSION }) + '\n');
}

async function runServe(upstream: string, host?: string): Promise<void> {
  // 安全 gate:该代理逐字转发 authorization / x-api-key 到上游,只应绑本机回环。
  // 非 loopback host 一律 fail-closed 拒绝启动,除非显式开启逃生阀(见 host-guard.ts)。
  const requestedHost = host ?? '127.0.0.1';
  const guard = resolveListenHost(requestedHost, process.env[ALLOW_NON_LOOPBACK_ENV] === '1');
  if (!guard.ok) {
    process.stderr.write(`[proxy][error] ${guard.error}\n`);
    process.exit(1);
  }
  if (guard.warning) {
    process.stderr.write(`[proxy][warn] ${guard.warning}\n`);
  }

  const handle = await createAnthropicCompatProxy({
    upstream,
    host: guard.host,
    // CLI 场景(远端 cc-manager 等)按惯例吃代理环境变量:HTTPS_PROXY / HTTP_PROXY /
    // ALL_PROXY / NO_PROXY。未设置 = 直连,行为与之前一致。
    resolveOutboundProxy: createEnvOutboundProxyResolver(),
    logger: {
      // Send all logs to stderr; stdout reserved for the JSON listen line.
      info: (msg, ctx) => process.stderr.write(`[proxy][info] ${msg} ${JSON.stringify(ctx ?? {})}\n`),
      warn: (msg, ctx) => process.stderr.write(`[proxy][warn] ${msg} ${JSON.stringify(ctx ?? {})}\n`),
      error: (msg, ctx) => process.stderr.write(`[proxy][error] ${msg} ${JSON.stringify(ctx ?? {})}\n`),
    },
  });
  // Single JSON line to stdout — parseable by parent process.
  process.stdout.write(
    JSON.stringify({ url: handle.url, upstream }) + '\n',
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`[proxy] received ${signal}, shutting down\n`);
    try {
      await handle.dispose();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case 'help':
      printHelp();
      process.exit(args.command === 'help' && process.argv.length > 2 && process.argv[2] !== '--help' && process.argv[2] !== '-h' ? 2 : 0);
      return;
    case 'version':
      printVersion();
      process.exit(0);
      return;
    case 'serve':
      await runServe(args.upstream!, args.host);
      return;
  }
}

void main().catch((err) => {
  process.stderr.write(`[proxy] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
