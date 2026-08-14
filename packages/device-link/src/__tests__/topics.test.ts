/**
 * topics 单测:push channel + payload → topic 路由(client-agnostic 契约)。
 * 守住「列表级归 sessions、单会话流归 session:<id>、取不到标识返 null」三条规则,
 * 以及 orca 用 leadSessionId(不同 key)的特例。被控端 fan-out 与 mobile/web 订阅
 * 都依赖这份映射,回归必须显式。
 */
import { describe, it, expect } from 'vitest';
import {
  MAKER_EVENT_BATCH_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  expandMakerEventBatchPayload,
  fsWatchTopic,
  parseFsWatchTopic,
  topicForPush,
} from '../topics.js';

describe('topicForPush', () => {
  it('会话列表级 channel → sessions', () => {
    expect(topicForPush('local-db:sessions:created', { sessionId: 's1' })).toBe('sessions');
    expect(
      topicForPush('local-db:sessions:patched', { sessionId: 's1', patch: { title: 'x' } }),
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
    expect(topicForPush('local-db:session:error-persisted', { sessionId: 's2' })).toBe('sessions');
  });

  it('账号 / 全局级 channel → sessions(随列表订阅走)', () => {
    expect(topicForPush('maker:provider:changed', { revision: 42 })).toBe('sessions');
    expect(topicForPush('maker:schedule:event', { kind: 'x' })).toBe('sessions');
    expect(topicForPush('maker:project-automation:event', {})).toBe('sessions');
    // 被控端当前草稿全量变更(无 sessionId)→ 并入 sessions topic。
    expect(topicForPush('maker:new-maker-draft:changed', { claudeCode: {}, codex: {} })).toBe(
      'sessions',
    );
    expect(topicForPush('maker:new-maker-worktree-branch:changed', {
      baseRepo: '/tmp/repo',
      sourceBranch: 'feature/mobile',
      revision: 2,
    })).toBe('sessions');
  });

  it('learn:event → sessions(账号级:run 关联触发/蒸馏两个任务,单 sessionId 路由会漏)', () => {
    expect(
      topicForPush('learn:event', { type: 'state-changed', run: { runId: 'r1', status: 'distilling' } }),
    ).toBe('sessions');
  });

  it('goal:status-changed → session:<sessionId>(带 sessionId,走默认路由)', () => {
    expect(
      topicForPush('maker:goal:status-changed', { sessionId: 's9', goal: null }),
    ).toBe('session:s9');
  });

  it('会话非选中模型 pref 变更 → session:<sessionId>(带 sessionId,走默认路由)', () => {
    expect(
      topicForPush('maker:session-model-pref:changed', {
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
    expect(topicForPush('maker:auth:state-changed', { state: {} })).toBeNull();
  });

  it('单会话重事件 → session:<sessionId>', () => {
    expect(topicForPush('maker:event', { sessionId: 's1', event: {} })).toBe('session:s1');
    expect(topicForPush('maker:status-changed', { sessionId: 's2', status: 'idle' })).toBe(
      'session:s2',
    );
    expect(topicForPush('maker:input:projection', { sessionId: 's3', pendingQueue: [] })).toBe(
      'session:s3',
    );
    expect(topicForPush('maker:interaction-request', { sessionId: 's4' })).toBe('session:s4');
    expect(topicForPush('maker:interaction-dismissed', { sessionId: 's5' })).toBe('session:s5');
    expect(topicForPush('maker:auto-permission:fallback', { sessionId: 's5' })).toBe('session:s5');
    expect(topicForPush('local-db:messages:created', { sessionId: 's6', message: {} })).toBe(
      'session:s6',
    );
    expect(topicForPush('usage:message-turn-cost', { sessionId: 's7', clientId: 'm1' })).toBe(
      'session:s7',
    );
  });

  it('session 累计 cost / token 镜像 → sessions(列表订阅常开,会话未打开也不丢更新)', () => {
    // 若走 session:<id>,未打开的会话无人订阅 → 镜像停在旧值,下次打开 chip 先显示过期累计。
    expect(topicForPush('usage:session-spend-changed', { sessionId: 's8', totalCostUsd: 1.23 })).toBe(
      'sessions',
    );
    expect(topicForPush('usage:session-tokens-changed', { sessionId: 's8', totalTokens: 42 })).toBe(
      'sessions',
    );
  });

  it('orca:worker-changed 用 leadSessionId(不同 key)', () => {
    expect(topicForPush('maker:orca:worker-changed', { leadSessionId: 'lead-1' })).toBe(
      'session:lead-1',
    );
    // 缺 leadSessionId → null(不能错当 sessionId)
    expect(topicForPush('maker:orca:worker-changed', { sessionId: 'x' })).toBeNull();
  });

  it('file-browser 事件按 payload.workdir 路由到 fs-watch:<workdir>', () => {
    expect(
      topicForPush('maker:file-browser:event', { workdir: '/home/u/proj', type: 'add', relPath: 'a.ts' }),
    ).toBe('fs-watch:/home/u/proj');
    // 缺 workdir → null(丢弃,不误入 session 档)
    expect(topicForPush('maker:file-browser:event', { type: 'add' })).toBeNull();
  });

  it('fsWatchTopic / parseFsWatchTopic 互逆', () => {
    expect(fsWatchTopic('/w')).toBe('fs-watch:/w');
    expect(parseFsWatchTopic('fs-watch:/w')).toBe('/w');
    expect(parseFsWatchTopic('session:x')).toBeNull();
    expect(parseFsWatchTopic('fs-watch:')).toBeNull();
  });

  it('取不到 session 标识 → null(调用方丢弃,不转发)', () => {
    expect(topicForPush('maker:event', {})).toBeNull();
    expect(topicForPush('maker:event', null)).toBeNull();
    expect(topicForPush('maker:event', { sessionId: 123 })).toBeNull();
    expect(topicForPush('maker:event', undefined)).toBeNull();
  });
});

describe('expandMakerEventBatchPayload', () => {
  // 两个控制端(mobile store / desktop main)共用这一份拆包与 fail-closed 判据,
  // 所以它的契约在这里定,不在任何一端的实现里。
  it('原样返回批内事件,顺序即批内顺序', () => {
    const events = [{ sessionId: 's1', event: { i: 0 } }, { sessionId: 's1', event: { i: 1 } }];
    expect(expandMakerEventBatchPayload({ sessionId: 's1', events })).toEqual(events);
  });

  it('sessionId 与顶层不一致的条目跳过(topic 隔离不被绕过),其余照常消费', () => {
    // 坏帧 / 恶意帧:批内混入未订阅会话的事件,会绕过按顶层 sessionId 的 topic 路由。
    const ok = { sessionId: 's1', event: { keep: true } };
    expect(expandMakerEventBatchPayload({
      sessionId: 's1',
      events: [ok, { sessionId: 's2', event: { leak: true } }, { event: { noSession: true } }],
    })).toEqual([ok]);
  });

  it('形状不符 / 空批 → 空数组(不抛、不当批处理)', () => {
    expect(expandMakerEventBatchPayload(null)).toEqual([]);
    expect(expandMakerEventBatchPayload({ sessionId: 's1', events: [] })).toEqual([]);
    expect(expandMakerEventBatchPayload({ sessionId: '', events: [{ sessionId: '' }] })).toEqual([]);
    expect(expandMakerEventBatchPayload({ events: [{}] })).toEqual([]);
    expect(expandMakerEventBatchPayload({ sessionId: 's1', events: 'nope' })).toEqual([]);
  });

  it('批 channel 常量与 topic 路由一致(顶层 sessionId → session:<id>)', () => {
    expect(topicForPush(MAKER_EVENT_BATCH_CHANNEL, { sessionId: 's7', events: [{}] }))
      .toBe('session:s7');
  });
});
