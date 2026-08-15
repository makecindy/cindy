#!/usr/bin/env node
// ⚠️ dev-only 工具:把真实 xdt-maker/Cindy SQLite 的会话导出成移动端视觉预览快照。
// 导出物含真实聊天标题 / 工作目录 / 消息正文 / agentMeta,属敏感数据,安全约束(应 PR-104 review 收口):
//   1. 不再默认 auto 扫旧 xdt-maker 目录:必须显式 `--db <path>` 或 `--confirm-sensitive` 才导出真实库;
//   2. 明文 DB 副本与快照落私有目录(0700)+ 文件 0600,并在进程退出时清理(--keep 可保留);
//   3. serve 模式强制随机 token(路径带 ?token= 或 header),Origin 白名单默认只放 Expo dev 本地源,
//      不再 `Access-Control-Allow-Origin: *`;缺 token / Origin 不符一律 403。
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  desktopUserDataDirForRegion,
  resolveDesktopDevRegion,
} from '../../../scripts/shared/desktop-dev-region.mjs';

const DEFAULT_OUT_DIR = join(tmpdir(), 'cindy-mobile-realdata');
const DEFAULT_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 80;
const DEFAULT_PORT = 3344;
// serve 模式默认只接受来自 Expo dev server / 本地回环的跨源请求。
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
];

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(options.repo ?? join(import.meta.dirname, '..'));
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const Database = requireFromRepo('better-sqlite3');

const sourceDb = resolveDbPath(options.db, Boolean(options.confirmSensitive), options.region);
// 私有输出目录:0700,只有当前用户可进。
const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
mkdirSync(outDir, { recursive: true });
chmodSafe(outDir, 0o700);

const dbCopy = join(outDir, 'xdt-maker-realdata.db');
copySqliteBundle(sourceDb, dbCopy);

const snapshotPath = resolve(options.out ?? join(outDir, 'visualMockRealData.local.json'));
const snapshot = buildSnapshot(dbCopy, {
  sourceDbName: basename(sourceDb),
  deviceId: options.deviceId ?? 'cindy-realdata-mac',
  deviceName: options.deviceName ?? 'CINDY Real Data Mac',
  limit: positiveInt(options.limit, DEFAULT_LIMIT),
  messageLimit: positiveInt(options.messageLimit, DEFAULT_MESSAGE_LIMIT),
});
writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
chmodSafe(snapshotPath, 0o600);

// 非 serve 模式:一次性导出,用完即清明文副本(除非 --keep)。
// serve 模式:进程存活期间保留,SIGINT/SIGTERM 时清理。
const cleanupPaths = options.keep ? [] : [dbCopy, `${dbCopy}-wal`, `${dbCopy}-shm`, snapshotPath];
function cleanup() {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { force: true });
    } catch {}
  }
}

console.log(`snapshot: ${snapshotPath}`);
console.log(`db copy: ${dbCopy}${options.keep ? '' : ' (进程退出时清理)'}`);
console.log(`sessions: ${snapshot.sessions.length}`);
console.log(`messages: ${Object.values(snapshot.messagesBySession).reduce((sum, list) => sum + list.length, 0)}`);
console.log(`selected session: ${snapshot.selectedSessionId}`);

if (options.serve) {
  const port = positiveInt(options.port, DEFAULT_PORT);
  // 随机 token:每次启动新生成,client 必须带 ?token= 或 x-realdata-token header。
  const token = options.token ?? randomBytes(24).toString('base64url');
  const allowedOrigins = new Set(
    options.allowOrigin ? options.allowOrigin.split(',').map((s) => s.trim()) : DEFAULT_ALLOWED_ORIGINS,
  );
  const payload = JSON.stringify(snapshot, null, 2);

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    // Origin 白名单:带 Origin 头(浏览器跨源)时必须在白名单内;非浏览器(无 Origin)放行到 token 校验。
    const originAllowed = !origin || allowedOrigins.has(origin);
    if (origin && originAllowed) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-headers', 'x-realdata-token');
      res.writeHead(originAllowed ? 204 : 403);
      res.end();
      return;
    }
    if (!originAllowed) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden origin');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/' && url.pathname !== '/visualMockRealData.local.json') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // token 校验(定长比较防时序侧信道):query ?token= 或 header x-realdata-token。
    const provided = url.searchParams.get('token') ?? headerToken(req);
    if (!tokenMatches(provided, token)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('missing or invalid token');
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(payload);
  });
  server.listen(port, '127.0.0.1', () => {
    const tokenizedUrl = `http://127.0.0.1:${port}/visualMockRealData.local.json?token=${token}`;
    console.log(`serving (token-gated): ${tokenizedUrl}`);
    console.log(`  EXPO_PUBLIC_CINDY_MOBILE_REALDATA_URL=${tokenizedUrl}`);
    console.log(`  allowed origins: ${[...allowedOrigins].join(', ')}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close();
      cleanup();
      process.exit(0);
    });
  }
} else {
  // 一次性导出:如需长期保留供 serve,加 --keep;否则清理明文副本。
  cleanup();
}

function headerToken(req) {
  const raw = req.headers['x-realdata-token'];
  return Array.isArray(raw) ? raw[0] : raw ?? null;
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function chmodSafe(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {}
}

function buildSnapshot(dbPath, opts) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');

  const sessions = db.prepare(`
    select
      s.id as id,
      s.title as title,
      s.working_dir as workingDir,
      s.workspace_kind as workspaceKind,
      s.model as model,
      s.effort as effort,
      s.permission_mode as permissionMode,
      s.status as status,
      s.sdk_session_id as sdkSessionId,
      s.total_token_usage as totalTokenUsage,
      s.total_cost_usd as totalCostUsd,
      s.context_tokens as contextTokens,
      s.context_window as contextWindow,
      s.fast_mode as fastMode,
      s.cleared_at as clearedAt,
      s.pinned_at as pinnedAt,
      s.user_send_at as userSendAt,
      s.agent_kind as agentKind,
      s.source as source,
      s.orca_role as orcaRole,
      s.parent_session_id as parentSessionId,
      s.forked_at_message_id as forkedAtMessageId,
      s.worktree_path as worktreePath,
      s.used_project_context as usedProjectContext,
      s.extra_dirs as extraDirs,
      s.remote_host_id as remoteHostId,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      (
        select count(*)
        from messages m
        where m.session_id = s.id
          and m.rewind_at is null
      ) as messageCount,
      (
        select m.content
        from messages m
        where m.session_id = s.id
          and m.rewind_at is null
          and m.role in ('user', 'assistant', 'error')
        order by m.created_at desc, m.id desc
        limit 1
      ) as latestContent
    from sessions s
    where s.status = 'active'
    order by
      case when s.pinned_at is null then 1 else 0 end,
      coalesce(s.user_send_at, s.updated_at, s.created_at) desc,
      s.created_at desc
    limit ?
  `).all(opts.limit).map(sessionRow);

  const messageStmt = db.prepare(`
    select
      id,
      client_id as clientId,
      session_id as sessionId,
      role,
      content,
      tool_use_id as toolUseId,
      agent_meta as agentMeta,
      created_at as createdAt
    from messages
    where session_id = ?
      and rewind_at is null
    order by created_at desc, id desc
    limit ?
  `);
  const messagesBySession = {};
  for (const session of sessions) {
    messagesBySession[session.id] = messageStmt.all(session.id, opts.messageLimit).reverse().map(messageRow);
  }
  db.close();

  return {
    schema: 'cindy-mobile-visual-realdata-v1',
    generatedAt: new Date().toISOString(),
    source: {
      dbCopyPath: dbPath,
      sourceDbName: opts.sourceDbName,
    },
    device: {
      deviceId: opts.deviceId,
      name: opts.deviceName,
      platform: 'darwin',
      appVersion: '0.0.0-realdata-preview',
    },
    selectedSessionId: sessions[0]?.id ?? null,
    sessions,
    messagesBySession,
    pendingInteractionsBySession: {},
    projectionsBySession: {},
  };
}

function sessionRow(row) {
  const createdAt = msToIso(row.createdAt) ?? new Date().toISOString();
  return {
    id: String(row.id),
    userId: '',
    title: stringOr(row.title, 'New Maker'),
    workingDir: row.workingDir ?? null,
    workspaceKind: row.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    model: stringOr(row.model, 'claude-sonnet-4-6'),
    effort: stringOr(row.effort, 'medium'),
    permissionMode: stringOr(row.permissionMode, 'ask'),
    status: normalizeSessionStatus(row.status),
    sdkSessionId: row.sdkSessionId ?? null,
    totalTokenUsage: numberOrZero(row.totalTokenUsage),
    totalCostUsd: numberOrZero(row.totalCostUsd),
    contextTokens: numberOrZero(row.contextTokens),
    contextWindow: numberOrZero(row.contextWindow),
    fastMode: row.fastMode === 1 || row.fastMode === true,
    clearedAt: msToIso(row.clearedAt),
    pinnedAt: msToIso(row.pinnedAt),
    userSendAt: msToIso(row.userSendAt),
    agentKind: row.agentKind === 'codex' ? 'codex' : 'cc',
    source: row.source === 'scheduler' ? 'scheduler' : 'desktop',
    orcaRole: row.orcaRole ?? null,
    parentSessionId: row.parentSessionId ?? null,
    forkedAtMessageId: row.forkedAtMessageId ?? null,
    worktreePath: row.worktreePath ?? null,
    usedProjectContext: row.usedProjectContext === 1 || row.usedProjectContext === true,
    extraDirs: parseStringArray(row.extraDirs),
    remoteHostId: row.remoteHostId ?? null,
    createdAt,
    updatedAt: msToIso(row.updatedAt) ?? createdAt,
    preview: previewText(row.latestContent),
    _count: { messages: numberOrZero(row.messageCount) },
  };
}

function messageRow(row) {
  return {
    id: String(row.id),
    clientId: String(row.clientId ?? row.id),
    sessionId: String(row.sessionId),
    role: normalizeMessageRole(row.role),
    content: parseJson(row.content, row.content),
    toolUseId: row.toolUseId ?? null,
    agentMeta: row.agentMeta == null ? null : parseJson(row.agentMeta, null),
    createdAt: msToIso(row.createdAt) ?? new Date().toISOString(),
  };
}

// DB 来源解析:显式 --db 直接用;auto 扫描属"从真实库导出敏感数据",必须显式 --confirm-sensitive
// 才允许,避免脚本被无意运行就把整库聊天导出来。
function resolveDbPath(input, confirmSensitive, region) {
  if (input && input !== 'auto') {
    const explicit = resolve(input);
    if (!existsSync(explicit)) throw new Error(`--db 指定的文件不存在: ${explicit}`);
    return explicit;
  }
  if (!confirmSensitive) {
    throw new Error(
      '拒绝自动扫描真实库:auto 模式会导出真实聊天数据。请显式 `--db <path>` 指定库,' +
        '或加 `--confirm-sensitive` 明确确认要从默认目录导出敏感数据。',
    );
  }
  const appSupport = desktopUserDataDirForRegion(region);
  const entries = [];
  for (const name of safeReaddir(appSupport)) {
    if (!/^(xdt-maker|cindy)-.+\.db$/i.test(name)) continue;
    const full = join(appSupport, name);
    try {
      const stat = statSync(full);
      if (stat.isFile()) entries.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  if (!entries[0]) throw new Error(`no cindy/xdt-maker *.db found in ${appSupport}`);
  return entries[0].full;
}

function copySqliteBundle(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSafe(target, 0o600); // 明文副本仅当前用户可读写
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) {
      copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
      chmodSafe(`${target}${suffix}`, 0o600);
    }
  }
}

function parseArgs(args) {
  const parsed = {
    region: resolveDesktopDevRegion(args, {
      ...process.env,
      CINDY_AUTH_REGION:
        process.env.CINDY_AUTH_REGION ??
        process.env.EXPO_PUBLIC_CINDY_AUTH_REGION,
    }),
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') parsed.db = args[++i];
    else if (arg === '--region') i += 1;
    else if (arg.startsWith('--region=')) continue;
    else if (arg === '--out') parsed.out = args[++i];
    else if (arg === '--out-dir') parsed.outDir = args[++i];
    else if (arg === '--repo') parsed.repo = args[++i];
    else if (arg === '--limit') parsed.limit = args[++i];
    else if (arg === '--message-limit') parsed.messageLimit = args[++i];
    else if (arg === '--device-id') parsed.deviceId = args[++i];
    else if (arg === '--device-name') parsed.deviceName = args[++i];
    else if (arg === '--serve') parsed.serve = true;
    else if (arg === '--port') parsed.port = args[++i];
    else if (arg === '--confirm-sensitive') parsed.confirmSensitive = true;
    else if (arg === '--keep') parsed.keep = true;
    else if (arg === '--token') parsed.token = args[++i];
    else if (arg === '--allow-origin') parsed.allowOrigin = args[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node scripts/export-realdata-visual-snapshot.mjs [options]',
          '',
          'dev-only 工具:导出真实会话为移动端视觉预览快照(含敏感聊天数据)。',
          '',
          '  --db <path>           指定 SQLite 库路径(推荐);省略需配 --confirm-sensitive',
          '  --region <cn|global|dev> 选择默认 userData 区域(默认读取区域环境变量，再默认 global)',
          '  --confirm-sensitive   确认从所选区域的默认 profile 自动扫描真实库并导出',
          '  --serve               启动 token 门禁的本地 HTTP(仅回环 + Origin 白名单)',
          '  --port <n>            serve 端口(默认 3344)',
          '  --token <str>         固定 serve token(默认每次随机生成)',
          '  --allow-origin <csv>  覆盖 serve 允许的 Origin 白名单(逗号分隔)',
          '  --keep                保留明文 DB 副本与快照(默认用完清理)',
          '  --limit / --message-limit / --out / --out-dir / --device-id / --device-name',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  return parsed;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function msToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeSessionStatus(value) {
  return value === 'archived' || value === 'deleted' ? value : 'active';
}

function normalizeMessageRole(value) {
  return ['user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'system', 'error'].includes(value)
    ? value
    : 'assistant';
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseStringArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function previewText(value) {
  const parsed = parseJson(value, value);
  if (typeof parsed === 'string') return parsed.slice(0, 240);
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.text === 'string') return parsed.text.slice(0, 240);
    if (typeof parsed.message === 'string') return parsed.message.slice(0, 240);
  }
  return null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
