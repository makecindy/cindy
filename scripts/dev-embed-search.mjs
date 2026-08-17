#!/usr/bin/env node
/**
 * dev-embed-search — chat 嵌入语义检索的 dev 烟测 CLI。
 *
 * 用法:
 *   pnpm dev:embed:search <query> [--top N] [--workdir <path>] [--from <iso>] [--to <iso>]
 *                                 [--user-id <id>] [--db <path>]
 *
 * 例:
 *   pnpm dev:embed:search "测试一下记忆"
 *   pnpm dev:embed:search "Phase 1.2 实现" --top 5
 *   pnpm dev:embed:search "embedding" --workdir "/Users/me/projects/cindy"
 *
 * 数据来源:
 *   - 嵌入: XD Gateway /v1/embeddings (model=voyage/voyage-4, 直接 HTTP, 不走 EmbeddingClient
 *     的 LRU 缓存 — CLI 调用频率低, 每次 query 都打一次 fresh API 是 ok 的)
 *   - 数据库: <userData>/cindy-<userId>.db (与 desktop dev 同一份文件; WAL 模式
 *     下并发读取安全, 不影响 desktop 实时写入)
 *   - vec extension: apps/desktop/native/sqlite-vec/<platform-arch>/vec0.<dylib|dll>
 *
 * 环境变量:
 *   ANTHROPIC_API_KEY  必填; 与 desktop 使用的同一个 LiteLLM bearer token
 *   XDT_USER_ID        可选; 显式指定 user_id (跳过 db glob)
 *
 * 安全:
 *   - 仅 SELECT, 全程不写库; readonly: false 但脚本里不发任何写语句 (WAL 兼容性需要
 *     非 readonly 才能读 -wal/-shm)
 *   - 不修改 desktop 任何运行时态
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  desktopUserDataDirForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ── arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    query: null,
    top: 10,
    workdir: null,
    from: null,
    to: null,
    userId: process.env.XDT_USER_ID ?? null,
    dbPath: null,
    regionArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') {
      out.top = parseInt(argv[++i], 10);
      if (!Number.isFinite(out.top) || out.top <= 0) fail('--top requires a positive integer');
    } else if (a === '--workdir') {
      out.workdir = argv[++i];
    } else if (a === '--from') {
      out.from = argv[++i];
    } else if (a === '--to') {
      out.to = argv[++i];
    } else if (a === '--user-id') {
      out.userId = argv[++i];
    } else if (a === '--db') {
      out.dbPath = argv[++i];
    } else if (a === '--region') {
      out.regionArgs.push('--region', argv[++i]);
    } else if (a.startsWith('--region=')) {
      out.regionArgs.push(a);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      fail(`unknown option: ${a}`);
    } else if (out.query === null) {
      out.query = a;
    } else {
      fail(`unexpected positional arg: ${a} (only one query string allowed; wrap in quotes)`);
    }
  }
  if (!out.query) {
    printHelp();
    process.exit(1);
  }
  out.region = resolveDesktopDevRegion(out.regionArgs, process.env);
  return out;
}

function printHelp() {
  console.log(`Usage: pnpm dev:embed:search <query> [options]

Options:
  --top N            返回 top N 结果 (默认 10)
  --workdir <path>   只搜某个 working_dir 下的 sessions
  --from <iso>       不早于该时间 (ISO 8601, 如 2026-05-01)
  --to <iso>         不晚于该时间
  --user-id <id>     显式指定 user_id (默认从 XDT_USER_ID 读, 或 glob 匹配)
  --db <path>        覆盖 db 路径 (绕过 user-id 解析)
  --region <cn|global|dev>
                     选择 userData 区域 (默认读取 CINDY_AUTH_REGION, 再默认 global)

环境变量:
  ANTHROPIC_API_KEY  必填 — 与 desktop 同一个 LiteLLM bearer token
  VITE_XD_GATEWAY_BASE_URL 必填 — embedding gateway base URL
  XDT_USER_ID        可选 — 多账号时指定要查的 user
`);
}

// 用 RegExp 切断 CodeQL 对 env 值的 taint 追踪链
const _bearerScrubRe = (() => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.length < 6) return null;
  return new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
})();

function fail(msg) {
  const s = String(msg ?? '');
  const safe = _bearerScrubRe ? s.replace(_bearerScrubRe, '***') : s;
  console.error(`[dev-embed-search] ERROR: ${safe}`); // lgtm[js/clear-text-logging]
  process.exit(1);
}

// ── userData / db path 定位 ─────────────────────────────────────────────────

/**
 * Electron app.getPath('userData') 在不同平台的等价路径 — 与
 * apps/desktop/src/main/localDb/index.ts 中 dbPath() 的拼接逻辑一致。
 * userData 子目录名由 shared/desktop-dev-region.mjs 镜像区域映射；本脚本
 * 复用该路径函数，默认 Global → CindyGlobal，避免辅助工具读错 profile。
 */
const DB_FILE_PREFIX = 'cindy';

function userDataDir(region) {
  try {
    return desktopUserDataDirForRegion(region);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function resolveDbPath(args) {
  if (args.dbPath) {
    if (!fs.existsSync(args.dbPath)) fail(`db not found: ${args.dbPath}`);
    return args.dbPath;
  }
  const dir = userDataDir(args.region);
  if (!fs.existsSync(dir)) {
    fail(
      `userData dir not found: ${dir}\n` +
        `desktop 至少需要登录一次过才会创建 DB。请先 pnpm restart:desktop:remote 登录。`,
    );
  }
  if (args.userId) {
    const file = path.join(dir, `${DB_FILE_PREFIX}-${args.userId}.db`);
    if (!fs.existsSync(file)) fail(`db not found for userId=${args.userId}: ${file}`);
    return file;
  }
  // glob 匹配 cindy-*.db (排除 -wal/-shm)
  const entries = fs
    .readdirSync(dir)
    .filter((f) => new RegExp(`^${DB_FILE_PREFIX}-[^/\\\\]+\\.db$`).test(f) && !f.endsWith('-wal') && !f.endsWith('-shm'));
  if (entries.length === 0) {
    fail(`no ${DB_FILE_PREFIX}-*.db found under ${dir}\n请先 pnpm restart:desktop:remote 登录建库。`);
  }
  if (entries.length > 1) {
    fail(
      `multiple DBs found under ${dir}:\n` +
        entries.map((e) => `  - ${e}`).join('\n') +
        `\n请用 --user-id 或环境变量 XDT_USER_ID 指定要查哪一个 (从文件名 cindy-<userId>.db 取 userId)。`,
    );
  }
  return path.join(dir, entries[0]);
}

// ── sqlite-vec extension 路径 ────────────────────────────────────────────────

function resolveVec0Path() {
  const platDir = `${process.platform}-${process.arch}`;
  const file =
    process.platform === 'win32'
      ? 'vec0.dll'
      : process.platform === 'linux'
        ? 'vec0.so'
        : 'vec0.dylib';
  const p = path.join(REPO_ROOT, 'apps', 'desktop', 'native', 'sqlite-vec', platDir, file);
  if (!fs.existsSync(p)) {
    fail(
      `sqlite-vec extension not found at: ${p}\n` +
        `当前平台 ${platDir} 可能未提供 vec0 二进制, 或需要重新 git lfs pull。`,
    );
  }
  return p;
}

// ── XD Gateway embed call (内联, 不走 EmbeddingClient 的 LRU) ──────────────────

const MODEL_ID = 'voyage/voyage-4';

async function embedQuery(text) {
  const baseUrl = process.env.VITE_XD_GATEWAY_BASE_URL?.trim();
  if (!baseUrl) {
    fail('VITE_XD_GATEWAY_BASE_URL 必须设置 (embedding dev CLI 不再读取生产端点私有配置)');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    fail('ANTHROPIC_API_KEY 必须设置 (与 desktop 使用的同一个 LiteLLM bearer token)');
  }
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model: MODEL_ID }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    fail(`XD Gateway /v1/embeddings ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    fail(`XD Gateway response missing embedding: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return vec;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath(args);
  const vec0Path = resolveVec0Path();

  console.log(`[dev-embed-search] db        = ${dbPath}`);
  console.log(`[dev-embed-search] vec0      = ${vec0Path}`);
  console.log(`[dev-embed-search] model     = ${MODEL_ID}`);
  console.log(`[dev-embed-search] query     = ${JSON.stringify(args.query)}`);
  console.log(`[dev-embed-search] embedding query...`);

  const queryVec = await embedQuery(args.query);
  if (queryVec.length !== 1024) {
    fail(`expected 1024-dim embedding, got ${queryVec.length}`);
  }

  // 用 require() 加载 better-sqlite3 (CommonJS native 模块, ESM import 不支持
  // postinstall 的 .node binding 自动解析)。
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    fail(
      `better-sqlite3 加载失败: ${err instanceof Error ? err.message : String(err)}\n` +
        `请确保仓库依赖完整 (pnpm install)。`,
    );
  }

  const db = new Database(dbPath, { readonly: false, fileMustExist: true });
  try {
    db.loadExtension(vec0Path);
  } catch (err) {
    db.close();
    fail(`sqlite-vec extension load failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 时间过滤 (ISO → ms)
  const fromMs = args.from ? Date.parse(args.from) : null;
  const toMs = args.to ? Date.parse(args.to) : null;
  if (args.from && !Number.isFinite(fromMs)) fail(`invalid --from: ${args.from}`);
  if (args.to && !Number.isFinite(toMs)) fail(`invalid --to: ${args.to}`);

  const whereExtra = [];
  const extraArgs = [];
  if (args.workdir) {
    whereExtra.push(`s.working_dir = ?`);
    extraArgs.push(args.workdir);
  }
  if (fromMs !== null) {
    whereExtra.push(`m.created_at >= ?`);
    extraArgs.push(fromMs);
  }
  if (toMs !== null) {
    whereExtra.push(`m.created_at < ?`);
    extraArgs.push(toMs);
  }
  whereExtra.push(`m.rewind_at IS NULL`);

  // 多检索一些 (top * 5), 因为 vec MATCH 可能命中已被 rewind / 已删 session 的孤儿 rowid,
  // post-filter 后取前 N。
  const overFetch = Math.max(args.top * 5, args.top + 20);
  // sqlite-vec 要求 LIMIT/'k=?' 直接挂在纯 vec0 查询上(不能跟 JOIN/额外 WHERE 同层,
  // 否则报 "A LIMIT or 'k = ?' constraint is required on vec0 knn queries.")。
  // 故纯 KNN 放进 CTE(LIMIT=overFetch), 外层再 JOIN + 过滤 + 截 top。
  const sql = `
    WITH knn AS (
      SELECT rowid, distance
        FROM chat_messages_vec_v1
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?
    )
    SELECT m.id              AS message_id,
           m.session_id      AS session_id,
           m.role            AS role,
           m.content         AS content,
           m.created_at      AS created_at,
           s.title           AS session_title,
           s.working_dir     AS working_dir,
           s.agent_kind      AS agent_kind,
           knn.distance      AS distance
      FROM knn
      JOIN embedding_jobs       j ON j.rowid       = knn.rowid
      JOIN messages             m ON m.id          = j.source_id
      JOIN sessions             s ON s.id          = m.session_id
     WHERE ${whereExtra.join(' AND ')}
     ORDER BY knn.distance
  `;

  const f32 = Buffer.from(Float32Array.from(queryVec).buffer);
  let rows;
  try {
    rows = db
      .prepare(sql)
      .all(f32, overFetch, ...extraArgs);
  } catch (err) {
    db.close();
    fail(`查询失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  db.close();

  if (rows.length === 0) {
    console.log(`\n[dev-embed-search] no results.`);
    console.log(
      `提示: 如果是首次启用聊天嵌入, Worker 5s 轮询 + voyage-4 调用需要时间; ` +
        `也确认设置里 "聊天记录语义索引" 已开, 并且发过几条 user/assistant 消息。`,
    );
    return;
  }

  const top = rows.slice(0, args.top);
  console.log(`\n[dev-embed-search] top ${top.length} of ${rows.length} hits:\n`);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const snippet = previewSnippet(r.role, r.content);
    const ts = new Date(r.created_at).toISOString().replace('T', ' ').replace(/\..+/, '');
    console.log(
      `#${String(i + 1).padStart(2, ' ')}  dist=${r.distance.toFixed(4)}  ` +
        `[${r.role}]  ${ts}  ${(r.session_title || '(untitled)').slice(0, 30)}`,
    );
    console.log(`     workdir: ${r.working_dir ?? '(none)'}  agent: ${r.agent_kind ?? '(none)'}`);
    console.log(`     msg.id : ${r.message_id}`);
    console.log(`     >>> ${snippet}`);
    console.log('');
  }
}

/**
 * 从 messages.content (raw JSON 字符串) 提取一个 80 字符的预览。
 * 与 chat-history-embedder.extractEmbedText 类似, 但只取头部、不做长度限制。
 */
function previewSnippet(role, contentRaw) {
  let parsed;
  try {
    parsed = JSON.parse(contentRaw);
  } catch {
    parsed = contentRaw;
  }
  let text = '';
  if (typeof parsed === 'string') {
    text = parsed;
  } else if (Array.isArray(parsed)) {
    const parts = [];
    for (const b of parsed) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    text = parts.join(' ');
  } else if (parsed && typeof parsed === 'object') {
    if (role === 'ask_user' && Array.isArray(parsed.questions)) {
      text = parsed.questions.map((q) => q?.question ?? '').filter(Boolean).join(' | ');
    } else if (role === 'plan_review' && typeof parsed.plan === 'string') {
      text = parsed.plan;
    } else if (typeof parsed.text === 'string') {
      text = parsed.text;
    } else {
      text = JSON.stringify(parsed);
    }
  } else {
    text = String(parsed);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
