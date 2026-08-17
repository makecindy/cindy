#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import Database from 'better-sqlite3';

import { BOT_TEMPLATES, getBotTemplate } from '../apps/desktop/src/renderer/features/bots/botTemplates.ts';
import {
  prepareMigrationRuntimeManifest,
  runMigrationReplay,
} from '../apps/desktop/src/main/localDb/migrationRunner.ts';
import { BRAND_IDENTITY } from '../packages/maker-shared/src/brandIdentity.ts';

const SANDBOX_NAME = 'cindy-bots-offline-demo';
const OWNER_ID = 'local-v1';
const KEYCHAIN_IDENTITY = 'CindyDev\n';
const OWNERSHIP_MARKER = '.cindy-bots-offline-demo.json';
const require = createRequire(import.meta.url);

type CliOptions = { output: string; replace: boolean; json: boolean };

function userDataParent(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function defaultOutputDir(): string {
  const globalName = BRAND_IDENTITY.userDataDirNameByRegion.global;
  return path.join(userDataParent(), `${globalName}-dev2-${SANDBOX_NAME}`);
}

function parseArgs(argv: string[]): CliOptions {
  let output = defaultOutputDir();
  let replace = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--replace') replace = true;
    else if (arg === '--json') json = true;
    else if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output requires a directory');
      output = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Seed the account-free Cindy Bots UI demo sandbox.',
          '',
          `Default sandbox: ${defaultOutputDir()}`,
          '',
          'Options:',
          '  --output <dir>  Seed a different directory (used by tests).',
          '  --replace       Replace an existing target directory.',
          '  --json          Print the result as JSON.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { output: path.resolve(output), replace, json };
}

function assertSafeOutput(output: string): void {
  const resolved = path.resolve(output);
  const forbidden = new Set([path.parse(resolved).root, os.homedir(), userDataParent()]);
  if (forbidden.has(resolved)) throw new Error(`Refusing unsafe output directory: ${resolved}`);
  if (path.basename(resolved).length < 8) {
    throw new Error(`Output directory basename is too broad: ${resolved}`);
  }
}

function assertOwnedReplacementTarget(output: string): void {
  const markerPath = path.join(output, OWNERSHIP_MARKER);
  let marker: unknown;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error(
      `Refusing to replace a directory not created by this demo seeder: ${output}`,
    );
  }
  if (
    !marker ||
    typeof marker !== 'object' ||
    (marker as { sandboxName?: unknown }).sandboxName !== SANDBOX_NAME
  ) {
    throw new Error(`Invalid Cindy Bots demo ownership marker: ${markerPath}`);
  }
}

function sqliteVecPath(): string {
  const filename = process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib';
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('The Cindy desktop migration bundle supports this demo on macOS or Windows');
  }
  return path.resolve(
    'apps/desktop/native/sqlite-vec',
    `${process.platform}-${process.arch}`,
    filename,
  );
}

function templateCapabilities(templateId: 'control' | 'pr-steward' | 'assistant') {
  const template = getBotTemplate(templateId);
  return {
    model: 'claude-sonnet-4-6',
    providerId: null,
    effort: 'high',
    fastMode: false,
    harness: 'claude',
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: false,
    permissions: 'ask',
    sessionControlMode: 'none',
    skills: [],
    userContextSource: '',
    ...template.capabilities,
  };
}

function insertSession(
  db: Database.Database,
  input: { id: string; title: string; status?: 'active' | 'archived'; source?: 'bot' | 'desktop'; at: number },
): void {
  db.prepare(
    `INSERT INTO sessions
      (id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
       agent_kind, source, created_at, updated_at)
     VALUES (?, ?, NULL, 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', ?, 'cc', ?, ?, ?)`,
  ).run(input.id, input.title, input.status ?? 'active', input.source ?? 'bot', input.at, input.at);
}

function insertBot(
  db: Database.Database,
  input: {
    id: string;
    templateId: 'control' | 'pr-steward' | 'assistant';
    name: string;
    description: string;
    status: 'active' | 'paused' | 'error';
    sessionId: string;
    at: number;
    runtimeStatus: 'applied' | 'prepared' | 'failed';
  },
): void {
  const template = getBotTemplate(input.templateId);
  const capabilities = templateCapabilities(input.templateId);
  db.prepare(
    `INSERT INTO bot_profiles
      (id, display_name, description, avatar, avatar_color, status, current_version,
       canonical_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.description,
    template.avatar,
    template.avatarColor,
    input.status,
    input.sessionId,
    input.at,
    input.at,
  );
  db.prepare(
    `INSERT INTO bot_profile_versions
      (id, bot_id, version, identity_source, capabilities_json, created_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(
    `${input.id}:v1`,
    input.id,
    template.identitySource,
    JSON.stringify(capabilities),
    input.at,
  );
  db.prepare(
    `INSERT INTO bot_channels
      (id, bot_id, kind, enabled, config_json, created_at, updated_at)
     VALUES (?, ?, 'local', 1, '{}', ?, ?)`,
  ).run(`${input.id}:local`, input.id, input.at, input.at);
  db.prepare(
    `INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, channel_id, created_at)
     VALUES (?, ?, ?, 1, 'canonical', ?, ?)`,
  ).run(`${input.id}:canonical`, input.id, input.sessionId, `${input.id}:local`, input.at);
  db.prepare(
    `INSERT INTO bot_runtime_snapshots
      (id, bot_id, session_id, profile_version, agent_kind, working_dir, memory_scope_key,
       configured_json, resolved_json, status, prepared_at, applied_at, failed_at, failure_json)
     VALUES (?, ?, ?, 1, 'claude-code', '', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${input.id}:runtime`,
    input.id,
    input.sessionId,
    `bot:${input.id}`,
    JSON.stringify(capabilities),
    JSON.stringify({ ...capabilities, templateId: input.templateId }),
    input.runtimeStatus,
    input.at,
    input.runtimeStatus === 'applied' ? input.at + 1_000 : null,
    input.runtimeStatus === 'failed' ? input.at + 1_000 : null,
    input.runtimeStatus === 'failed'
      ? JSON.stringify({ stage: 'offline-demo', code: 'RECOVERABLE_CONFIGURATION' })
      : null,
  );
}

function seedDemoData(db: Database.Database): void {
  const now = Date.now();
  const t = (minutesAgo: number) => now - minutesAgo * 60_000;
  const controlSession = 'demo-bot-control-session';
  const assistantSession = 'demo-bot-assistant-session';
  const stewardSession = 'demo-bot-pr-steward-session';
  const historySession = 'demo-bot-control-history';

  const tx = db.transaction(() => {
    insertSession(db, { id: controlSession, title: '总控 · 离线演示', at: t(2) });
    insertSession(db, { id: assistantSession, title: '普通助理 · 已暂停', at: t(8) });
    insertSession(db, { id: stewardSession, title: 'PR 总管 · 可恢复异常', at: t(5) });
    insertSession(db, {
      id: historySession,
      title: '总控 · 昨日归档',
      status: 'archived',
      at: t(1_440),
    });
    insertSession(db, { id: 'demo-task-completed', title: '发布准备 · 已完成', source: 'desktop', at: t(35) });
    insertSession(db, { id: 'demo-task-failed', title: 'Telegram 接线 · 出错', source: 'desktop', at: t(22) });
    insertSession(db, { id: 'demo-task-decision', title: '模型策略 · 待总控', source: 'desktop', at: t(12) });

    insertBot(db, {
      id: 'demo-control-bot',
      templateId: 'control',
      name: '总控 Bot',
      description: '自动接收任务状态变化，并在异常或待决策时主动跟进。',
      status: 'active',
      sessionId: controlSession,
      at: t(3),
      runtimeStatus: 'applied',
    });
    insertBot(db, {
      id: 'demo-pr-steward-bot',
      templateId: 'pr-steward',
      name: 'PR 总管',
      description: '展示可恢复错误、投递诊断与长期交付职责。',
      status: 'error',
      sessionId: stewardSession,
      at: t(6),
      runtimeStatus: 'failed',
    });
    insertBot(db, {
      id: 'demo-assistant-bot',
      templateId: 'assistant',
      name: '普通助理',
      description: '一个已暂停的本地 Bot，用于检查目录与状态展示。',
      status: 'paused',
      sessionId: assistantSession,
      at: t(9),
      runtimeStatus: 'prepared',
    });

    db.prepare(
      `INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, channel_id, created_at, archived_at)
       VALUES ('demo-control-history-link', 'demo-control-bot', ?, 1, 'history',
               'demo-control-bot:local', ?, ?)`,
    ).run(historySession, t(1_440), t(1_400));
    db.prepare(
      `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
       VALUES
        ('demo-history-user', 'demo-history-user', ?, 'user', ?, ?),
        ('demo-history-assistant', 'demo-history-assistant', ?, 'assistant', ?, ?)`,
    ).run(
      historySession,
      JSON.stringify('检查昨天所有任务是否都已收口。'),
      t(1_430),
      historySession,
      JSON.stringify('已完成离线复盘：两个任务完成，一个任务已进入待决策。'),
      t(1_425),
    );

    const subscriptionId = 'bot-control-events:demo-control-bot';
    db.prepare(
      `INSERT INTO bot_event_subscriptions
        (id, bot_id, name, status, rule_json, created_at, updated_at)
       VALUES (?, 'demo-control-bot', '任务状态监护', 'active', ?, ?, ?)`,
    ).run(
      subscriptionId,
      JSON.stringify({
        sessionRelations: ['all-local'],
        executionStates: ['normal-ended', 'error-ended'],
        workflowStates: ['awaiting-controller'],
        excludeOwnBotSessions: true,
        // Keep the offline fixture visually rich without dispatching a real
        // agent turn when the app initializes the inbox service.
        activationMode: 'inbox-only',
        resultDelivery: 'all-active-routes',
      }),
      t(40),
      t(40),
    );

    const events = [
      {
        id: 'demo-event-completed', sessionId: 'demo-task-completed', status: 'handled', attempts: 1,
        receivedAt: t(34), handledAt: t(33), resultText: '发布准备已完成，所有检查均通过。', lastError: null,
        payload: {
          sessionId: 'demo-task-completed', transitionId: 'demo-transition-completed',
          eventType: 'session.state.transition', title: '发布准备 · 已完成', status: 'normal-ended',
          source: 'desktop', workingDir: '', occurredAt: t(35), outcome: 'completed',
          previousState: { lifecycle: 'active', execution: 'running', attention: null, workflow: null },
          currentState: { lifecycle: 'active', execution: 'normal-ended', attention: null, workflow: null },
          changedFacets: ['execution'],
        },
      },
      {
        id: 'demo-event-failed', sessionId: 'demo-task-failed', status: 'failed', attempts: 2,
        receivedAt: t(21), handledAt: null, resultText: null, lastError: '演示：处理 Bot 暂时不可用，可手动重试。',
        payload: {
          sessionId: 'demo-task-failed', transitionId: 'demo-transition-failed',
          eventType: 'session.state.transition', title: 'Telegram 接线 · 出错', status: 'error-ended',
          source: 'desktop', workingDir: '', occurredAt: t(22), outcome: 'failed',
          previousState: { lifecycle: 'active', execution: 'running', attention: null, workflow: null },
          currentState: { lifecycle: 'active', execution: 'error-ended', attention: 'error', workflow: null },
          changedFacets: ['execution', 'attention'],
        },
      },
      {
        id: 'demo-event-decision', sessionId: 'demo-task-decision', status: 'pending', attempts: 0,
        receivedAt: t(11), handledAt: null, resultText: null, lastError: null,
        payload: {
          sessionId: 'demo-task-decision', transitionId: 'demo-transition-decision',
          eventType: 'session.state.guardian-anomaly', title: '模型策略 · 待总控', status: 'waiting',
          source: 'desktop', workingDir: '', occurredAt: t(12),
          previousState: { lifecycle: 'active', execution: 'running', attention: null, workflow: null },
          currentState: { lifecycle: 'active', execution: 'waiting', attention: 'decision', workflow: { key: 'awaiting-controller', label: '待总控' } },
          changedFacets: ['execution', 'attention', 'workflow'],
          guardianAnomaly: {
            kind: 'unclaimed-decision', relation: 'all-local', detectedAt: t(11),
            supervisedAt: t(12), thresholdMs: 900000, fingerprint: 'demo-unclaimed-decision',
          },
        },
      },
    ];
    const insertLedger = db.prepare(
      `INSERT INTO bot_session_event_ledger
        (id, event_key, session_id, event_type, payload_json, lineage_json, hop_count, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', 0, ?)`,
    );
    const insertInbox = db.prepare(
      `INSERT INTO bot_inbox_items
        (id, bot_id, subscription_id, event_id, status, attempts, last_error, result_text,
         result_delivery_status, received_at, started_at, handled_at, updated_at)
       VALUES (?, 'demo-control-bot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      insertLedger.run(
        event.id,
        `offline-demo:${event.id}`,
        event.sessionId,
        event.payload.eventType,
        JSON.stringify(event.payload),
        event.payload.occurredAt,
      );
      insertInbox.run(
        `inbox:${event.id}`,
        subscriptionId,
        event.id,
        event.status,
        event.attempts,
        event.lastError,
        event.resultText,
        event.status === 'handled' ? 'queued' : 'none',
        event.receivedAt,
        event.status === 'handled' || event.status === 'failed' ? event.receivedAt + 1_000 : null,
        event.handledAt,
        event.handledAt ?? event.receivedAt,
      );
    }

    const insertDelivery = db.prepare(
      `INSERT INTO bot_delivery_outbox
        (id, bot_id, channel_id, session_id, idempotency_key, payload_ref_json,
         owner_generation, status, attempts, next_attempt_at, last_error,
         delivery_receipt_json, created_at, updated_at, delivered_at)
       VALUES (?, 'demo-control-bot', 'demo-control-bot:local', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDelivery.run(
      'demo-delivery-success', controlSession, 'offline-demo:delivery:success',
      JSON.stringify({ version: 1, kind: 'channel-final-recovery', text: '状态汇报已送达。' }),
      'delivered', 1, null, null,
      JSON.stringify({ progress: { textMessageId: 'demo-local-message', committedFinal: true } }),
      t(31), t(30), t(30),
    );
    insertDelivery.run(
      'demo-delivery-dead-letter', controlSession, 'offline-demo:delivery:dead-letter',
      JSON.stringify({ version: 1, kind: 'channel-final-recovery', text: '演示失败投递。' }),
      'dead-letter', 8, null, 'DEMO_TERMINAL: 已达到重试上限',
      JSON.stringify({ externalDispatch: { retrySafe: true, transport: 'offline-demo', startedAt: t(26) } }),
      t(27), t(25), null,
    );
    insertDelivery.run(
      'demo-delivery-recoverable', controlSession, 'offline-demo:delivery:recoverable',
      JSON.stringify({ version: 1, kind: 'channel-final-recovery', text: '演示可恢复投递。' }),
      'failed', 2, now + 24 * 60 * 60 * 1_000, 'DEMO_RETRYABLE: 等待下一次重试',
      JSON.stringify({ externalDispatch: { retrySafe: true, transport: 'offline-demo', startedAt: t(16) } }),
      t(17), t(15), null,
    );

    db.prepare(
      `INSERT INTO bot_lifecycle_events (id, bot_id, session_id, event_type, payload_json, created_at)
       VALUES
        ('demo-lifecycle-created', 'demo-control-bot', ?, 'profile.created', ?, ?),
        ('demo-lifecycle-history', 'demo-control-bot', ?, 'session.archived', ?, ?)`,
    ).run(
      controlSession,
      JSON.stringify({ templateId: 'control', offlineDemo: true }),
      t(40),
      historySession,
      JSON.stringify({ reason: 'scheduled-renew', offlineDemo: true }),
      t(1_400),
    );
  });
  tx();
}

function validateSeed(db: Database.Database): Record<string, number | string> {
  const count = (table: string) =>
    Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  const botCount = count('bot_profiles');
  const deliveryStates = db
    .prepare(`SELECT GROUP_CONCAT(DISTINCT status) FROM bot_delivery_outbox`)
    .pluck()
    .get() as string;
  const inboxStates = db
    .prepare(`SELECT GROUP_CONCAT(DISTINCT status) FROM bot_inbox_items`)
    .pluck()
    .get() as string;
  if (botCount < 3) throw new Error('Offline demo seed did not create three Bots');
  for (const required of ['delivered', 'dead-letter', 'failed']) {
    if (!deliveryStates.split(',').includes(required)) {
      throw new Error(`Offline demo is missing delivery status: ${required}`);
    }
  }
  for (const required of ['handled', 'failed', 'pending']) {
    if (!inboxStates.split(',').includes(required)) {
      throw new Error(`Offline demo is missing inbox status: ${required}`);
    }
  }
  const templateIdentity = db
    .prepare(`SELECT identity_source FROM bot_profile_versions WHERE bot_id='demo-control-bot'`)
    .pluck()
    .get();
  if (templateIdentity !== getBotTemplate('control').identitySource) {
    throw new Error('Control Bot no longer matches the product template');
  }
  return {
    bots: botCount,
    sessions: count('sessions'),
    deliveries: count('bot_delivery_outbox'),
    inboxItems: count('bot_inbox_items'),
    templateCount: BOT_TEMPLATES.length,
    deliveryStates,
    inboxStates,
  };
}

function buildSandbox(stagingDir: string): { dbPath: string; summary: Record<string, number | string> } {
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stagingDir, OWNERSHIP_MARKER),
    `${JSON.stringify({ sandboxName: SANDBOX_NAME, formatVersion: 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(stagingDir, 'keychain-identity'), KEYCHAIN_IDENTITY, { mode: 0o600 });
  fs.writeFileSync(
    path.join(stagingDir, 'app-session.json'),
    `${JSON.stringify({ activeMode: 'local' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const dbPath = path.join(stagingDir, `${BRAND_IDENTITY.dbFilePrefix}-${OWNER_ID}.db`);
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.loadExtension(sqliteVecPath());
    const drizzleDir = path.resolve('apps/desktop/drizzle');
    const replay = runMigrationReplay(db, {
      drizzleDir,
      scriptLoader: (scriptPath) => require(scriptPath),
    });
    prepareMigrationRuntimeManifest(dbPath, drizzleDir, replay.finalVersion);
    seedDemoData(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const summary = validateSeed(db);
    fs.chmodSync(dbPath, 0o600);
    return { dbPath, summary };
  } finally {
    db.close();
  }
}

export function seedOfflineBotsDemo(options: CliOptions) {
  assertSafeOutput(options.output);
  const parent = path.dirname(options.output);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(options.output) && !options.replace) {
    throw new Error(`Target already exists; rerun with --replace: ${options.output}`);
  }
  if (fs.existsSync(options.output)) assertOwnedReplacementTarget(options.output);
  const stagingDir = path.join(
    parent,
    `.${path.basename(options.output)}.seed-${process.pid}-${Date.now()}`,
  );
  const backupDir = `${options.output}.replaced-${process.pid}`;
  try {
    const built = buildSandbox(stagingDir);
    if (fs.existsSync(options.output)) fs.renameSync(options.output, backupDir);
    try {
      fs.renameSync(stagingDir, options.output);
    } catch (error) {
      if (fs.existsSync(backupDir)) fs.renameSync(backupDir, options.output);
      throw error;
    }
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    return {
      sandboxName: SANDBOX_NAME,
      output: options.output,
      dbPath: path.join(options.output, path.basename(built.dbPath)),
      ...built.summary,
    };
  } finally {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const result = seedOfflineBotsDemo(options);
if (options.json) console.log(JSON.stringify(result));
else {
  console.log(`Cindy Bots offline demo sandbox is ready: ${result.output}`);
  console.log(`Bots=${result.bots} inbox=${result.inboxItems} deliveries=${result.deliveries}`);
  console.log(`Open later with: pnpm restart:desktop:remote -- --isolated=${SANDBOX_NAME} --region=global`);
}
