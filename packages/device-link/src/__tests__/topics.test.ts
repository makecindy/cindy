/**
 * topics 单测:push channel + payload → topic 路由(client-agnostic 契约)。
 * 守住「列表级归 sessions、单会话流归 session:<id>、取不到标识返 null」三条规则,
 * 以及 orca 用 leadSessionId(不同 key)的特例。被控端 fan-out 与 mobile/web 订阅
 * 都依赖这份映射,回归必须显式。
 */
import { describe, it, expect } from 'vitest';
import { SESSION_ACTIVITY_CHANNEL, fsWatchTopic, parseFsWatchTopic, topicForPush } from '../topics.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

describe('topicForPush', () => {
  it('会话列表级 channel → sessions', () => {
    expect(topicForPush(IPC_CHANNELS.LOCAL_DB.SESSIONS_CREATED, { sessionId: 's1' })).toBe('sessions');
    expect(
      topicForPush(IPC_CHANNELS.LOCAL_DB.SESSIONS_PATCHED, { sessionId: 's1', patch: { title: 'x' } }),
    ).toBe('sessions');
    expect(
      topicForPush(SESSION_ACTIVITY_CHANNEL, {
        sessionId: 's1',
        phase: 'running',
        compactDetail: 'Editing README',
      }),
    ).toBe('sessions');
    // error-persisted 归 sessions topic:控制端未打开该会话时已取消 session:<id> 订阅,
    // 只有 sessions topic 能保证控制端侧边栏在线时必达。
    expect(topicForPush(IPC_CHANNELS.LOCAL_DB.SESSION_ERROR_PERSISTED, { sessionId: 's2' })).toBe('sessions');
  });

  it('账号 / 全局级 channel → sessions(随列表订阅走)', () => {
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.PROVIDER_CHANGED, { revision: 42 })).toBe('sessions');
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.SCHEDULE_EVENT, { kind: 'x' })).toBe('sessions');
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.PROJECT_AUTOMATION_EVENT, {})).toBe('sessions');
    // 被控端当前草稿全量变更(无 sessionId)→ 并入 sessions topic。
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.NEW_MAKER_DRAFT_CHANGED, { claudeCode: {}, codex: {} })).toBe(
      'sessions',
    );
  });

  it('learn:event → sessions(账号级:run 关联触发/蒸馏两个任务,单 sessionId 路由会漏)', () => {
    expect(
      topicForPush(IPC_CHANNELS.LEARN.EVENT, { type: 'state-changed', run: { runId: 'r1', status: 'distilling' } }),
    ).toBe('sessions');
  });

  it('goal:status-changed → session:<sessionId>(带 sessionId,走默认路由)', () => {
    expect(
      topicForPush(IPC_CHANNELS.MAKER_PUSH.GOAL_STATUS_CHANGED, { sessionId: 's9', goal: null }),
    ).toBe('session:s9');
  });

  it('会话非选中模型 pref 变更 → session:<sessionId>(带 sessionId,走默认路由)', () => {
    expect(
      topicForPush(IPC_CHANNELS.MAKER_PUSH.SESSION_MODEL_PREF_CHANGED, {
        sessionId: 's7',
        agent: 'claude-code',
        providerId: 'anthropic',
        model: 'claude-opus-4-8',
        effort: 'high',
      }),
    ).toBe('session:s7');
  });

  it('maker:auth:state-changed 不路由(已从转发面移除:发射点不 tap、控制端不消费)', () => {
    // 与 allowlist.ts 的 PUSH_FORWARD_ALLOWLIST 删除该死条目保持一致。
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.AUTH_STATE_CHANGED, { state: {} })).toBeNull();
  });

  it('单会话重事件 → session:<sessionId>', () => {
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.EVENT, { sessionId: 's1', event: {} })).toBe('session:s1');
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.STATUS_CHANGED, { sessionId: 's2', status: 'idle' })).toBe(
      'session:s2',
    );
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.INPUT_PROJECTION, { sessionId: 's3', pendingQueue: [] })).toBe(
      'session:s3',
    );
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.INTERACTION_REQUEST, { sessionId: 's4' })).toBe('session:s4');
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.INTERACTION_DISMISSED, { sessionId: 's5' })).toBe('session:s5');
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.AUTO_PERMISSION_FALLBACK, { sessionId: 's5' })).toBe('session:s5');
    expect(topicForPush(IPC_CHANNELS.LOCAL_DB.MESSAGES_CREATED, { sessionId: 's6', message: {} })).toBe(
      'session:s6',
    );
    expect(topicForPush(IPC_CHANNELS.USAGE.MESSAGE_TURN_COST, { sessionId: 's7', clientId: 'm1' })).toBe(
      'session:s7',
    );
  });

  it('session 累计 cost / token 镜像 → sessions(列表订阅常开,会话未打开也不丢更新)', () => {
    // 若走 session:<id>,未打开的会话无人订阅 → 镜像停在旧值,下次打开 chip 先显示过期累计。
    expect(topicForPush(IPC_CHANNELS.USAGE.SESSION_SPEND_CHANGED, { sessionId: 's8', totalCostUsd: 1.23 })).toBe(
      'sessions',
    );
    expect(topicForPush(IPC_CHANNELS.USAGE.SESSION_TOKENS_CHANGED, { sessionId: 's8', totalTokens: 42 })).toBe(
      'sessions',
    );
  });

  it('orca:worker-changed 用 leadSessionId(不同 key)', () => {
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId: 'lead-1' })).toBe(
      'session:lead-1',
    );
    // 缺 leadSessionId → null(不能错当 sessionId)
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.ORCA_WORKER_CHANGED, { sessionId: 'x' })).toBeNull();
  });

  it('file-browser 事件按 payload.workdir 路由到 fs-watch:<workdir>', () => {
    expect(
      topicForPush(IPC_CHANNELS.MAKER_EXTRA.FILE_BROWSER_EVENT, { workdir: '/home/u/proj', type: 'add', relPath: 'a.ts' }),
    ).toBe('fs-watch:/home/u/proj');
    // 缺 workdir → null(丢弃,不误入 session 档)
    expect(topicForPush(IPC_CHANNELS.MAKER_EXTRA.FILE_BROWSER_EVENT, { type: 'add' })).toBeNull();
  });

  it('fsWatchTopic / parseFsWatchTopic 互逆', () => {
    expect(fsWatchTopic('/w')).toBe('fs-watch:/w');
    expect(parseFsWatchTopic('fs-watch:/w')).toBe('/w');
    expect(parseFsWatchTopic('session:x')).toBeNull();
    expect(parseFsWatchTopic('fs-watch:')).toBeNull();
  });

  it('取不到 session 标识 → null(调用方丢弃,不转发)', () => {
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.EVENT, {})).toBeNull();
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.EVENT, null)).toBeNull();
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.EVENT, { sessionId: 123 })).toBeNull();
    expect(topicForPush(IPC_CHANNELS.MAKER_PUSH.EVENT, undefined)).toBeNull();
  });
});
