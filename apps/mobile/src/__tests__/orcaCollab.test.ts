import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildOrcaDispatchCard,
  classifyOrcaDispatchTool,
  parseOrcaWorkerReport,
} from '@/session/orcaCollab';
import { excludeOrcaWorkerSessions } from '@/session/mobileHome';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import type { RemoteMessage, RemoteSession } from '@/session/types';

// orcaCollab 卡片文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦
// (全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function message(patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function session(patch: Partial<RemoteSession> & Pick<RemoteSession, 'id' | 'orcaRole'>): RemoteSession {
  return {
    userId: 'u1',
    title: patch.id,
    workingDir: null,
    workspaceKind: 'dialogue',
    model: 'claude',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('orcaCollab dispatch tool classification', () => {
  it('recognizes create_worker / create_workers / send_to_worker as bare and MCP-prefixed names', () => {
    expect(classifyOrcaDispatchTool('create_worker')).toBe('create');
    expect(classifyOrcaDispatchTool('mcp__cindy_orca__create_worker')).toBe('create');
    expect(classifyOrcaDispatchTool('mcp__lizi_orca__create_worker')).toBe('create');
    expect(classifyOrcaDispatchTool('create_workers')).toBe('create-batch');
    expect(classifyOrcaDispatchTool('mcp__cindy_orca__create_workers')).toBe('create-batch');
    expect(classifyOrcaDispatchTool('mcp__lizi_orca__create_workers')).toBe('create-batch');
    expect(classifyOrcaDispatchTool('send_to_worker')).toBe('send');
    expect(classifyOrcaDispatchTool('mcp__cindy_orca__send_to_worker')).toBe('send');
    expect(classifyOrcaDispatchTool('mcp__lizi_orca__send_to_worker')).toBe('send');
    expect(classifyOrcaDispatchTool('Read')).toBeNull();
    // 不误匹配前缀粘连的无关 tool 名。
    expect(classifyOrcaDispatchTool('xcreate_worker')).toBeNull();
  });
});

describe('buildOrcaDispatchCard', () => {
  it('summarizes create_worker with label + initial_task', () => {
    const card = buildOrcaDispatchCard('mcp__cindy_orca__create_worker', {
      role: 'developer',
      agent: 'codex',
      label: 'frontend',
      initial_task: '实现登录页',
    });
    expect(card).toEqual({ variant: 'dispatch', title: '派活给 Worker frontend', body: '实现登录页' });
  });

  it('falls back to role/agent meta when create_worker has no initial_task', () => {
    const card = buildOrcaDispatchCard('create_worker', { role: 'reviewer', agent: 'claude-code' });
    expect(card).toEqual({ variant: 'dispatch', title: '派活给 Worker reviewer', body: '角色 reviewer · claude-code' });
  });

  it('summarizes create_workers with the batch size and each worker task', () => {
    const card = buildOrcaDispatchCard('mcp__cindy_orca__create_workers', {
      workers: [
        { role: 'developer', agent: 'codex', label: 'frontend', initial_task: '实现登录页' },
        { role: 'reviewer', agent: 'claude-code', label: 'review', initial_task: '检查交互' },
      ],
    });
    expect(card).toEqual({
      variant: 'dispatch',
      title: '批量派活给 2 个 Worker',
      body: 'frontend：实现登录页\nreview：检查交互',
    });
  });

  it('summarizes send_to_worker with the message body', () => {
    const card = buildOrcaDispatchCard('mcp__cindy_orca__send_to_worker', {
      target_session_id: 'sess-123',
      message: '继续下一步',
    });
    expect(card).toEqual({ variant: 'dispatch', title: '发消息给 Worker', body: '继续下一步' });
  });

  it('returns null for non-dispatch tools', () => {
    expect(buildOrcaDispatchCard('Bash', { command: 'ls' })).toBeNull();
  });
});

describe('parseOrcaWorkerReport', () => {
  it('parses the DB JSON report shape (string content)', () => {
    expect(parseOrcaWorkerReport('{"orcaSource":"worker","content":"任务完成"}'))
      .toEqual({ variant: 'report', title: 'Worker 回报', body: '任务完成' });
  });

  it('parses an already-object report', () => {
    expect(parseOrcaWorkerReport({ orcaSource: 'worker', content: '已修复' }))
      .toEqual({ variant: 'report', title: 'Worker 回报', body: '已修复' });
  });

  it('returns null for normal user content / malformed JSON (fallback to plain text)', () => {
    expect(parseOrcaWorkerReport('{"text":"hello"}')).toBeNull();
    expect(parseOrcaWorkerReport('just a plain message')).toBeNull();
    expect(parseOrcaWorkerReport('{not json')).toBeNull();
    expect(parseOrcaWorkerReport({ text: 'hi', images: [] })).toBeNull();
  });
});

describe('normalizeRemoteMessages with orca collaboration', () => {
  it('renders dispatch tool_use as a standalone system card and worker report as a report card', () => {
    const items = normalizeRemoteMessages([
      message({
        id: 'dispatch',
        role: 'tool_use',
        content: { toolName: 'mcp__cindy_orca__create_worker', input: { label: 'api', role: 'dev', agent: 'codex', initial_task: '建接口' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      message({
        id: 'report',
        role: 'user',
        content: '{"orcaSource":"worker","content":"接口完成"}',
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
    ]);

    const dispatch = items.find((item) => item.source.id === 'dispatch');
    expect(dispatch?.kind).toBe('system');
    expect(dispatch?.orcaCard).toEqual({ variant: 'dispatch', title: '派活给 Worker api', body: '建接口' });

    const report = items.find((item) => item.source.id === 'report');
    expect(report?.kind).toBe('user');
    expect(report?.body).toBe('接口完成');
    expect(report?.orcaCard).toEqual({ variant: 'report', title: 'Worker 回报', body: '接口完成' });
  });

  it('renders create_workers tool_use as an Orca dispatch card', () => {
    const [item] = normalizeRemoteMessages([
      message({
        id: 'batch-dispatch',
        role: 'tool_use',
        content: {
          toolName: 'mcp__cindy_orca__create_workers',
          input: {
            workers: [
              { label: 'api', role: 'developer', agent: 'codex', initial_task: '实现接口' },
              { label: 'test', role: 'tester', agent: 'claude-code', initial_task: '补充测试' },
            ],
          },
        },
      }),
    ]);

    expect(item?.kind).toBe('system');
    expect(item?.orcaCard).toEqual({
      variant: 'dispatch',
      title: '批量派活给 2 个 Worker',
      body: 'api：实现接口\ntest：补充测试',
    });
  });

  it('leaves normal user messages and normal tools untouched (no orcaCard, no raw JSON leak)', () => {
    const items = normalizeRemoteMessages([
      message({ id: 'u', role: 'user', content: { text: 'hi there' } }),
      message({
        id: 't',
        role: 'tool_use',
        content: { toolName: 'Read', input: { file_path: '/a.ts' } },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);
    const user = items.find((item) => item.source.id === 'u');
    expect(user?.body).toBe('hi there');
    expect(user?.orcaCard).toBeUndefined();
    const tool = items.find((item) => item.source.id === 't');
    expect(tool?.kind).toBe('tool');
    expect(tool?.orcaCard).toBeUndefined();
  });
});

describe('excludeOrcaWorkerSessions', () => {
  it('hides worker sub-sessions but keeps lead and normal sessions', () => {
    const kept = excludeOrcaWorkerSessions([
      session({ id: 'lead', orcaRole: 'lead' }),
      session({ id: 'worker', orcaRole: 'worker' }),
      session({ id: 'normal', orcaRole: null }),
    ]);
    expect(kept.map((item) => item.id)).toEqual(['lead', 'normal']);
  });
});

describe('MessageRenderer wires the orca card', () => {
  it('routes message items carrying an orcaCard to OrcaCollabCard', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain('item.message.orcaCard');
    // F4:透传 screenWidth,使 CollabCardShell layout 随屏宽响应(与 SubagentCard 一致)。
    expect(source).toContain('<OrcaCollabCard card={item.message.orcaCard} screenWidth={actions.screenWidth} />');
    expect(source).toContain('function OrcaCollabCard({ card, screenWidth }: { card: OrcaCollabCardModel; screenWidth?: number })');
    expect(source).toContain('testID={`message.orcaCard.${card.variant}`}');
  });
});
