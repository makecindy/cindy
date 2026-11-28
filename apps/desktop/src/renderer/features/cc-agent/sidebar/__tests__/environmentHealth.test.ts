/**
 * 测试价值
 * - 生产入口与可观察结果：调用 buildEnvironmentHealthAlerts / filterDismissedEnvironmentHealthAlerts，验证收件箱环境健康告警的聚合、排序、降噪过滤与指纹忽略恢复逻辑。
 * - Bug／规则依据：桌面收件箱环境健康收敛（健康态零占位、不因瞬时网络抖动或限流打扰、致命鉴权错误优先、修复/指纹变化自动重新浮现）。
 * - 现有覆盖缺口：TaskInbox.test.tsx 仅测任务分桶，未覆盖环境级健康信号聚合与降噪边界。
 * - 最小失败输入：全健康输入、仅含瞬时 network/rate-limit 失败输入、以及同时存在供应商过期 + gh 未登录 + 自动化缺插件的复合输入。
 * - tier：unit（纯函数 node 环境）。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIONS_PAGE_PATH,
  GITLAB_PLUGIN_SETTINGS_PATH,
  PROVIDERS_SETTINGS_PATH,
  buildEnvironmentHealthAlerts,
  filterDismissedEnvironmentHealthAlerts,
} from '../environmentHealth';
import { AUXILIARY_MODEL_SETTINGS_PATH } from '../../../../../shared/auxiliaryModelHealth';

describe('buildEnvironmentHealthAlerts', () => {
  it('returns empty alerts when healthy and ignores transient or recovered failures', () => {
    const alerts = buildEnvironmentHealthAlerts({
      providers: [
        {
          id: 'anthropic',
          name: 'Claude',
          connected: true,
          modelDiscoveryFailure: { kind: 'network' },
        },
        {
          id: 'openai',
          name: 'OpenAI',
          connected: true,
          suspended: true,
          openAiAccount: { reconnectRequired: true },
        },
      ],
      prAuth: {},
      auxiliaryHealth: { status: 'ok' },
      auxiliaryRoutes: [
        { status: 'isolated', switchedToBackup: true, model: 'gpt-5-mini' },
        { status: 'recovered', switchedToBackup: false, model: 'claude-haiku' },
      ],
      scheduleRuns: [
        {
          runId: 'r-rate',
          scheduleId: 's-1',
          scheduleName: 'PR Patrol',
          scheduleStatus: 'active',
          status: 'failed',
          failureKind: 'rate-limit',
          firedAt: 200,
        },
        {
          runId: 'r-old-fail',
          scheduleId: 's-2',
          scheduleName: 'Daily Digest',
          scheduleStatus: 'active',
          status: 'failed',
          failureKind: 'execution',
          firedAt: 100,
        },
        {
          runId: 'r-later-ok',
          scheduleId: 's-2',
          scheduleName: 'Daily Digest',
          scheduleStatus: 'active',
          status: 'success',
          firedAt: 300,
        },
        {
          runId: 'r-paused',
          scheduleId: 's-3',
          scheduleName: 'Paused Job',
          scheduleStatus: 'paused',
          status: 'failed',
          failureKind: 'execution',
          firedAt: 400,
        },
      ],
    });

    expect(alerts).toEqual([]);
  });

  it('prioritizes provider auth errors ahead of warnings and maps one-click actions', () => {
    const alerts = buildEnvironmentHealthAlerts({
      providers: [
        {
          id: 'openai',
          name: 'Codex',
          connected: true,
          openAiAccount: { reconnectRequired: true },
        },
      ],
      prAuth: {
        github: { reason: 'gh-not-logged-in', affectedPrCount: 3 },
        gitlab: { reason: 'glab-missing', affectedPrCount: 1, host: 'gitlab.xd.com' },
      },
      auxiliaryHealth: {
        status: 'unavailable',
        kind: 'config',
        candidates: [{ ref: 'openai:gpt-5-mini', label: 'gpt-5-mini', issue: 'no_credential' }],
        since: 1_000,
      },
      scheduleRuns: [
        {
          runId: 'run-fail',
          scheduleId: 'sched-pr',
          scheduleName: 'PR 巡检',
          scheduleStatus: 'active',
          status: 'failed',
          failureKind: 'precheck',
          preRunBlocked: true,
          firedAt: 500,
          missingPlugin: { ghostId: 'cindy-github', name: 'GitHub', installed: false },
        },
      ],
    });

    expect(alerts.map((a) => [a.kind, a.severity])).toEqual([
      ['provider-auth', 'error'],
      ['github-auth', 'warning'],
      ['gitlab-auth', 'warning'],
      ['auxiliary-model', 'warning'],
      ['automation-stalled', 'warning'],
    ]);
    expect(alerts[0].action).toEqual({
      type: 'navigate',
      path: `${PROVIDERS_SETTINGS_PATH}&connect=openai`,
    });
    expect(alerts[1].action).toEqual({
      type: 'open-github-connect',
    });
    expect(alerts[2].action).toEqual({
      type: 'navigate',
      path: GITLAB_PLUGIN_SETTINGS_PATH,
    });
    expect(alerts[3].action).toEqual({
      type: 'navigate',
      path: AUXILIARY_MODEL_SETTINGS_PATH,
    });
    expect(alerts[4].descriptionKey).toBe(
      'ccAgent.sidebar.inbox.health.automationMissingPluginDesc',
    );
    expect(alerts[4].action).toEqual({
      type: 'navigate',
      path: '/cc-agent/scheduled?focus=sched-pr',
    });
  });

  it('aggregates multiple broken providers/automations and re-surfaces alerts when fingerprint changes', () => {
    const first = buildEnvironmentHealthAlerts({
      providers: [
        { id: 'anthropic', name: 'Claude', connected: true, modelDiscoveryFailure: { kind: 'unauthorized' } },
        { id: 'openai', name: 'Codex', connected: true, subscriptionAccount: { reconnectRequired: true } },
      ],
      scheduleRuns: [
        {
          runId: 'r1',
          scheduleId: 's1',
          scheduleName: '每日日报',
          scheduleStatus: 'active',
          status: 'failed',
          failureKind: 'execution',
          firedAt: 100,
        },
        {
          runId: 'r2',
          scheduleId: 's2',
          scheduleName: '发布巡检',
          scheduleStatus: 'active',
          status: 'failed',
          failureKind: 'precheck',
          firedAt: 200,
        },
      ],
    });

    expect(first).toHaveLength(2);
    expect(first[0].action).toEqual({ type: 'navigate', path: PROVIDERS_SETTINGS_PATH });
    expect(first[1].action).toEqual({ type: 'navigate', path: AUTOMATIONS_PAGE_PATH });

    const dismissed = new Set([first[0].fingerprint]);
    expect(filterDismissedEnvironmentHealthAlerts(first, dismissed).map((a) => a.kind)).toEqual([
      'automation-stalled',
    ]);

    // When a third provider fails, the fingerprint changes and the alert resurfaces.
    const next = buildEnvironmentHealthAlerts({
      providers: [
        { id: 'anthropic', name: 'Claude', connected: true, modelDiscoveryFailure: { kind: 'unauthorized' } },
        { id: 'openai', name: 'Codex', connected: true, subscriptionAccount: { reconnectRequired: true } },
        { id: 'xai', name: 'xAI', connected: true, modelDiscoveryFailure: { kind: 'unauthorized' } },
      ],
    });
    expect(filterDismissedEnvironmentHealthAlerts(next, dismissed).map((a) => a.kind)).toEqual([
      'provider-auth',
    ]);
  });
});
