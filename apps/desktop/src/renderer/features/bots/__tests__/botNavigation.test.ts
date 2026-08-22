import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { shouldDeferCanonicalBotSessionNavigation } from '../botNavigation';

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

describe('阵容是主区的一页,不是模态', () => {
  const router = readFileSync(
    resolve(__dirname, '..', '..', '..', 'router.tsx'),
    'utf8',
  );
  const home = readFileSync(resolve(__dirname, '..', 'BotsHomeView.tsx'), 'utf8');
  const sidebar = readFileSync(resolve(__dirname, '..', 'BotsSidebar.tsx'), 'utf8');

  it('挂在 /bots/roster,且静态段排在 :botId 之前', () => {
    expect(router).toContain("{ path: 'roster', element: <BotRosterView /> }");
    expect(router.indexOf("path: 'roster'")).toBeLessThan(router.indexOf("path: ':botId'"));
  });

  it('一个伙伴都没有时,主区直接就是阵容页 —— 没有中间那一层卖点卡', () => {
    expect(home).toContain('if (bots.length === 0) return <BotRosterView notice={importNotice} />;');
    // 四张功能卖点卡整体删除:它用产品内部术语介绍一个靠「挑一个合拍的」就能懂的东西。
    expect(home).not.toContain('emptyBenefits');
    // 模态入口整体下线。
    expect(home).not.toContain('AddBotDialog');
  });

  it('老的 ?add=1 深链被送去阵容页,而不是在这里再开一层浮层', () => {
    expect(home).toContain("navigate('/bots/roster', { replace: true })");
  });

  it('侧栏所有「加一个」的入口都走同一条路由', () => {
    expect(sidebar).not.toContain('?add=1');
    expect(sidebar.match(/navigate\('\/bots\/roster'\)/g)?.length).toBe(3);
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
    expect(source).toContain('window.electronAPI.localDb.bots.list()');
    expect(source).toContain(
      '<CCAgentSessionView botMentions={gate.mentions} botIdentity={gate.identity} />',
    );
  });

  it('keeps the teammate a teammate in archived transcripts, without touching the write path', () => {
    const history = readFileSync(
      resolve(__dirname, '..', 'BotHistorySessionView.tsx'),
      'utf8',
    );
    // 只读历史也带头像与伙伴 lockup:这个视图本来就已经查过 history(botId) 确认归属。
    expect(history).toContain('window.electronAPI.localDb.bots\n      .get(botId)');
    expect(history).toContain(
      '<CCAgentSessionView readOnly {...(identity ? { botIdentity: identity } : {})} />',
    );
  });

  it('delivers the parked greeting only once the durable Bot link has been verified', () => {
    // 交付点必须在 gate 通过之后:URL 不是身份,先落一条消息再校验就等于让
    // 任意 /bots/:id/session/:id 链接往别人的任务里写话。
    expect(source).toContain('deliverPendingBotWelcome');
    expect(source).toContain("if (gate.kind !== 'ready'");
  });
});
