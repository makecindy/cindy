import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  BotCanonicalSessionCreateTimeoutError,
  createBotCanonicalSessionWithRetry,
  isRetryableBotCanonicalSessionCreateError,
  shouldDeferCanonicalBotSessionNavigation,
  withBotCanonicalSessionReadTimeout,
} from '../botNavigation';

describe('shouldDeferCanonicalBotSessionNavigation', () => {
  it.each([
    ['Bot settings are open', { settingsOpen: true, addRequested: false }],
    [
      'a legacy ?add=1 deep link is still being redirected to the roster page',
      { settingsOpen: false, addRequested: true },
    ],
  ])('defers navigation while %s', (_label, input) => {
    expect(shouldDeferCanonicalBotSessionNavigation(input)).toBe(true);
  });

  it('allows canonical Session navigation once nothing is competing for the main area', () => {
    expect(
      shouldDeferCanonicalBotSessionNavigation({
        settingsOpen: false,
        addRequested: false,
      }),
    ).toBe(false);
  });
});

describe('Bot canonical Session creation retry', () => {
  it('retries a transient local DB readiness failure', async () => {
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockResolvedValueOnce('session-1');

    await expect(
      createBotCanonicalSessionWithRetry(create, {
        retryDelaysMs: [0],
        wait: async () => undefined,
      }),
    ).resolves.toBe('session-1');
    expect(create).toHaveBeenCalledTimes(2);
    expect(isRetryableBotCanonicalSessionCreateError(new Error('DbClient not ready'))).toBe(true);
  });

  it('bounds a hung IPC attempt before retrying it', async () => {
    const create = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce('session-1');

    await expect(
      createBotCanonicalSessionWithRetry(create, {
        attemptTimeoutMs: 1,
        retryDelaysMs: [0],
        wait: async () => undefined,
      }),
    ).resolves.toBe('session-1');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('surfaces a timeout after the bounded retry budget is exhausted', async () => {
    const create = vi.fn<() => Promise<string>>(() => new Promise(() => undefined));

    await expect(
      createBotCanonicalSessionWithRetry(create, {
        attemptTimeoutMs: 1,
        retryDelaysMs: [],
      }),
    ).rejects.toBeInstanceOf(BotCanonicalSessionCreateTimeoutError);
  });

  it('bounds a canonical session metadata read', async () => {
    await expect(
      withBotCanonicalSessionReadTimeout(() => new Promise(() => undefined), 1),
    ).rejects.toBeInstanceOf(BotCanonicalSessionCreateTimeoutError);
  });
});

describe('伙伴创建统一使用弹窗，并兼容旧创建链接', () => {
  const router = readFileSync(resolve(__dirname, '..', '..', '..', 'router.tsx'), 'utf8');
  const home = readFileSync(resolve(__dirname, '..', 'BotsHomeView.tsx'), 'utf8');
  const sidebar = readFileSync(resolve(__dirname, '..', 'BotsSidebar.tsx'), 'utf8');

  it('挂在 /bots/roster,且静态段排在 :botId 之前', () => {
    expect(router).toContain("{ path: 'roster', element: <BotRosterView /> }");
    expect(router.indexOf("path: 'roster'")).toBeLessThan(router.indexOf("path: ':botId'"));
  });

  it('没有伙伴时提供创建弹窗入口，不堆叠卖点卡', () => {
    expect(home).toContain("<BotCreateMenu label={t('bots.add')} />");
    // 四张功能卖点卡整体删除:它用产品内部术语介绍一个靠「挑一个合拍的」就能懂的东西。
    expect(home).not.toContain('emptyBenefits');
    expect(home).not.toContain('AddBotDialog');
  });

  it('旧 ?add=1 深链进入同一个创建入口', () => {
    expect(home).toContain("navigate('/bots/roster', { replace: true })");
  });

  it('侧栏加号与空态复用同一个创建弹窗入口', () => {
    expect(sidebar).not.toContain('?add=1');
    expect(sidebar).toContain('<BotCreateMenu compact />');
    expect(sidebar).toContain('<BotCreateMenu />');
    expect(sidebar).toContain("<BotCreateMenu label={t('bots.add')} />");
  });
});

describe('Bot task creation cannot leave navigation permanently gated', () => {
  const home = readFileSync(resolve(__dirname, '..', 'BotsHomeView.tsx'), 'utf8');

  it('releases the in-flight attempt token when the settings route takes over', () => {
    expect(home).toContain('creatingBotRef.current?.token === attemptToken');
    expect(home).toContain('creatingBotRef.current = null');
  });

  it('retries canonical creation instead of renewing a missing Session', () => {
    expect(home).toContain('retryCanonicalSessionCreation(selectedBot)');
    expect(home).not.toContain('onClick={() => void renewBotSession(selectedBot)}');
  });

  it('does not gate canonical navigation on a separate hydration flag', () => {
    expect(home).not.toContain('renewCheckedBotId !== selectedBot.id');
  });
});

describe('Bot task route recovery', () => {
  const source = readFileSync(resolve(__dirname, '..', 'BotSessionView.tsx'), 'utf8');

  it('keeps load failures visible and retryable instead of silently redirecting', () => {
    expect(source).not.toContain('<Navigate');
    expect(source).toContain("kind: 'error'");
    expect(source).toContain('setReloadVersion');
    expect(source).toContain('bots.sessionLoadFailedTitle');
  });

  it('passes the live Bot roster and the teammate identity into the shared task composer', () => {
    expect(source).toContain('window.electronAPI.localDb.bots.list(');
    expect(source).toContain('lastReadAtByBotId: { [botId]: lastReadAt }');
    expect(source).toContain('botMentions={gate.mentions}');
    expect(source).toContain('botIdentity={gate.identity}');
    expect(source).toContain('botUnreadBoundaryAt={gate.unreadBoundaryAt}');
  });

  it.each(['\n', '\r\n'])('keeps the teammate a teammate in archived transcripts with line ending %j, without touching the write path', (lineEnding) => {
    const history = readFileSync(resolve(__dirname, '..', 'BotHistorySessionView.tsx'), 'utf8')
      .replace(/\r?\n/g, lineEnding);
    // 只读历史也带头像与伙伴 lockup:这个视图本来就已经查过 history(botId) 确认归属。
    expect(history).toMatch(/window\.electronAPI\.localDb\.bots\s*\.get\(botId\)/);
    expect(history).toContain(
      '<CCAgentSessionView readOnly {...(identity ? { botIdentity: identity } : {})} />',
    );
  });

  it('keeps welcome delivery out of the renderer navigation projection', () => {
    // 欢迎语由 main 在创建伙伴和持久任务关系的同一边界内落库。URL 只负责
    // 校验归属与展示，不能因为打开页面再产生一次消息写入。
    expect(source).not.toContain('deliverPendingBotWelcome');
    expect(source).not.toContain('messageService.create');
    expect(source).toContain("if (gate.kind !== 'ready'");
  });
});
